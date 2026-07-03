package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const sessionCookieName = "kikoto_session"

type contextKey string

const currentUserKey contextKey = "currentUser"

type currentUser struct {
	ID          int64    `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"displayName"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	DevMode     bool     `json:"devMode"`
}

func (s *Server) BootstrapRoot(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	username := strings.TrimSpace(s.cfg.RootUsername)
	if username == "" {
		username = "root"
	}
	displayName := username
	hash, err := hashPassword(s.cfg.RootPassword)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_account (username, display_name, role, enabled)
		VALUES (?, ?, 'super_admin', 1)
		ON CONFLICT(username) DO UPDATE SET
			role = 'super_admin',
			enabled = 1,
			updated_at = CURRENT_TIMESTAMP
	`, username, displayName); err != nil {
		return err
	}

	var userID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM user_account WHERE username = ?", username).Scan(&userID); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_password_credential (user_id, password_hash)
		VALUES (?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			password_hash = excluded.password_hash,
			updated_at = CURRENT_TIMESTAMP
	`, userID, hash); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO favorite_list (user_id, name, sort_order)
		VALUES (?, 'Favorites', 0)
	`, userID); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *Server) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.currentUserFromRequest(r.Context(), r)
		if err != nil {
			next.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), currentUserKey, user)))
	})
}

func (s *Server) currentUserFromRequest(ctx context.Context, r *http.Request) (currentUser, error) {
	if s.cfg.DevMode {
		user, err := s.loadUserByUsername(ctx, s.cfg.RootUsername)
		if err != nil {
			return currentUser{}, err
		}
		user.DevMode = true
		return user, nil
	}

	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return currentUser{}, sql.ErrNoRows
	}

	var userID int64
	var expiresAt string
	if err := s.db.QueryRowContext(ctx, `
		SELECT user_id, expires_at
		FROM user_session
		WHERE id = ?
	`, cookie.Value).Scan(&userID, &expiresAt); err != nil {
		return currentUser{}, err
	}

	parsedExpiresAt, err := time.Parse("2006-01-02 15:04:05", expiresAt)
	if err != nil {
		parsedExpiresAt, err = time.Parse(time.RFC3339, expiresAt)
	}
	if err == nil && time.Now().After(parsedExpiresAt) {
		_, _ = s.db.ExecContext(ctx, "DELETE FROM user_session WHERE id = ?", cookie.Value)
		return currentUser{}, sql.ErrNoRows
	}

	return s.loadUserByID(ctx, userID)
}

func (s *Server) loadUserByUsername(ctx context.Context, username string) (currentUser, error) {
	var user currentUser
	if err := s.db.QueryRowContext(ctx, `
		SELECT id, username, display_name, role
		FROM user_account
		WHERE username = ? AND enabled = 1
	`, username).Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role); err != nil {
		return currentUser{}, err
	}
	user.Permissions = permissionsForRole(user.Role)
	return user, nil
}

func (s *Server) loadUserByID(ctx context.Context, id int64) (currentUser, error) {
	var user currentUser
	if err := s.db.QueryRowContext(ctx, `
		SELECT id, username, display_name, role
		FROM user_account
		WHERE id = ? AND enabled = 1
	`, id).Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role); err != nil {
		return currentUser{}, err
	}
	user.Permissions = permissionsForRole(user.Role)
	return user, nil
}

func permissionsForRole(role string) []string {
	base := []string{"library:read", "playback:use", "favorites:write", "tags:write"}
	switch role {
	case "super_admin":
		return append(base, "sources:write", "workflows:run", "metadata:sync", "users:manage", "system:admin")
	case "admin":
		return append(base, "sources:write", "workflows:run", "metadata:sync")
	default:
		return base
	}
}

func userFromContext(ctx context.Context) (currentUser, bool) {
	user, ok := ctx.Value(currentUserKey).(currentUser)
	return user, ok
}

func (s *Server) requirePermission(w http.ResponseWriter, r *http.Request, permission string) (currentUser, bool) {
	user, ok := userFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
		return currentUser{}, false
	}
	for _, item := range user.Permissions {
		if item == permission || item == "system:admin" {
			return user, true
		}
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
	return currentUser{}, false
}

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	sum := passwordHashSum(password, salt)
	return fmt.Sprintf("sha256:%s:%s", hex.EncodeToString(salt), hex.EncodeToString(sum)), nil
}

func verifyPassword(password string, encoded string) bool {
	parts := strings.Split(encoded, ":")
	if len(parts) != 3 || parts[0] != "sha256" {
		return false
	}
	salt, err := hex.DecodeString(parts[1])
	if err != nil {
		return false
	}
	expected, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	actual := passwordHashSum(password, salt)
	return subtleEqual(actual, expected)
}

func passwordHashSum(password string, salt []byte) []byte {
	sum := sha256.Sum256(append(salt, []byte(password)...))
	value := sum[:]
	for i := 0; i < 120_000; i++ {
		next := sha256.Sum256(append(value, []byte(password)...))
		value = next[:]
	}
	return value
}

func subtleEqual(a []byte, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := range a {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

func newSessionID() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func parseLoginRequest(r *http.Request) (string, string, error) {
	var payload struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return "", "", err
	}
	username := strings.TrimSpace(payload.Username)
	if username == "" || payload.Password == "" {
		return "", "", errors.New("username and password are required")
	}
	return username, payload.Password, nil
}
