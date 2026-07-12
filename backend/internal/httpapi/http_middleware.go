package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

const maxJSONRequestBytes int64 = 1 << 20

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, err error) {
	slog.Error("http request failed", "error", err)
	if isDatabaseBusyError(err) {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"error":     "database is busy; please retry",
			"code":      "database_busy",
			"retryable": true,
		})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal server error"})
}

func writeUpstreamError(w http.ResponseWriter, err error) {
	if isDatabaseBusyError(err) {
		writeError(w, err)
		return
	}
	slog.Error("upstream request failed", "error", err)
	writeJSON(w, http.StatusBadGateway, map[string]any{
		"error":     "remote source request failed",
		"code":      "upstream_unavailable",
		"retryable": true,
	})
}

func isDatabaseBusyError(err error) bool {
	if err == nil {
		return false
	}
	for current := err; current != nil; current = errors.Unwrap(current) {
		message := strings.ToLower(current.Error())
		if strings.Contains(message, "database is locked") ||
			strings.Contains(message, "database table is locked") ||
			strings.Contains(message, "sqlite_busy") {
			return true
		}
	}
	return false
}

func mustJSON(value any) string {
	bytes, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(bytes)
}

func limitRequestBody(next http.Handler, maxBytes int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Body != nil {
			if r.ContentLength > maxBytes {
				writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "request body too large"})
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) withCORS(next http.Handler) http.Handler {
	allowed := map[string]bool{}
	for _, origin := range s.cfg.AllowedOrigins {
		origin = strings.TrimRight(strings.TrimSpace(origin), "/")
		if origin != "" {
			allowed[origin] = true
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimRight(strings.TrimSpace(r.Header.Get("Origin")), "/")
		if origin == "" {
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if !allowed[origin] && !requestOriginMatches(r, origin) && !isMobileAppOrigin(origin) && !(s.cfg.DevMode && isLoopbackOrigin(origin)) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "origin not allowed"})
			return
		}
		w.Header().Add("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Kikoto-Mobile")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func isMobileAppOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if !strings.EqualFold(parsed.Hostname(), "localhost") {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "capacitor":
		return true
	default:
		return false
	}
}

func requestOriginMatches(r *http.Request, origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	proto := "http"
	if r.TLS != nil {
		proto = "https"
	}
	return strings.EqualFold(parsed.Host, r.Host) && strings.EqualFold(parsed.Scheme, proto)
}

func isLoopbackOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}
