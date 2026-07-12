package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestCORSRequiresExplicitAllowedOrigin(t *testing.T) {
	server := NewServer(nil, config.Config{AllowedOrigins: []string{"http://127.0.0.1:7655"}})
	handler := server.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))

	denied := httptest.NewRecorder()
	deniedRequest := httptest.NewRequest(http.MethodOptions, "/api/works", nil)
	deniedRequest.Header.Set("Origin", "https://example.invalid")
	handler.ServeHTTP(denied, deniedRequest)
	if denied.Code != http.StatusForbidden || denied.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("denied response = %d, origin %q", denied.Code, denied.Header().Get("Access-Control-Allow-Origin"))
	}

	allowed := httptest.NewRecorder()
	allowedRequest := httptest.NewRequest(http.MethodOptions, "/api/works", nil)
	allowedRequest.Header.Set("Origin", "http://127.0.0.1:7655")
	handler.ServeHTTP(allowed, allowedRequest)
	if allowed.Code != http.StatusNoContent || allowed.Header().Get("Access-Control-Allow-Origin") != "http://127.0.0.1:7655" {
		t.Fatalf("allowed response = %d, origin %q", allowed.Code, allowed.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestCORSAllowsConfirmedSameOrigin(t *testing.T) {
	server := NewServer(nil, config.Config{})
	handler := server.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	request := httptest.NewRequest(http.MethodPost, "http://backend/api/works", nil)
	request.Host = "127.0.0.1:7655"
	request.Header.Set("Origin", "http://127.0.0.1:7655")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Access-Control-Allow-Origin") != "http://127.0.0.1:7655" {
		t.Fatalf("response = %d, origin %q", response.Code, response.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestCORSAllowsLoopbackOnlyInDevMode(t *testing.T) {
	server := NewServer(nil, config.Config{DevMode: true})
	handler := server.withCORS(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	request := httptest.NewRequest(http.MethodPost, "http://backend/api/works", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d", response.Code)
	}
}

func TestRequestBodyLimitRejectsKnownOversizeBody(t *testing.T) {
	called := false
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}), 8)
	request := httptest.NewRequest(http.MethodPost, "/api/test", strings.NewReader("123456789"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if called || response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("called = %v, status = %d", called, response.Code)
	}
}

func TestWriteJSONAddsStableErrorClassification(t *testing.T) {
	tests := []struct {
		status    int
		code      string
		retryable bool
	}{
		{status: http.StatusBadRequest, code: "invalid_request", retryable: false},
		{status: http.StatusUnauthorized, code: "authentication_required", retryable: false},
		{status: http.StatusForbidden, code: "permission_denied", retryable: false},
		{status: http.StatusNotFound, code: "not_found", retryable: false},
		{status: http.StatusConflict, code: "conflict", retryable: false},
		{status: http.StatusBadGateway, code: "upstream_unavailable", retryable: true},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		writeJSON(response, test.status, map[string]string{"error": "safe message"})
		body := response.Body.String()
		if !strings.Contains(body, `"code":"`+test.code+`"`) ||
			!strings.Contains(body, fmt.Sprintf(`"retryable":%t`, test.retryable)) {
			t.Fatalf("status %d body = %q", test.status, body)
		}
	}
}

func TestWriteErrorHidesInternalMessage(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, errors.New("private database path"))
	if strings.Contains(response.Body.String(), "private database path") ||
		!strings.Contains(response.Body.String(), "internal server error") ||
		!strings.Contains(response.Body.String(), `"code":"internal_error"`) ||
		!strings.Contains(response.Body.String(), `"retryable":false`) {
		t.Fatalf("body = %q", response.Body.String())
	}
}

func TestWriteUpstreamErrorHidesInternalMessage(t *testing.T) {
	response := httptest.NewRecorder()
	writeUpstreamError(response, errors.New("Get https://private.invalid/api: connection refused"))
	body := response.Body.String()
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", response.Code)
	}
	if strings.Contains(body, "private.invalid") ||
		!strings.Contains(body, `"code":"upstream_unavailable"`) ||
		!strings.Contains(body, `"retryable":true`) {
		t.Fatalf("body = %q", body)
	}
}

func TestPublicCircleProductFailuresHideInternalMessage(t *testing.T) {
	got := publicCircleProductFailures([]string{
		"RJ00000001: Get https://private.invalid/api: connection refused",
		"database path C:/private/library.db",
	})
	joined := strings.Join(got, " ")
	if strings.Contains(joined, "private.invalid") || strings.Contains(joined, "C:/private") {
		t.Fatalf("failures exposed internal details: %q", joined)
	}
	if got[0] != "RJ00000001: metadata sync failed" {
		t.Fatalf("failure = %q", got[0])
	}
}

func TestWriteErrorClassifiesDatabaseBusy(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, errors.New("database is locked (5)"))
	body := response.Body.String()
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
	if !strings.Contains(body, `"code":"database_busy"`) || !strings.Contains(body, `"retryable":true`) {
		t.Fatalf("body = %q", body)
	}
	if strings.Contains(body, "database is locked") {
		t.Fatalf("body exposed driver error: %q", body)
	}
}
