package accesspolicy

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

const (
	anonymousAccessSettingKey         = "anonymous_access_enabled"
	anonymousRemoteBrowsingSettingKey = "anonymous_remote_browsing_enabled"
)

type Policy struct {
	AnonymousAccessEnabled bool `json:"anonymousAccessEnabled"`
	// AnonymousRemoteBrowsingEnabled lets visitors without an account, while
	// anonymous access is on, also browse and play remote sources. It is off
	// by default because those reads can reveal the remote configuration.
	AnonymousRemoteBrowsingEnabled bool `json:"anonymousRemoteBrowsingEnabled"`
}

type Store struct {
	db                             *sqlutil.DB
	mu                             sync.Mutex
	anonymousAccessEnabled         atomic.Bool
	anonymousRemoteBrowsingEnabled atomic.Bool
}

func NewStore(db *sqlutil.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Load(ctx context.Context) error {
	if s.db == nil {
		return errors.New("access policy database is not configured")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	enabled, err := loadPolicyFlag(ctx, s.db, anonymousAccessSettingKey)
	if err != nil {
		return err
	}
	remote, err := loadPolicyFlag(ctx, s.db, anonymousRemoteBrowsingSettingKey)
	if err != nil {
		return err
	}
	s.anonymousAccessEnabled.Store(enabled)
	s.anonymousRemoteBrowsingEnabled.Store(remote)
	return nil
}

func (s *Store) Current() Policy {
	return Policy{
		AnonymousAccessEnabled:         s.anonymousAccessEnabled.Load(),
		AnonymousRemoteBrowsingEnabled: s.anonymousRemoteBrowsingEnabled.Load(),
	}
}

// Update turns anonymous access on or off.
func (s *Store) Update(ctx context.Context, actorUserID int64, enabled bool) (Policy, error) {
	return s.UpdatePolicy(ctx, actorUserID, PolicyUpdate{AnonymousAccessEnabled: &enabled})
}

// UpdateRemoteBrowsing turns anonymous remote-source browsing on or off.
func (s *Store) UpdateRemoteBrowsing(ctx context.Context, actorUserID int64, enabled bool) (Policy, error) {
	return s.UpdatePolicy(ctx, actorUserID, PolicyUpdate{AnonymousRemoteBrowsingEnabled: &enabled})
}

// PolicyUpdate names the settings a change sets; a nil field keeps its value.
// Turning anonymous access off also turns anonymous remote browsing off, so
// turning anonymous access on again never brings remote browsing back with it.
type PolicyUpdate struct {
	AnonymousAccessEnabled         *bool
	AnonymousRemoteBrowsingEnabled *bool
}

type policyFlag struct {
	value  *bool
	key    string
	action string
	target string
	cached *atomic.Bool
}

// UpdatePolicy applies every named setting and its audit entry in one
// transaction, so a change that sets several either applies all or none.
func (s *Store) UpdatePolicy(ctx context.Context, actorUserID int64, update PolicyUpdate) (Policy, error) {
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
	if update.AnonymousAccessEnabled != nil && !*update.AnonymousAccessEnabled && update.AnonymousRemoteBrowsingEnabled == nil {
		off := false
		update.AnonymousRemoteBrowsingEnabled = &off
	}
	flags := []policyFlag{
		{update.AnonymousAccessEnabled, anonymousAccessSettingKey, "access_policy.anonymous_access_update", "anonymous_access", &s.anonymousAccessEnabled},
		{update.AnonymousRemoteBrowsingEnabled, anonymousRemoteBrowsingSettingKey, "access_policy.anonymous_remote_browsing_update", "anonymous_remote_browsing", &s.anonymousRemoteBrowsingEnabled},
	}
	for _, flag := range flags {
		if flag.value == nil {
			continue
		}
		if err := writePolicyFlagTx(ctx, tx, actorUserID, *flag.value, flag.key, flag.action, flag.target); err != nil {
			return Policy{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Policy{}, err
	}
	for _, flag := range flags {
		if flag.value != nil {
			flag.cached.Store(*flag.value)
		}
	}
	return s.Current(), nil
}

func writePolicyFlagTx(ctx context.Context, tx *sql.Tx, actorUserID int64, enabled bool, key, action, target string) error {
	previous, err := loadPolicyFlag(ctx, tx, key)
	if err != nil || previous == enabled {
		return err
	}
	encoded, err := json.Marshal(enabled)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO app_setting (key, value_json)
		VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = CURRENT_TIMESTAMP
	`, key, string(encoded)); err != nil {
		return err
	}
	detail, err := json.Marshal(map[string]bool{"previous": previous, "enabled": enabled})
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
		VALUES (?, ?, 'access_policy', ?, ?)
	`, actorUserID, action, target, string(detail))
	return err
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadPolicyFlag(ctx context.Context, queryer queryRower, key string) (bool, error) {
	var raw string
	err := queryer.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var enabled bool
	if err := json.Unmarshal([]byte(raw), &enabled); err != nil {
		return false, fmt.Errorf("decode %s policy: %w", strings.ReplaceAll(strings.TrimSuffix(key, "_enabled"), "_", " "), err)
	}
	return enabled, nil
}
