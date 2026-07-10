package account

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"strings"
	"time"
)

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

type User struct {
	ID          int64    `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"displayName"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	DevMode     bool     `json:"devMode"`
}

type Session struct {
	ID        string
	ExpiresAt time.Time
	User      User
}

func (s *Store) BootstrapRoot(ctx context.Context, username string, password string) error {
	username = strings.TrimSpace(username)
	if username == "" {
		username = "root"
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_account (username, display_name, role, enabled)
		VALUES (?, ?, 'super_admin', 1)
		ON CONFLICT(username) DO UPDATE SET role = 'super_admin', enabled = 1, updated_at = CURRENT_TIMESTAMP
	`, username, username); err != nil {
		return err
	}
	var userID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM user_account WHERE username = ?", username).Scan(&userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_password_credential (user_id, password_hash) VALUES (?, ?)
		ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = CURRENT_TIMESTAMP
	`, userID, hash); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO favorite_list (user_id, name, sort_order) VALUES (?, 'Favorites', 0)", userID); err != nil {
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
	err := s.db.QueryRowContext(ctx, `SELECT id, username, display_name, role FROM user_account WHERE `+predicate+` AND enabled = 1`, value).
		Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role)
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
		_, _ = s.db.ExecContext(ctx, "DELETE FROM user_session WHERE id = ?", sessionID)
		return User{}, sql.ErrNoRows
	}
	return s.LoadByID(ctx, userID)
}

func (s *Store) Authenticate(ctx context.Context, username string, password string, now time.Time) (Session, error) {
	var userID int64
	var passwordHash string
	if err := s.db.QueryRowContext(ctx, `
		SELECT account.id, credential.password_hash
		FROM user_account AS account
		INNER JOIN user_password_credential AS credential ON credential.user_id = account.id
		WHERE account.username = ? AND account.enabled = 1
	`, username).Scan(&userID, &passwordHash); err != nil {
		return Session{}, err
	}
	if !VerifyPassword(password, passwordHash) {
		return Session{}, sql.ErrNoRows
	}
	sessionID, err := newSessionID()
	if err != nil {
		return Session{}, err
	}
	expiresAt := now.Add(30 * 24 * time.Hour).UTC()
	if _, err := s.db.ExecContext(ctx, "INSERT INTO user_session (id, user_id, expires_at) VALUES (?, ?, ?)", sessionID, userID, expiresAt.Format("2006-01-02 15:04:05")); err != nil {
		return Session{}, err
	}
	user, err := s.LoadByID(ctx, userID)
	if err != nil {
		return Session{}, err
	}
	return Session{ID: sessionID, ExpiresAt: expiresAt, User: user}, nil
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

func newSessionID() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}
