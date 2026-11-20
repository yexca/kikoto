package httpapi

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/accesspolicy"
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
		if s.anonymousAccessEnabled() && (r.Method == http.MethodGet || r.Method == http.MethodHead || playbackQueueResolveRequest(r)) {
			// Remote-derived content can reveal the remote configuration,
			// so without anonymous remote browsing a visitor reaches local
			// content only (see anonymous_local_only.go).
			if !s.accessPolicy.Current().AnonymousRemoteBrowsingEnabled {
				refused := localOnlyRefusedPath(r.URL.Path)
				if !refused {
					var err error
					if refused, err = s.localOnlyMediaRefused(r); err != nil {
						writeError(w, err)
						return
					}
				}
				if refused {
					writeAPIError(w, http.StatusUnauthorized, "authentication_required", "sign in to browse remote sources", false)
					return
				}
				r = r.WithContext(withLocalOnly(r.Context()))
			}
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
	case "/api/library/migration/public":
		return r.Method == http.MethodGet || r.Method == http.MethodHead
	case "/api/auth/login", "/api/auth/logout", "/api/auth/setup":
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
		AnonymousAccessEnabled         *bool `json:"anonymousAccessEnabled"`
		AnonymousRemoteBrowsingEnabled *bool `json:"anonymousRemoteBrowsingEnabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.AnonymousAccessEnabled == nil && payload.AnonymousRemoteBrowsingEnabled == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "anonymousAccessEnabled or anonymousRemoteBrowsingEnabled is required"})
		return
	}
	policy, err := s.accessPolicy.UpdatePolicy(r.Context(), actor.ID, accesspolicy.PolicyUpdate{
		AnonymousAccessEnabled:         payload.AnonymousAccessEnabled,
		AnonymousRemoteBrowsingEnabled: payload.AnonymousRemoteBrowsingEnabled,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, policy)
}
