package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

const initialSetupFileName = "setup-token"

// initialSetupState holds the one-time token that authorizes creating the
// first administrator. Only someone who can read the server log or the config
// directory can claim a new instance, even when it is reachable from a network.
type initialSetupState struct {
	mu       sync.Mutex
	token    string
	complete atomic.Bool
}

// PrepareAdministrator establishes the root account for the configured root
// account mode. Environment mode applies the environment credential on every
// start. Setup mode applies an explicitly requested one-shot password reset,
// then keeps the development identity or opens initial setup.
func (s *Server) PrepareAdministrator(ctx context.Context) error {
	if managed := s.cfg.EnvironmentManagedUsername(); managed != "" {
		if s.cfg.RootPasswordReset {
			slog.Warn("KIKOTO_ROOT_PASSWORD_RESET is ignored in environment root account mode; KIKOTO_ROOT_PASSWORD already sets the password on every start")
		}
		changed, err := s.accountStore.SyncEnvironmentAdministrator(ctx, managed, s.cfg.RootPassword)
		if err != nil {
			return err
		}
		if changed {
			slog.Info("environment-managed administrator password applied", "username", managed)
		}
		s.initialSetup.mu.Lock()
		defer s.initialSetup.mu.Unlock()
		s.completeInitialSetupLocked()
		return nil
	}
	if s.cfg.RootPasswordReset {
		result, applied, err := s.accountStore.ApplyEnvironmentRecovery(ctx, s.cfg.RootUsername, s.cfg.RootPassword)
		var target *account.RecoveryTargetRequiredError
		if errors.As(err, &target) || errors.Is(err, account.ErrRecoveryAccountNotFound) {
			return fmt.Errorf("KIKOTO_ROOT_PASSWORD_RESET: %w; set KIKOTO_ROOT_USERNAME to the account to reset", err)
		}
		if err != nil {
			return fmt.Errorf("KIKOTO_ROOT_PASSWORD_RESET: %w", err)
		}
		if applied {
			slog.Warn("administrator password reset from KIKOTO_ROOT_PASSWORD; set KIKOTO_ROOT_PASSWORD_RESET=false and remove KIKOTO_ROOT_PASSWORD", "username", result.Username, "created", result.Created)
		} else {
			slog.Warn("KIKOTO_ROOT_PASSWORD was already applied and is not reapplied; set KIKOTO_ROOT_PASSWORD_RESET=false and remove KIKOTO_ROOT_PASSWORD", "username", result.Username)
		}
	} else if s.cfg.RootPassword != "" {
		slog.Warn("KIKOTO_ROOT_PASSWORD is ignored unless KIKOTO_ROOT_PASSWORD_RESET=true; remove it from the environment")
	}
	if s.cfg.IsDevelopment() {
		return s.accountStore.EnsureDevelopmentAdministrator(ctx, s.cfg.DevelopmentUsername())
	}
	required, err := s.accountStore.InitialSetupRequired(ctx)
	if err != nil {
		return err
	}
	if !required {
		s.initialSetup.mu.Lock()
		defer s.initialSetup.mu.Unlock()
		s.completeInitialSetupLocked()
		return nil
	}
	return s.openInitialSetup()
}

func (s *Server) openInitialSetup() error {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return err
	}
	token := hex.EncodeToString(raw)
	s.initialSetup.mu.Lock()
	defer s.initialSetup.mu.Unlock()
	s.initialSetup.token = token
	s.initialSetup.complete.Store(false)
	path := s.setupTokenPath()
	if path != "" {
		// Remove first so a stale file cannot keep broader permissions.
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
			return err
		}
	}
	slog.Warn("initial setup required: open Kikoto and enter this setup token to create the first administrator", "setup_token", token, "token_file", path)
	return nil
}

