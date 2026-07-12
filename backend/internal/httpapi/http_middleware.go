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
	if status >= http.StatusBadRequest {
		value = normalizeErrorResponse(status, value)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func normalizeErrorResponse(status int, value any) any {
	var response map[string]any
	switch typed := value.(type) {
	case map[string]string:
		response = make(map[string]any, len(typed)+2)
		for key, item := range typed {
			response[key] = item
		}
	case map[string]any:
		response = make(map[string]any, len(typed)+2)
		for key, item := range typed {
			response[key] = item
		}
	default:
		return value
	}
	if _, ok := response["error"]; !ok {
		return value
	}
	code, retryable := defaultErrorClassification(status)
	if _, ok := response["code"]; !ok {
		response["code"] = code
	}
	if _, ok := response["retryable"]; !ok {
		response["retryable"] = retryable
	}
	return response
}

func defaultErrorClassification(status int) (string, bool) {
	switch status {
	case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnprocessableEntity:
		return "invalid_request", false
	case http.StatusUnauthorized:
		return "authentication_required", false
	case http.StatusForbidden:
		return "permission_denied", false
	case http.StatusNotFound:
		return "not_found", false
	case http.StatusConflict:
		return "conflict", false
	case http.StatusTooManyRequests:
		return "rate_limited", true
	case http.StatusBadGateway:
		return "upstream_unavailable", true
	case http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return "service_unavailable", true
	default:
		return "internal_error", false
	}
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
	writeAPIError(w, http.StatusInternalServerError, "internal_error", "internal server error", false)
}

func writeUpstreamError(w http.ResponseWriter, err error) {
	if isDatabaseBusyError(err) {
		writeError(w, err)
		return
	}
	slog.Error("upstream request failed", "error", err)
	writeAPIError(w, http.StatusBadGateway, "upstream_unavailable", "remote source request failed", true)
}

func writeAPIError(w http.ResponseWriter, status int, code string, message string, retryable bool) {
	writeJSON(w, status, map[string]any{
		"error":     message,
		"code":      code,
		"retryable": retryable,
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
