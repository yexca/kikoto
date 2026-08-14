package accesspolicy

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
)

const anonymousAccessSettingKey = "anonymous_access_enabled"

type Policy struct {
	AnonymousAccessEnabled bool `json:"anonymousAccessEnabled"`
}

type Store struct {
	db                     *sql.DB
	mu                     sync.Mutex
	anonymousAccessEnabled atomic.Bool
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Load(ctx context.Context) error {
	if s.db == nil {
		return errors.New("access policy database is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	enabled, err := loadAnonymousAccess(ctx, s.db)
	if err != nil {
		return err
	}
	s.anonymousAccessEnabled.Store(enabled)
	return nil
}

func (s *Store) Current() Policy {
	return Policy{AnonymousAccessEnabled: s.anonymousAccessEnabled.Load()}
}

func (s *Store) Update(ctx context.Context, actorUserID int64, enabled bool) (Policy, error) {
	if s.db == nil {
		return Policy{}, errors.New("access policy database is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Policy{}, err
	}
	defer func() { _ = tx.Rollback() }()

	previous, err := loadAnonymousAccess(ctx, tx)
	if err != nil {
		return Policy{}, err
	}
	if previous != enabled {
		encoded, err := json.Marshal(enabled)
		if err != nil {
			return Policy{}, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO app_setting (key, value_json)
			VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET
				value_json = excluded.value_json,
				updated_at = CURRENT_TIMESTAMP
		`, anonymousAccessSettingKey, string(encoded)); err != nil {
			return Policy{}, err
		}
		detail, err := json.Marshal(map[string]bool{"previous": previous, "enabled": enabled})
		if err != nil {
			return Policy{}, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
			VALUES (?, 'access_policy.anonymous_access_update', 'access_policy', 'anonymous_access', ?)
		`, actorUserID, string(detail)); err != nil {
			return Policy{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Policy{}, err
	}
	s.anonymousAccessEnabled.Store(enabled)
	return Policy{AnonymousAccessEnabled: enabled}, nil
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadAnonymousAccess(ctx context.Context, queryer queryRower) (bool, error) {
	var raw string
	err := queryer.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", anonymousAccessSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var enabled bool
	if err := json.Unmarshal([]byte(raw), &enabled); err != nil {
		return false, fmt.Errorf("decode anonymous access policy: %w", err)
	}
	return enabled, nil
}
