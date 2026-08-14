package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/config"
)

func (s *Server) LoadAccessPolicy(ctx context.Context) error {
	return s.accessPolicy.Load(ctx)
}

func (s *Server) configuredAnonymousAccessEnabled() bool {
	return s.accessPolicy.Current().AnonymousAccessEnabled
}

func (s *Server) anonymousAccessEnabled() bool {
	return s.cfg.RuntimeMode() == config.ModeProduction && s.configuredAnonymousAccessEnabled()
}

func (s *Server) anonymousAccessMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, authenticated := userFromContext(r.Context()); authenticated {
			next.ServeHTTP(w, r)
			return
		}
		if isAnonymousBootstrapRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		if s.anonymousAccessEnabled() && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
			next.ServeHTTP(w, r)
			return
		}
		writeAPIError(w, http.StatusUnauthorized, "authentication_required", "login required", false)
	})
}

func isAnonymousBootstrapRequest(r *http.Request) bool {
	if r.Method == http.MethodOptions {
		return true
	}
	switch r.URL.Path {
	case "/health":
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	case "/api/auth/me", "/api/runtime-settings":
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	case "/api/auth/login", "/api/auth/logout":
		return r.Method == http.MethodPost
	default:
		return false
	}
}

func (s *Server) updateAccessPolicy(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "system:admin")
	if !ok {
		return
	}
	if mode := s.cfg.RuntimeMode(); mode != config.ModeProduction && mode != config.ModeDevelopment {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "anonymous access is not configurable in demo mode"})
		return
	}
	var payload struct {
		AnonymousAccessEnabled *bool `json:"anonymousAccessEnabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.AnonymousAccessEnabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "anonymousAccessEnabled is required"})
		return
	}
	policy, err := s.accessPolicy.Update(r.Context(), actor.ID, *payload.AnonymousAccessEnabled)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policy)
}
