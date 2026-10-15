package llm

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
)

var ErrNotFound = errors.New("LLM provider not found")
var ErrInvalid = errors.New("invalid LLM configuration")

type Store struct {
	db *sql.DB
	mu sync.Mutex
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

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
	if json.Unmarshal([]byte(raw), &providers) != nil || len(providers) > 16 {
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

// Mutate holds the list lock through its database write. Omitted API keys stay
// on the same endpoint only; changing an endpoint requires entering its key.
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
	} else {
		if id == "" {
			if len(providers) >= 16 {
				return Provider{}, errors.New("at most 16 LLM providers are allowed")
			}
			var b [16]byte
			if _, err := rand.Read(b[:]); err != nil {
				return Provider{}, err
			}
			input.ID = "llm-" + hex.EncodeToString(b[:])
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
	}
	err = s.write(ctx, SettingKey, providers)
	return input, err
}

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
			return Provider{}, errors.New("LLM configuration changed; fetch models again")
		}
		p.Models = models
		providers[i] = p
		return p, s.write(ctx, SettingKey, providers)
	}
	return Provider{}, ErrNotFound
}

func (s *Store) Policy(ctx context.Context) (Policy, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key=?", PolicyKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultPolicy(), nil
	}
	if err != nil {
		return Policy{}, err
	}
	var policy Policy
	if json.Unmarshal([]byte(raw), &policy) != nil {
		return Policy{}, ErrInvalid
	}
	return policy.Validate()
}

func (s *Store) SavePolicy(ctx context.Context, policy Policy) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	normalized, err := policy.Validate()
	if err != nil {
		return err
	}
	current, err := s.Policy(ctx)
	if err != nil {
		return err
	}
	normalized.Revision = current.Revision + 1
	return s.write(ctx, PolicyKey, normalized)
}

func (s *Store) write(ctx context.Context, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO app_setting(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=CURRENT_TIMESTAMP`, key, string(encoded))
	return err
}
