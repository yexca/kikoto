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

func (s *Server) BootstrapDemo(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	return s.accountStore.BootstrapDemo(ctx)
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
	if s.cfg.IsDemo() {
		user, err := s.accountStore.LoadByUsername(ctx, account.DemoUsername)
		if err != nil {
			return currentUser{}, err
		}
		user.Permissions = account.DemoPermissions()
		user.DemoMode = true
		return s.withPasswordManagement(user), nil
	}
	if s.cfg.IsDevelopment() {
		user, err := s.accountStore.LoadByUsername(ctx, s.cfg.DevelopmentUsername())
		if err != nil {
			return currentUser{}, err
		}
		user.DevMode = true
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
	user.PasswordManagedBy = s.credentialManager(user.Username)
	return user
}

func (s *Server) credentialManager(username string) string {
	if s.isEnvironmentManagedUsername(username) {
		return "environment"
	}
	return "account"
}

// isEnvironmentManagedUsername reports whether username is the root account of
// environment mode, configured through KIKOTO_ROOT_USERNAME and
// KIKOTO_ROOT_PASSWORD. Setup mode has no environment-managed account.
func (s *Server) isEnvironmentManagedUsername(username string) bool {
	managed := s.cfg.EnvironmentManagedUsername()
	return managed != "" && username == managed
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
	if s.cfg.IsDemo() && (r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions) {
		return user, true
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
		UILocale        *string `json:"uiLocale"`
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
		if err := account.ValidateNewPassword(payload.NewPassword); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	updated, err := s.accountStore.UpdateOwnAccount(r.Context(), account.UpdateOwnAccountInput{
		ID: actor.ID, DisplayName: displayName, UILocale: payload.UILocale, CurrentPassword: payload.CurrentPassword,
		NewPassword: payload.NewPassword, CurrentSessionID: currentSessionID(r),
	})
	if errors.Is(err, account.ErrInvalidUILocale) {
		writeAPIError(w, http.StatusBadRequest, "invalid_ui_locale", "invalid interface language", false)
		return
	}
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

func (s *Server) getCurrentUser(w http.ResponseWriter, r *http.Request) {
	user, ok := userFromContext(r.Context())
	if !ok {
		response := map[string]any{"authenticated": false}
		if s.initialSetupRequired(r.Context()) {
			response["setupRequired"] = true
		}
		writeJSON(w, http.StatusOK, response)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": user})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	username, password, err := parseLoginRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	attempt, retryAfter, allowed := s.loginThrottle.Begin(loginThrottleKeys(s.loginClientKey(r), username))
	if !allowed {
		writeLoginRateLimited(w, retryAfter)
		return
	}
	session, err := s.accountStore.Authenticate(r.Context(), username, password, time.Now())
	if errors.Is(err, sql.ErrNoRows) {
		attempt.Fail()
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}
	if err != nil {
		attempt.Cancel()
		if errors.Is(err, account.ErrPasswordVerificationBusy) {
			writeLoginBusy(w)
			return
		}
		writeError(w, err)
		return
	}
	attempt.Succeed()

	s.setSessionCookie(r, w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    session.ID,
		Path:     "/",
		Expires:  session.ExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	payload := map[string]any{"authenticated": true, "user": s.withPasswordManagement(session.User)}
	if isMobileAuthRequest(r) {
		payload["sessionToken"] = session.ID
	}
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if sessionID := bearerSessionID(r); sessionID != "" {
		_ = s.accountStore.DeleteSession(r.Context(), sessionID)
	}
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		_ = s.accountStore.DeleteSession(r.Context(), cookie.Value)
	}
	s.setSessionCookie(r, w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) setSessionCookie(r *http.Request, w http.ResponseWriter, cookie *http.Cookie) {
	cookie.Secure = s.cfg.SessionCookieSecure || r.TLS != nil
	http.SetCookie(w, cookie)
}
