package httpapi

import (
	"errors"
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

func TestWriteErrorHidesInternalMessage(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, errors.New("private database path"))
	if strings.Contains(response.Body.String(), "private database path") || !strings.Contains(response.Body.String(), "internal server error") {
		t.Fatalf("body = %q", response.Body.String())
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
