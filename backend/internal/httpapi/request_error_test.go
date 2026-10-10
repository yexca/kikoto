package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

type errorResponseBody struct {
	Code      string `json:"code"`
	Error     string `json:"error"`
	Retryable bool   `json:"retryable"`
}

func requestAsAdmin(method string, target string, body string, pathValues map[string]string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	for key, value := range pathValues {
		request.SetPathValue(key, value)
	}
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"system:admin"}}))
}

// assertClientError checks that the caller's own mistake is answered as one:
// the expected 4xx, a stable code, not retryable, and nothing logged at ERROR.
func assertClientError(t *testing.T, name string, handler http.HandlerFunc, request *http.Request, status int, code string) {
	t.Helper()
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelError})))
	defer slog.SetDefault(previous)

	response := httptest.NewRecorder()
	handler(response, request)
	var body errorResponseBody
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("%s: response is not an error object: %d %s", name, response.Code, response.Body.String())
	}
	if response.Code != status || body.Code != code || body.Retryable || body.Error == "" {
		t.Fatalf("%s: got %d %+v, want %d %s and not retryable", name, response.Code, body, status, code)
	}
	if logs.Len() > 0 {
		t.Fatalf("%s: a client error was logged at ERROR: %s", name, logs.String())
	}
}

func TestMediaLocationOperationsRejectMissingAndMismatchedLocations(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO work (id, primary_code, title) VALUES (10, 'RJ00000000', 'Example Work')",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (20, 'example_local', 'Example Local', 'local_folder', 1)",
		"INSERT INTO media_item (id, work_id, kind, title) VALUES (30, 10, 'audio', 'track')",
		"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (40, 30, 20, 'local', 'Library/RJ00000000/track.mp3', 'available')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})

	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		request *http.Request
		status  int
		code    string
	}{
		{"cache a missing location", server.cacheMediaLocation, requestAsAdmin(http.MethodPost, "/api/media/999/cache", "", map[string]string{"id": "999"}), http.StatusNotFound, "not_found"},
		{"cache a local location", server.cacheMediaLocation, requestAsAdmin(http.MethodPost, "/api/media/40/cache", "", map[string]string{"id": "40"}), http.StatusBadRequest, "invalid_request"},
		{"delete a missing cache location", server.deleteMediaCacheLocation, requestAsAdmin(http.MethodDelete, "/api/media/999/cache", "", map[string]string{"id": "999"}), http.StatusNotFound, "not_found"},
		{"delete a local location as cache", server.deleteMediaCacheLocation, requestAsAdmin(http.MethodDelete, "/api/media/40/cache", "", map[string]string{"id": "40"}), http.StatusBadRequest, "invalid_request"},
		{"delete a missing local location", server.deleteMediaLocalLocation, requestAsAdmin(http.MethodDelete, "/api/media/999/local", "", map[string]string{"id": "999"}), http.StatusNotFound, "not_found"},
		{"clean up a missing location", server.cleanupMediaLocations, requestAsAdmin(http.MethodPost, "/api/media/cleanup", `{"targets":[{"kind":"local","locationId":999}]}`, nil), http.StatusNotFound, "not_found"},
		{"clean up a mismatched location", server.cleanupMediaLocations, requestAsAdmin(http.MethodPost, "/api/media/cleanup", `{"targets":[{"kind":"cache","locationId":40}]}`, nil), http.StatusBadRequest, "invalid_request"},
		{"clean up nothing", server.cleanupMediaLocations, requestAsAdmin(http.MethodPost, "/api/media/cleanup", `{"targets":[]}`, nil), http.StatusBadRequest, "invalid_request"},
	} {
		assertClientError(t, tc.name, tc.handler, tc.request, tc.status, tc.code)
	}
}

