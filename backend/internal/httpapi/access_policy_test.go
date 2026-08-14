package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestAnonymousAccessMiddlewareDefaultsToSignInRequired(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	called := false
	handler := server.anonymousAccessMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/works", nil))
	if called || response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), `"code":"authentication_required"`) {
		t.Fatalf("called = %t, status = %d, body = %s", called, response.Code, response.Body.String())
	}

	request := httptest.NewRequest(http.MethodPatch, "/api/settings", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1}))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if !called || response.Code != http.StatusNoContent {
		t.Fatalf("authenticated request called = %t, status = %d", called, response.Code)
	}
}

func TestAnonymousAccessMiddlewareAllowsReadsButNotMutationsWhenEnabled(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('anonymous_access_enabled', 'true')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{Mode: config.ModeProduction})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}

	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			called := false
			handler := server.anonymousAccessMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(method, "/api/works", nil))
			if !called || response.Code != http.StatusNoContent {
				t.Fatalf("called = %t, status = %d", called, response.Code)
			}
		})
	}

	for _, method := range []string{http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			called := false
			handler := server.anonymousAccessMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(method, "/api/settings", nil))
			if called || response.Code != http.StatusUnauthorized {
				t.Fatalf("called = %t, status = %d", called, response.Code)
			}
		})
	}
}

func TestAnonymousAccessMiddlewareKeepsBootstrapEndpointsAvailable(t *testing.T) {
	server := NewServer(nil, config.Config{Mode: config.ModeProduction})
	tests := []struct {
		method string
		path   string
	}{
		{method: http.MethodGet, path: "/health"},
		{method: http.MethodHead, path: "/health"},
		{method: http.MethodGet, path: "/api/auth/me"},
		{method: http.MethodGet, path: "/api/runtime-settings"},
		{method: http.MethodPost, path: "/api/auth/login"},
		{method: http.MethodPost, path: "/api/auth/logout"},
		{method: http.MethodOptions, path: "/api/works"},
	}
	for _, test := range tests {
		t.Run(test.method+" "+test.path, func(t *testing.T) {
			called := false
			handler := server.anonymousAccessMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}))
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
			if !called || response.Code != http.StatusNoContent {
				t.Fatalf("called = %t, status = %d", called, response.Code)
			}
		})
	}
}

func TestRuntimeSettingsHideOperationalConfigurationWhenSignInIsRequired(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/runtime-settings", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload["anonymousAccessEnabled"]; !ok {
		t.Fatalf("runtime settings omitted access policy: %s", response.Body.String())
	}
	for _, key := range []string{"cacheEnabled", "directoryRoutingRules", "recommendationThreshold"} {
		if _, ok := payload[key]; ok {
			t.Fatalf("runtime settings exposed %q while sign-in is required: %s", key, response.Body.String())
		}
	}
}

