package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestPersonalRoutesRequireAuthenticationAndPermissions(t *testing.T) {
	s := NewServer(nil, config.Config{})
	for _, tc := range []struct {
		method, path string
		handler      http.HandlerFunc
		permission   string
	}{
		{"GET", "/api/user-tags?scope=work", s.listPersonalTags, "library:read"},
		{"PATCH", "/api/user-tags/1?scope=work", s.changePersonalTag, "tags:write"},
		{"POST", "/api/listening-sessions", s.recordListeningSession, "playback:use"},
		{"GET", "/api/listening-sessions", s.getListeningGeneration, "playback:use"},
		{"GET", "/api/listening-history", s.getListeningHistory, "library:read"},
		{"GET", "/api/listening-statistics", s.getListeningStatistics, "library:read"},
		{"DELETE", "/api/listening-history", s.clearListeningHistory, "playback:use"},
		{"GET", "/api/user-data/export", s.exportPersonalData, "library:read"},
		{"POST", "/api/user-data/import", s.importPersonalData, "favorites:write"},
		{"POST", "/api/user-data/import/preview", s.importPersonalData, "favorites:write"},
		{"GET", "/api/user-data/kikoeru/options", s.getKikoeruImportOptions, "favorites:write"},
		{"POST", "/api/user-data/kikoeru/account", s.importKikoeruAccount, "favorites:write"},
		{"POST", kikoeruDatabaseImportPath, s.importKikoeruDatabase, "favorites:write"},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
			response := httptest.NewRecorder()
			tc.handler(response, r)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("anonymous = %d", response.Code)
			}
			response = httptest.NewRecorder()
			r = r.WithContext(context.WithValue(r.Context(), currentUserKey, account.User{ID: 1, Permissions: []string{}}))
			tc.handler(response, r)
			if response.Code != http.StatusForbidden {
				t.Fatalf("unprivileged = %d, missing %s", response.Code, tc.permission)
			}
		})
	}
	for _, permissions := range [][]string{{"favorites:write"}, {"favorites:write", "tags:write"}} {
		r := httptest.NewRequest("POST", "/api/user-data/import", strings.NewReader(`{}`))
		r = r.WithContext(context.WithValue(r.Context(), currentUserKey, account.User{ID: 1, Permissions: permissions}))
		response := httptest.NewRecorder()
		s.importPersonalData(response, r)
		if response.Code != http.StatusForbidden {
			t.Fatalf("partial import permission = %d", response.Code)
		}
	}
}

func TestDemoRejectsEveryPersonalMutation(t *testing.T) {
	s := NewServer(openMigratedTestDB(t), config.Config{Mode: config.ModeDemo})
	if err := s.BootstrapDemo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	routes := s.Routes()
	for _, tc := range []struct{ method, path string }{
		{"PATCH", "/api/user-tags/1?scope=work"},
		{"POST", "/api/user-tags/1/merge?scope=work"},
		{"DELETE", "/api/user-tags/1?scope=work"},
		{"POST", "/api/listening-sessions"},
		{"DELETE", "/api/listening-history"},
		{"POST", "/api/user-data/import/preview"},
		{"POST", "/api/user-data/import"},
		{"POST", "/api/user-data/kikoeru/account"},
		{"POST", kikoeruDatabaseImportPath},
	} {
		response := httptest.NewRecorder()
		routes.ServeHTTP(response, httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)))
		if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"demo_read_only"`) {
			t.Fatalf("%s %s = %d %s", tc.method, tc.path, response.Code, response.Body.String())
		}
	}
}

func TestPersonalImportBodyBudgetAndSanitizedErrors(t *testing.T) {
	s := NewServer(nil, config.Config{})
	user := account.User{ID: 1, Permissions: []string{"favorites:write", "tags:write", "playback:use"}}
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"format":"kikoto","data":{"format":"https://source.example.invalid/synthetic-token","version":1}}`, http.StatusBadRequest},
		{strings.Repeat(" ", (10<<20)+1025), http.StatusRequestEntityTooLarge},
	} {
		r := httptest.NewRequest(http.MethodPost, "/api/user-data/import", strings.NewReader(tc.body))
		r = r.WithContext(context.WithValue(r.Context(), currentUserKey, user))
		response := httptest.NewRecorder()
		s.importPersonalData(response, r)
		if response.Code != tc.want || strings.Contains(response.Body.String(), "synthetic-token") {
			t.Fatalf("import = %d %s", response.Code, response.Body.String())
		}
	}
	for _, path := range []string{"/api/user-data/import", "/api/user-data/import/preview"} {
		called := false
		handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) }), maxJSONRequestBytes)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(strings.Repeat(" ", 2<<20))))
		if !called || response.Code != http.StatusNoContent {
			t.Fatalf("valid transfer budget = %d", response.Code)
		}
	}
}
