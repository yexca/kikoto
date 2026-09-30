package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/personal"
	"github.com/yexca/kikoto/backend/internal/testfixture"
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

func TestListeningStatisticsRangeAndCachedCovers(t *testing.T) {
	db := openMigratedTestDB(t)
	cacheRoot := t.TempDir()
	s := NewServer(db, config.Config{CacheRoot: cacheRoot})
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'synthetic-listener', 'user')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, '` + code + `', 'Example Work')`,
		`INSERT INTO user_listening_session (user_id, session_id, work_id, listened_seconds) VALUES (1, 'synthetic-session', 1, 90)`,
		`INSERT INTO user_listening_day (user_id, work_id, day, listened_seconds, listen_count) VALUES (1, 1, date('now'), 90, 1)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	cover := filepath.Join(cacheRoot, "cover", filepath.FromSlash(coverAssetRelativePath(code, ".jpg")))
	if err := os.MkdirAll(filepath.Dir(cover), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cover, []byte("synthetic"), 0o600); err != nil {
		t.Fatal(err)
	}
	request := func(query string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/listening-statistics"+query, nil)
		r = r.WithContext(context.WithValue(r.Context(), currentUserKey, account.User{ID: 1, Permissions: []string{"library:read"}}))
		response := httptest.NewRecorder()
		s.getListeningStatistics(response, r)
		return response
	}
	if response := request("?range=7d"); response.Code != http.StatusBadRequest {
		t.Fatalf("unknown range = %d", response.Code)
	}
	response := request("?range=30d")
	var stats personal.Statistics
	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil || response.Code != http.StatusOK {
		t.Fatalf("30d = %d, %v", response.Code, err)
	}
	if stats.Range != personal.RangeLast30Days || stats.Granularity != personal.GranularityDay || len(stats.Series) != 30 || stats.ListenedSeconds != 90 {
		t.Fatalf("30d stats = %+v", stats)
	}
	if len(stats.TopWorks) != 1 || !strings.HasPrefix(stats.TopWorks[0].CoverURL, "/api/assets/covers/") {
		t.Fatalf("top works = %+v", stats.TopWorks)
	}
	// Clients that predate ranges still receive the lifetime report with Daily.
	response = request("")
	if err := json.NewDecoder(response.Body).Decode(&stats); err != nil || stats.Range != personal.RangeAll || len(stats.Daily) != 1 {
		t.Fatalf("default = %+v, %v", stats, err)
	}
}
