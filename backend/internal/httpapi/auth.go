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
const mobileAuthHeader = "X-Kikoto-Mobile"

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
			if errors.Is(err, sql.ErrNoRows) {
				next.ServeHTTP(w, r)
				return
			}
			writeError(w, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), currentUserKey, user)))
	})
}

func (s *Server) currentUserFromRequest(ctx context.Context, r *http.Request) (currentUser, error) {
	if s.cfg.IsDevelopment() || s.cfg.IsDemo() {
		user, err := s.accountStore.LoadByUsername(ctx, s.cfg.RootUsername)
		if err != nil {
			return currentUser{}, err
		}
		user.DevMode = s.cfg.IsDevelopment()
		user.DemoMode = s.cfg.IsDemo()
		return s.withPasswordManagement(user), nil
	}
	if sessionID := bearerSessionID(r); sessionID != "" {
		user, err := s.accountStore.UserForSession(ctx, sessionID, time.Now())
		return s.withPasswordManagement(user), err
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return currentUser{}, sql.ErrNoRows
	}
	user, err := s.accountStore.UserForSession(ctx, cookie.Value, time.Now())
	return s.withPasswordManagement(user), err
}

func (s *Server) withPasswordManagement(user currentUser) currentUser {
	user.PasswordManagedBy = "account"
	rootUsername := strings.TrimSpace(s.cfg.RootUsername)
	if rootUsername == "" {
		rootUsername = "root"
	}
	if user.Username == rootUsername {
		user.PasswordManagedBy = "environment"
	}
	return user
}

func bearerSessionID(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if header == "" {
		return ""
	}
	scheme, value, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(value)
}

func currentSessionID(r *http.Request) string {
	if sessionID := bearerSessionID(r); sessionID != "" {
		return sessionID
	}
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}

func isMobileAuthRequest(r *http.Request) bool {
	return r.Header.Get(mobileAuthHeader) == "1"
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

func (s *Server) updateCurrentUser(w http.ResponseWriter, r *http.Request) {
	actor, ok := userFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
		return
	}
	var payload struct {
		DisplayName     *string `json:"displayName"`
		CurrentPassword string  `json:"currentPassword"`
		NewPassword     string  `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	displayName := actor.DisplayName
	if payload.DisplayName != nil {
		displayName = strings.TrimSpace(*payload.DisplayName)
		if displayName == "" {
			displayName = actor.Username
		}
	}
	if payload.NewPassword == "" && payload.CurrentPassword != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "new password is required"})
		return
	}
	if payload.NewPassword != "" {
		if actor.PasswordManagedBy == "environment" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "root password is managed by KIKOTO_ROOT_PASSWORD"})
			return
		}
		if payload.CurrentPassword == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "current password is required"})
			return
		}
		if len(payload.NewPassword) < 8 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be at least 8 characters"})
			return
		}
	}
	updated, err := s.accountStore.UpdateOwnAccount(r.Context(), account.UpdateOwnAccountInput{
		ID: actor.ID, DisplayName: displayName, CurrentPassword: payload.CurrentPassword,
		NewPassword: payload.NewPassword, CurrentSessionID: currentSessionID(r),
	})
	if errors.Is(err, account.ErrInvalidCurrentPassword) || errors.Is(err, account.ErrPasswordUnchanged) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	updated.DevMode = actor.DevMode
	updated.DemoMode = actor.DemoMode
	updated = s.withPasswordManagement(updated)
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": updated})
}
