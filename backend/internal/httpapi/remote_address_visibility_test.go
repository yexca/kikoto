package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRemoteAddressRedactorRemovesURLsAddressesAndConfiguredHosts(t *testing.T) {
	redactor := &remoteAddressRedactor{hosts: []string{"nas-a:8080", "nas-a"}}
	got := redactor.text(`Get "https://source.example.invalid/api/media?token=synthetic-token": dial tcp 192.0.2.10:8443: refused; lookup nas-a: no such host; [2001:db8::1]:443; dynasty stays`)
	for _, leaked := range []string{"source.example.invalid", "synthetic-token", "192.0.2.10", "nas-a", "2001:db8"} {
		if strings.Contains(got, leaked) {
			t.Fatalf("redacted text still contains %q: %s", leaked, got)
		}
	}
	if !strings.Contains(got, "dynasty stays") {
		t.Fatalf("redaction removed part of an ordinary word: %s", got)
	}
	document := redactor.json(`{"error":"dial tcp: lookup nas-a: no such host","codes":["RJ00000001"],"count":2}`)
	if strings.Contains(document, "nas-a") || !strings.Contains(document, "RJ00000001") || !strings.Contains(document, `"count":2`) {
		t.Fatalf("redacted JSON = %s", document)
	}
	var visible *remoteAddressRedactor
	if visible.text("https://source.example.invalid") != "https://source.example.invalid" {
		t.Fatal("a nil redactor must leave text unchanged")
	}
}

func TestRemoteImageTokensAreBoundToTheirSource(t *testing.T) {
	var sealer remoteImageTokenSealer
	token, err := sealer.seal(7, "https://source.example.invalid/cover.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(token, "example") {
		t.Fatalf("token reveals the address: %s", token)
	}
	if value, ok := sealer.open(7, token); !ok || value != "https://source.example.invalid/cover.jpg" {
		t.Fatalf("open = %q, %v", value, ok)
	}
	if _, ok := sealer.open(8, token); ok {
		t.Fatal("a token opened for another source")
	}
	if _, ok := sealer.open(7, token[:len(token)-2]+"AA"); ok {
		t.Fatal("a modified token opened")
	}
}

