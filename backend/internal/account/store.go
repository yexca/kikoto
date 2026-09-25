package account

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"log/slog"
	"strings"
	"time"
)

type Store struct {
	db *sql.DB
}

const DemoUsername = "__demo__"

var ErrDemoAccountConflict = errors.New("reserved demo account username is already in use")

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

type User struct {
	ID          int64    `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"displayName"`
	UILocale    string   `json:"uiLocale"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	DevMode     bool     `json:"devMode"`
	DemoMode    bool     `json:"demoMode"`
	// PasswordManagedBy is "environment" for the environment-managed root
	// account and "account" otherwise.
	PasswordManagedBy string `json:"passwordManagedBy"`
}

const (
	UILocaleAuto     = "auto"
	UILocaleEnglish  = "en"
	UILocaleHans     = "zh-Hans"
	UILocaleHant     = "zh-Hant"
	UILocaleJapanese = "ja"
	UILocaleKorean   = "ko"
)

func NormalizeUILocale(value string) (string, bool) {
	switch strings.TrimSpace(value) {
	case UILocaleAuto:
		return UILocaleAuto, true
	case UILocaleEnglish:
		return UILocaleEnglish, true
	case UILocaleHans:
		return UILocaleHans, true
	case UILocaleHant:
		return UILocaleHant, true
	case UILocaleJapanese:
		return UILocaleJapanese, true
	case UILocaleKorean:
		return UILocaleKorean, true
	default:
		return "", false
	}
}

type Session struct {
	ID        string
	ExpiresAt time.Time
	User      User
}

func (s *Store) BootstrapDemo(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var userID int64
	err = tx.QueryRowContext(ctx, "SELECT id FROM user_account WHERE username = ?", DemoUsername).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		result, insertErr := tx.ExecContext(ctx, `
			INSERT INTO user_account (username, display_name, role, enabled)
			VALUES (?, 'Demo', 'user', 1)
		`, DemoUsername)
		if insertErr != nil {
			return insertErr
		}
		userID, err = result.LastInsertId()
		if err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else {
		var credentialCount int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM user_password_credential WHERE user_id = ?", userID).Scan(&credentialCount); err != nil {
			return err
		}
		if credentialCount != 0 {
			return ErrDemoAccountConflict
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE user_account
			SET display_name = 'Demo', role = 'user', enabled = 1, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, userID); err != nil {
			return err
		}
	}

	if _, err := tx.ExecContext(ctx, "DELETE FROM user_session WHERE user_id = ?", userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO favorite_list (user_id, name, sort_order, kind) VALUES (?, '', -1, 'marked')", userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) LoadByUsername(ctx context.Context, username string) (User, error) {
	return s.load(ctx, "username = ?", username)
}

func (s *Store) LoadByID(ctx context.Context, id int64) (User, error) {
	return s.load(ctx, "id = ?", id)
}

func (s *Store) load(ctx context.Context, predicate string, value any) (User, error) {
	var user User
	err := s.db.QueryRowContext(ctx, `SELECT id, username, display_name, ui_locale, role FROM user_account WHERE `+predicate+` AND enabled = 1`, value).
		Scan(&user.ID, &user.Username, &user.DisplayName, &user.UILocale, &user.Role)
	if err != nil {
		return User{}, err
	}
	user.Permissions = PermissionsForRole(user.Role)
	return user, nil
}

func (s *Store) UserForSession(ctx context.Context, sessionID string, now time.Time) (User, error) {
	var userID int64
	var expiresAt string
	if err := s.db.QueryRowContext(ctx, "SELECT user_id, expires_at FROM user_session WHERE id = ?", sessionID).Scan(&userID, &expiresAt); err != nil {
		return User{}, err
	}
	parsed, err := time.Parse("2006-01-02 15:04:05", expiresAt)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, expiresAt)
	}
	if err == nil && now.After(parsed) {
		if _, err := s.db.ExecContext(ctx, "DELETE FROM user_session WHERE id = ?", sessionID); err != nil && !errors.Is(err, context.Canceled) {
			slog.Warn("expired session cleanup failed", "user_id", userID, "error", err)
		}
		return User{}, sql.ErrNoRows
	}
	return s.LoadByID(ctx, userID)
}

// Authenticate returns sql.ErrNoRows for any rejected credential. An unknown,
// disabled, or passwordless username still performs one Argon2id derivation so
// response timing does not reveal which usernames exist. It returns
// ErrPasswordVerificationBusy when no derivation slot frees up in time.
func (s *Store) Authenticate(ctx context.Context, username string, password string, now time.Time) (Session, error) {
	var userID int64
	var passwordHash string
	err := s.db.QueryRowContext(ctx, `
		SELECT account.id, credential.password_hash
		FROM user_account AS account
		INNER JOIN user_password_credential AS credential ON credential.user_id = account.id
		WHERE account.username = ? AND account.enabled = 1
	`, username).Scan(&userID, &passwordHash)
	knownUser := err == nil
	if errors.Is(err, sql.ErrNoRows) {
		passwordHash, err = dummyPasswordHash()
	}
	if err != nil {
		return Session{}, err
	}
	waitCtx, cancel := context.WithTimeout(ctx, argon2idSlotWait)
	matched, err := verifyPasswordContext(waitCtx, password, passwordHash)
	cancel()
	if err != nil {
		if ctx.Err() == nil && errors.Is(err, context.DeadlineExceeded) {
			return Session{}, ErrPasswordVerificationBusy
		}
		return Session{}, err
	}
	if !knownUser || !matched {
		return Session{}, sql.ErrNoRows
	}
	if passwordNeedsRehash(passwordHash) {
		s.upgradePasswordHash(ctx, userID, password, passwordHash)
	}
	return s.CreateSession(ctx, userID, now)
}

// CreateSession signs in an enabled account whose credential the caller has
// already established.
func (s *Store) CreateSession(ctx context.Context, userID int64, now time.Time) (Session, error) {
	user, err := s.LoadByID(ctx, userID)
	if err != nil {
		return Session{}, err
	}
	sessionID, err := newSessionID()
	if err != nil {
		return Session{}, err
	}
	expiresAt := now.Add(30 * 24 * time.Hour).UTC()
	if _, err := s.db.ExecContext(ctx, "INSERT INTO user_session (id, user_id, expires_at) VALUES (?, ?, ?)", sessionID, userID, expiresAt.Format("2006-01-02 15:04:05")); err != nil {
		return Session{}, err
	}
	return Session{ID: sessionID, ExpiresAt: expiresAt, User: user}, nil
}

// upgradePasswordHash rehashes a verified legacy hash with the current
// parameters. It is best effort: on failure the legacy hash stays valid and the
// upgrade is retried at the next sign-in. The compare-and-swap keeps a
// concurrent password change from being overwritten.
func (s *Store) upgradePasswordHash(ctx context.Context, userID int64, password string, legacyHash string) {
	waitCtx, cancel := context.WithTimeout(ctx, argon2idSlotWait)
	upgraded, err := hashPasswordContext(waitCtx, password)
	cancel()
	if err == nil {
		_, err = s.db.ExecContext(ctx, `UPDATE user_password_credential SET password_hash = ? WHERE user_id = ? AND password_hash = ?`, upgraded, userID, legacyHash)
	}
	if err != nil {
		slog.Warn("password hash upgrade failed", "user_id", userID, "error", err)
	}
}

func (s *Store) DeleteSession(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM user_session WHERE id = ?", sessionID)
	return err
}

func PermissionsForRole(role string) []string {
	base := []string{"library:read", "playback:use", "favorites:write", "tags:write"}
	switch role {
	case "super_admin":
		return append(base, "sources:write", "workflows:run", "metadata:sync", "downloads:manage", "users:manage", "system:admin")
	case "admin":
		return append(base, "sources:write", "workflows:run", "metadata:sync", "downloads:manage", "users:manage")
	default:
		return base
	}
}

func DemoPermissions() []string {
	return []string{"library:read", "playback:use"}
}

func newSessionID() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