// setupTokenPath places the token beside the database, on the durable config
// mount. It is empty for in-memory and URI databases.
func (s *Server) setupTokenPath() string {
	databasePath := strings.TrimSpace(s.cfg.DatabasePath)
	if databasePath == "" || databasePath == ":memory:" || strings.HasPrefix(databasePath, "file:") {
		return ""
	}
	return filepath.Join(filepath.Dir(databasePath), initialSetupFileName)
}

func (s *Server) completeInitialSetupLocked() {
	s.initialSetup.complete.Store(true)
	s.initialSetup.token = ""
	if path := s.setupTokenPath(); path != "" {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("remove setup token file", "error", err)
		}
	}
}

// initialSetupRequired reports whether a production instance still has no
// administrator. An administrator created by the host-side reset command while
// the server runs also closes setup.
func (s *Server) initialSetupRequired(ctx context.Context) bool {
	if s.cfg.RuntimeMode() != config.ModeProduction || s.initialSetup.complete.Load() {
		return false
	}
	required, err := s.accountStore.InitialSetupRequired(ctx)
	if err != nil {
		slog.Warn("check initial setup state", "error", err)
		return false
	}
	if !required {
		s.initialSetup.mu.Lock()
		s.completeInitialSetupLocked()
		s.initialSetup.mu.Unlock()
	}
	return required
}

func (s *Server) completeInitialSetup(w http.ResponseWriter, r *http.Request) {
	if s.cfg.RuntimeMode() != config.ModeProduction {
		writeAPIError(w, http.StatusConflict, "setup_unavailable", "initial setup is only available in production mode", false)
		return
	}
	var payload struct {
		SetupToken string `json:"setupToken"`
		Username   string `json:"username"`
		Password   string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", false)
		return
	}
	s.initialSetup.mu.Lock()
	defer s.initialSetup.mu.Unlock()
	if s.initialSetup.complete.Load() {
		writeAPIError(w, http.StatusConflict, "setup_complete", "initial setup is already complete", false)
		return
	}
	token := s.initialSetup.token
	provided := strings.TrimSpace(payload.SetupToken)
	if token == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
		writeAPIError(w, http.StatusForbidden, "invalid_setup_token", "invalid setup token", false)
		return
	}
	user, err := s.accountStore.CreateInitialAdministrator(r.Context(), payload.Username, payload.Password)
	if err != nil {
		if errors.Is(err, account.ErrSetupComplete) {
			s.completeInitialSetupLocked()
		}
		if status, code, ok := initialSetupError(err); ok {
			writeAPIError(w, status, code, err.Error(), false)
			return
		}
		writeError(w, err)
		return
	}
	session, err := s.accountStore.CreateSession(r.Context(), user.ID, time.Now())
	s.completeInitialSetupLocked()
	slog.Info("initial administrator created", "username", user.Username)
	if err != nil {
		// The administrator exists; the client can still sign in normally.
		writeError(w, err)
		return
	}
	s.setSessionCookie(r, w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    session.ID,
		Path:     "/",
		Expires:  session.ExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	response := map[string]any{"authenticated": true, "user": s.withPasswordManagement(session.User)}
	if isMobileAuthRequest(r) {
		response["sessionToken"] = session.ID
	}
	writeJSON(w, http.StatusCreated, response)
}

func initialSetupError(err error) (int, string, bool) {
	switch {
	case errors.Is(err, account.ErrSetupComplete):
		return http.StatusConflict, "setup_complete", true
	case errors.Is(err, account.ErrUsernameExists):
		return http.StatusConflict, "username_exists", true
	case errors.Is(err, account.ErrUsernameRequired):
		return http.StatusBadRequest, "username_required", true
	case errors.Is(err, account.ErrReservedUsername):
		return http.StatusBadRequest, "username_reserved", true
	case errors.Is(err, account.ErrPasswordRequired):
		return http.StatusBadRequest, "password_required", true
	case errors.Is(err, account.ErrPasswordTooShort):
		return http.StatusBadRequest, "password_too_short", true
	case errors.Is(err, account.ErrPlaceholderPassword):
		return http.StatusBadRequest, "password_placeholder", true
	default:
		return 0, "", false
	}
}