func TestRemoteAddressesAreHiddenFromAccountsWithoutSourceManagement(t *testing.T) {
	fixture := newRoleBoundaryFixture(t)
	db := fixture.server.db
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)`, nil},
		{`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (8, 'example_local_a', 'Example Local A', 'local_folder', 1)`, nil},
		{`INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (7, 'https://source.example.invalid/api', 'https://source.example.invalid')`, nil},
		{`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`, nil},
		{`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, source_url, availability) VALUES (1, 7, 'tracked', 'RJ00000000', 'https://source.example.invalid/work/RJ00000000', 'available')`, nil},
		{`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability) VALUES (1, 8, 'local', 'private-library/RJ00000000', 'available')`, nil},
		{`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'track.mp3', 'synthetic-track')`, nil},
		{`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (2, 1, 'image', 'cover.png', 'synthetic-cover')`, nil},
		{`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, stream_url, download_url) VALUES (1, 1, 7, 'remote_stream', 'track.mp3', 'available', 'https://source.example.invalid/media/stream/track.mp3', 'https://source.example.invalid/media/download/track.mp3')`, nil},
		{`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, download_url) VALUES (2, 2, 7, 'remote_stream', 'cover.png', 'available', 'https://source.example.invalid/media/download/cover.png')`, nil},
		{`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, summary_json) VALUES (1, 'remote_source_sync', 'Track RJ00000000', 'failed', 'manual', ?)`, []any{`{"error":"Get \"https://source.example.invalid/api/workInfo/RJ00000000\": dial tcp 192.0.2.10:443: i/o timeout"}`}},
		{`INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status, input_json, error_message) VALUES (1, 'select', 'select_remote_source', 'Select remote source', 1, 'failed', '{"api_url":"https://source.example.invalid/api"}', 'lookup source.example.invalid: no such host')`, nil},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(fixture.server.cfg.DataRoot, "private-library", "RJ00000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"/api/works/1/media", "/api/works/1", "/api/workflow-runs/1"} {
		hidden := fixture.request("contributor", http.MethodGet, target, ``)
		if hidden.Code != http.StatusOK || strings.Contains(hidden.Body.String(), "example.invalid") || strings.Contains(hidden.Body.String(), "192.0.2.10") || strings.Contains(hidden.Body.String(), `"sourceUrl":"private-library/RJ00000000"`) {
			t.Fatalf("contributor %s = %d, body leaks a source address: %s", target, hidden.Code, hidden.Body)
		}
		visible := fixture.request("admin", http.MethodGet, target, ``)
		if visible.Code != http.StatusOK || !strings.Contains(visible.Body.String(), "source.example.invalid") || strings.Contains(visible.Body.String(), `"sourceUrl":"private-library/RJ00000000"`) {
			t.Fatalf("admin %s = %d, body = %s", target, visible.Code, visible.Body)
		}
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('anonymous_access_enabled', 'true')`); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	anonymous := httptest.NewRecorder()
	fixture.handler.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/works/1", nil))
	if anonymous.Code != http.StatusOK || strings.Contains(anonymous.Body.String(), `"sourceUrl":"private-library/RJ00000000"`) || strings.Contains(anonymous.Body.String(), "source.example.invalid") {
		t.Fatalf("anonymous work detail = %d, body leaks a source address: %s", anonymous.Code, anonymous.Body)
	}
	var storedLocalPath string
	if err := db.QueryRow(`SELECT source_url FROM work_source_presence WHERE work_id = 1 AND file_source_id = 8 AND presence_type = 'local'`).Scan(&storedLocalPath); err != nil {
		t.Fatal(err)
	}
	if storedLocalPath != "private-library/RJ00000000" {
		t.Fatalf("stored local source path = %q, want the value retained for internal cleanup", storedLocalPath)
	}
	media := fixture.request("user", http.MethodGet, "/api/works/1/media", ``).Body.String()
	if !strings.Contains(media, `"streamUrl":"/api/media/1/stream"`) || !strings.Contains(media, `/api/remote-sources/7/images/`) {
		t.Fatalf("hidden locations lost their server routes: %s", media)
	}

	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, 'false')`, hideRemoteSourceAddressesSetting); err != nil {
		t.Fatal(err)
	}
	if response := fixture.request("contributor", http.MethodGet, "/api/works/1/media", ``); !strings.Contains(response.Body.String(), "source.example.invalid") {
		t.Fatalf("turning the setting off did not restore addresses: %s", response.Body)
	}
}

func TestRemoteImageProxyServesOnlyAllowedRasterImages(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/cover.png":
			_, _ = w.Write(png)
		case "/moved.png":
			http.Redirect(w, r, "https://elsewhere.example.invalid/cover.png", http.StatusFound)
		case "/large.png":
			w.Header().Set("Content-Length", "30000000")
			_, _ = w.Write(png)
		default:
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(`<svg viewBox="0 0 1 1"></svg>`))
		}
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)`, nil},
		{`INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (7, ?, ?)`, []any{remote.URL, remote.URL}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	listener := account.User{ID: 1, Role: "user", Permissions: account.PermissionsForRole("user")}
	serve := func(rawURL string) *httptest.ResponseRecorder {
		t.Helper()
		proxyPath := server.remoteImageProxyURL(7, rawURL)
		token := proxyPath[strings.LastIndex(proxyPath, "/")+1:]
		request := httptest.NewRequest(http.MethodGet, proxyPath, nil)
		request.SetPathValue("id", "7")
		request.SetPathValue("token", token)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, listener))
		response := httptest.NewRecorder()
		server.serveRemoteSourceImage(response, request)
		return response
	}
	if response := serve(remote.URL + "/cover.png"); response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("image = %d %q: %s", response.Code, response.Header().Get("Content-Type"), response.Body)
	}
	if response := serve(remote.URL + "/cover.svg"); response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "svg") {
		t.Fatalf("active image type = %d: %s", response.Code, response.Body)
	}
	if response := serve(remote.URL + "/moved.png"); response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "elsewhere") {
		t.Fatalf("redirect to an unconfigured origin = %d: %s", response.Code, response.Body)
	}
	// Only the configured origin keeps the private-address exception.
	if response := serve("http://127.0.0.1:1/cover.png"); response.Code != http.StatusBadGateway {
		t.Fatalf("private address outside the configured origin = %d: %s", response.Code, response.Body)
	}
	if response := serve(remote.URL + "/large.png"); response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("image above the cover limit = %d: %s", response.Code, response.Body)
	}
	if response := serve("https://elsewhere.example.invalid/cover.png"); response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "elsewhere") {
		t.Fatalf("unconfigured origin = %d: %s", response.Code, response.Body)
	}
	withCredentials, err := url.Parse(remote.URL + "/cover.png")
	if err != nil {
		t.Fatal(err)
	}
	withCredentials.User = url.UserPassword("synthetic-user", "synthetic-password")
	if response := serve(withCredentials.String()); response.Code != http.StatusBadGateway {
		t.Fatalf("embedded credentials = %d: %s", response.Code, response.Body)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/images/not-a-token", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("token", "not-a-token")
	response := httptest.NewRecorder()
	server.serveRemoteSourceImage(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("unknown token = %d", response.Code)
	}
}