func TestAccessPolicyEndpointPersistsAndAppliesProductionPolicy(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{
		Mode: config.ModeProduction, RootUsername: "root", RootPassword: "synthetic-password",
	})
	if err := server.BootstrapRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	handler := server.Routes()
	cookie := loginTestSession(t, handler, "root", "synthetic-password")

	update := func(enabled bool) {
		t.Helper()
		request := httptest.NewRequest(http.MethodPatch, "/api/access-policy", strings.NewReader(`{"anonymousAccessEnabled":`+strconv.FormatBool(enabled)+`}`))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("update status = %d, body = %s", response.Code, response.Body.String())
		}
		var payload struct {
			AnonymousAccessEnabled bool `json:"anonymousAccessEnabled"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.AnonymousAccessEnabled != enabled || server.anonymousAccessEnabled() != enabled {
			t.Fatalf("response enabled = %t, effective enabled = %t, want %t", payload.AnonymousAccessEnabled, server.anonymousAccessEnabled(), enabled)
		}
	}

	update(true)
	readResponse := httptest.NewRecorder()
	handler.ServeHTTP(readResponse, httptest.NewRequest(http.MethodGet, "/api/works", nil))
	if readResponse.Code != http.StatusOK {
		t.Fatalf("anonymous read status = %d, body = %s", readResponse.Code, readResponse.Body.String())
	}
	writeResponse := httptest.NewRecorder()
	handler.ServeHTTP(writeResponse, httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(`{}`)))
	if writeResponse.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous mutation status = %d, body = %s", writeResponse.Code, writeResponse.Body.String())
	}

	runtimeResponse := httptest.NewRecorder()
	handler.ServeHTTP(runtimeResponse, httptest.NewRequest(http.MethodGet, "/api/runtime-settings", nil))
	if runtimeResponse.Code != http.StatusOK || !strings.Contains(runtimeResponse.Body.String(), `"anonymousAccessEnabled":true`) {
		t.Fatalf("runtime settings status = %d, body = %s", runtimeResponse.Code, runtimeResponse.Body.String())
	}

	update(false)
	readResponse = httptest.NewRecorder()
	handler.ServeHTTP(readResponse, httptest.NewRequest(http.MethodGet, "/api/works", nil))
	if readResponse.Code != http.StatusUnauthorized {
		t.Fatalf("disabled anonymous read status = %d, body = %s", readResponse.Code, readResponse.Body.String())
	}
	authenticatedRuntimeRequest := httptest.NewRequest(http.MethodGet, "/api/runtime-settings", nil)
	authenticatedRuntimeRequest.AddCookie(cookie)
	authenticatedRuntimeResponse := httptest.NewRecorder()
	handler.ServeHTTP(authenticatedRuntimeResponse, authenticatedRuntimeRequest)
	if authenticatedRuntimeResponse.Code != http.StatusOK || !strings.Contains(authenticatedRuntimeResponse.Body.String(), `"cacheEnabled":`) {
		t.Fatalf("authenticated runtime settings status = %d, body = %s", authenticatedRuntimeResponse.Code, authenticatedRuntimeResponse.Body.String())
	}
	var stored string
	var auditCount int
	if err := db.QueryRow(`SELECT value_json FROM app_setting WHERE key = 'anonymous_access_enabled'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action = 'access_policy.anonymous_access_update'`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if stored != "false" || auditCount != 2 {
		t.Fatalf("stored policy = %q, audit count = %d", stored, auditCount)
	}
}

func TestAccessPolicyEndpointRequiresSuperAdminAndSupportsDevelopment(t *testing.T) {
	t.Run("permission", func(t *testing.T) {
		db := openMigratedTestDB(t)
		server := NewServer(db, config.Config{Mode: config.ModeProduction})
		request := httptest.NewRequest(http.MethodPatch, "/api/access-policy", strings.NewReader(`{"anonymousAccessEnabled":true}`))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
			ID: 2, Role: "admin", Permissions: []string{"sources:write"},
		}))
		response := httptest.NewRecorder()
		server.updateAccessPolicy(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
	})

	t.Run("development", func(t *testing.T) {
		db := openMigratedTestDB(t)
		server := NewServer(db, config.Config{
			Mode: config.ModeDevelopment, RootUsername: "root", RootPassword: "synthetic-password",
		})
		if err := server.BootstrapRoot(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := server.LoadAccessPolicy(context.Background()); err != nil {
			t.Fatal(err)
		}
		handler := server.Routes()
		request := httptest.NewRequest(http.MethodPatch, "/api/access-policy", strings.NewReader(`{"anonymousAccessEnabled":true}`))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		var stored string
		if err := db.QueryRow(`SELECT value_json FROM app_setting WHERE key = 'anonymous_access_enabled'`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		if stored != "true" || !server.configuredAnonymousAccessEnabled() || server.anonymousAccessEnabled() {
			t.Fatalf("stored = %q, configured = %t, effective = %t", stored, server.configuredAnonymousAccessEnabled(), server.anonymousAccessEnabled())
		}

		runtimeResponse := httptest.NewRecorder()
		handler.ServeHTTP(runtimeResponse, httptest.NewRequest(http.MethodGet, "/api/runtime-settings", nil))
		if runtimeResponse.Code != http.StatusOK || !strings.Contains(runtimeResponse.Body.String(), `"anonymousAccessEnabled":true`) {
			t.Fatalf("runtime settings status = %d, body = %s", runtimeResponse.Code, runtimeResponse.Body.String())
		}
	})
}

func TestDemoAccessPolicyMutationIsRejectedBeforeTheHandler(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeDemo})
	if err := server.BootstrapDemo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPatch, "/api/access-policy", strings.NewReader(`{"anonymousAccessEnabled":true}`))
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"demo_read_only"`) {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM app_setting WHERE key = 'anonymous_access_enabled'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("demo mutation persisted %d settings", count)
	}
}
