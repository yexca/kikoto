package asr

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

var ErrNotFound = errors.New("speech recognition service not found")
var ErrInvalid = errors.New("invalid speech recognition configuration")

// Store keeps the administrator-configured services in one app setting.
type Store struct {
	db *sqlutil.DB
	mu sync.Mutex
}

func NewStore(db *sqlutil.DB) *Store { return &Store{db: db} }

func (s *Store) List(ctx context.Context) ([]Provider, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key=?", SettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return []Provider{}, nil
	}
	if err != nil {
		return nil, err
	}
	var providers []Provider
	if json.Unmarshal([]byte(raw), &providers) != nil || len(providers) > MaxProviders {
		return nil, ErrInvalid
	}
	for i, p := range providers {
		normalized, err := Normalize(p)
		if err != nil {
			return nil, ErrInvalid
		}
		providers[i] = normalized
	}
	return providers, nil
}

func (s *Store) Get(ctx context.Context, id string) (Provider, error) {
	providers, err := s.List(ctx)
	if err != nil {
		return Provider{}, err
	}
	for _, p := range providers {
		if p.ID == id {
			return p, nil
		}
	}
	return Provider{}, ErrNotFound
}

// Mutate holds the list lock through its database write. An omitted API key
// stays with the same connection only; changing where the service is reached
// drops the key and the discovered models.
func (s *Store) Mutate(ctx context.Context, id string, input Provider, key *string, remove bool) (Provider, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	providers, err := s.List(ctx)
	if err != nil {
		return Provider{}, err
	}
	index := -1
	for i, p := range providers {
		if p.ID == id && id != "" {
			index = i
			break
		}
	}
	if id != "" && index < 0 {
		return Provider{}, ErrNotFound
	}
	if remove {
		providers = append(providers[:index], providers[index+1:]...)
		return Provider{}, s.write(ctx, providers)
	}
	if id == "" {
		if len(providers) >= MaxProviders {
			return Provider{}, errors.New("too many speech recognition services")
		}
		var b [16]byte
		if _, err := rand.Read(b[:]); err != nil {
			return Provider{}, err
		}
		input.ID = "asr-" + hex.EncodeToString(b[:])
	} else {
		input.ID = id
	}
	input, err = Normalize(input)
	if err != nil {
		return Provider{}, err
	}
	input.APIKey = ""
	input.Models = []Model{}
	if key != nil {
		input.APIKey = *key
	} else if index >= 0 && providers[index].SameConnection(input) {
		input.APIKey = providers[index].APIKey
	}
	input, err = Normalize(input)
	if err != nil {
		return Provider{}, err
	}
	if index >= 0 {
		input.Revision = providers[index].Revision + 1
		if providers[index].SameConnection(input) && providers[index].APIKey == input.APIKey {
			input.Models = providers[index].Models
		}
		providers[index] = input
	} else {
		input.Revision = 1
		providers = append(providers, input)
	}
	return input, s.write(ctx, providers)
}

// Models stores discovered models when the connection they were read from is
// still the configured one.
func (s *Store) Models(ctx context.Context, expected Provider, models []Model) (Provider, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	providers, err := s.List(ctx)
	if err != nil {
		return Provider{}, err
	}
	for i, p := range providers {
		if p.ID != expected.ID {
			continue
		}
		if !p.SameConnection(expected) || p.APIKey != expected.APIKey {
			return Provider{}, errors.New("speech recognition configuration changed; fetch models again")
		}
		p.Models = models
		providers[i] = p
		return p, s.write(ctx, providers)
	}
	return Provider{}, ErrNotFound
}

func (s *Store) write(ctx context.Context, providers []Provider) error {
	encoded, err := json.Marshal(providers)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO app_setting(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`, SettingKey, string(encoded))
	return err
}
