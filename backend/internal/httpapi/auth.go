package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
)

const sessionCookieName = "kikoto_session"

type contextKey string

const currentUserKey contextKey = "currentUser"

type currentUser = account.User

func (s *Server) BootstrapRoot(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	return s.accountStore.BootstrapRoot(ctx, s.cfg.RootUsername, s.cfg.RootPassword)
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
		user, err := s.accountStore.LoadByUsername(ctx, s.cfg.RootUsername)
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
	return s.accountStore.UserForSession(ctx, cookie.Value, time.Now())
}

func userFromContext(ctx context.Context) (currentUser, bool) {
	user, ok := ctx.Value(currentUserKey).(currentUser)
	return user, ok
}

func optionalUserID(ctx context.Context) int64 {
	user, ok := userFromContext(ctx)
	if !ok {
		return 0
	}
	return user.ID
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
	return account.HashPassword(password)
}

func verifyPassword(password string, encoded string) bool {
	return account.VerifyPassword(password, encoded)
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