func TestDeletingMissingAliasOrTrackedSourceIsNotFound(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO work (id, primary_code, title) VALUES (10, 'RJ00000000', 'Example Work')",
		"INSERT INTO party (id, party_type, display_name) VALUES (20, 'circle', 'Example Circle')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})

	assertClientError(t, "delete a missing alias", server.changeMetadataCircle,
		requestAsAdmin(http.MethodDelete, "/api/metadata/circles/20/aliases/999", "", map[string]string{"partyId": "20", "aliasId": "999"}),
		http.StatusNotFound, "not_found")
	assertClientError(t, "delete an alias of a missing circle", server.changeMetadataCircle,
		requestAsAdmin(http.MethodDelete, "/api/metadata/circles/999/aliases/1", "", map[string]string{"partyId": "999", "aliasId": "1"}),
		http.StatusNotFound, "not_found")
	assertClientError(t, "untrack a source the work is not tracked from", server.untrackWorkSource,
		requestAsAdmin(http.MethodDelete, "/api/works/10/tracked-sources/999", "", map[string]string{"id": "10", "sourceId": "999"}),
		http.StatusNotFound, "not_found")
	assertClientError(t, "untrack a missing work", server.untrackWorkSource,
		requestAsAdmin(http.MethodDelete, "/api/works/999/tracked-sources/1", "", map[string]string{"id": "999", "sourceId": "1"}),
		http.StatusNotFound, "not_found")
}

func TestRemoteSourceOperationsRejectUnknownAndDisabledSources(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (8, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 0)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (8, 'https://source.example.invalid', 'https://source.example.invalid')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	operations := []struct {
		name    string
		method  string
		suffix  string
		handler http.HandlerFunc
	}{
		{"detail", http.MethodGet, "", server.getRemoteSourceWork},
		{"tracks", http.MethodGet, "/tracks", server.getRemoteSourceWorkTracks},
		{"fetch plan", http.MethodPost, "/fetch-plan", server.planRemoteSourceWorkSave},
		{"fetch", http.MethodPost, "/fetch", server.saveRemoteSourceWork},
		{"save plan", http.MethodPost, "/save-plan", server.planRemoteSourceWorkSave},
		{"save", http.MethodPost, "/save", server.saveRemoteSourceWork},
		{"sync", http.MethodPost, "/sync", server.syncRemoteSourceWork},
		{"track", http.MethodPost, "/track", server.trackRemoteSourceWork},
	}
	for _, source := range []struct {
		id     string
		status int
		code   string
	}{
		{"999", http.StatusNotFound, "not_found"},
		{"8", http.StatusConflict, "source_not_usable"},
	} {
		for _, operation := range operations {
			request := requestAsAdmin(operation.method, "/api/remote-sources/"+source.id+"/works/RJ00000000"+operation.suffix, "{}", map[string]string{"id": source.id, "code": "RJ00000000"})
			assertClientError(t, operation.name+" on source "+source.id, operation.handler, request, source.status, source.code)
		}
	}
}

// A source that answers "no such work" has answered: the reply is a 404 for the
// caller and leaves the source healthy. A source that cannot answer is a 502.
func TestRemoteWorkMissingUpstreamIsNotFoundAndKeepsSourceHealthy(t *testing.T) {
	listingAvailable := true
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/api/workInfo/"):
			http.NotFound(w, r)
		case listingAvailable:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"works":[],"pagination":{"currentPage":1,"pageSize":20,"totalCount":0}}`))
		default:
			http.Error(w, "unavailable", http.StatusBadGateway)
		}
	}))
	defer upstream.Close()

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, api_url, base_url, health_status)
		VALUES (7, ?, ?, 'healthy')
	`, upstream.URL, upstream.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	health := func() string {
		var status sql.NullString
		if err := db.QueryRow("SELECT health_status FROM file_source_endpoint WHERE file_source_id = 7").Scan(&status); err != nil {
			t.Fatal(err)
		}
		return status.String
	}
	pathValues := map[string]string{"id": "7", "code": "RJ00000000"}

	for name, handler := range map[string]http.HandlerFunc{
		"detail": server.getRemoteSourceWork,
		"tracks": server.getRemoteSourceWorkTracks,
	} {
		assertClientError(t, name+" of a work the source does not have", handler,
			requestAsAdmin(http.MethodGet, "/api/remote-sources/7/works/RJ00000000", "", pathValues), http.StatusNotFound, "not_found")
		if got := health(); got != "healthy" {
			t.Fatalf("%s: a not-found answer set source health to %q", name, got)
		}
	}

	listingAvailable = false
	response := httptest.NewRecorder()
	server.getRemoteSourceWork(response, requestAsAdmin(http.MethodGet, "/api/remote-sources/7/works/RJ00000000", "", pathValues))
	var body errorResponseBody
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != http.StatusBadGateway || body.Code != "upstream_unavailable" || !body.Retryable {
		t.Fatalf("an unanswered lookup = %d %+v, want a retryable 502", response.Code, body)
	}
	if got := health(); got != "unavailable" {
		t.Fatalf("an upstream failure left source health at %q", got)
	}
}
