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

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type mediaTextFixture struct {
	server *Server
}

// newMediaTextFixture stores one work whose text file sits in a local folder
// (location 1), the cache (location 2), and a remote source (locations 3-5),
// plus a cached image (location 6).
func newMediaTextFixture(t *testing.T, endpoint string) mediaTextFixture {
	t.Helper()
	dataRoot, cacheRoot := t.TempDir(), t.TempDir()
	db := openMigratedTestDB(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_local', 'Example Local', 'local_folder', 1)", nil},
		{"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)", nil},
		{"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (8, 'example_remote_b', 'Example Remote B', 'kikoeru_compatible', 0)", nil},
		{"INSERT INTO file_source_endpoint (file_source_id, api_url, base_url, restrict_outbound_hosts) VALUES (7, ?, ?, 1)", []any{endpoint, endpoint}},
		{"INSERT INTO file_source_endpoint (file_source_id, api_url, base_url, restrict_outbound_hosts) VALUES (8, ?, ?, 1)", []any{endpoint, endpoint}},
		{"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')", nil},
		{"INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'text', 'notes.txt', 'synthetic-notes')", nil},
		{"INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (2, 1, 'image', 'cover.png', 'synthetic-cover')", nil},
		{"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'local', 'Library/RJ00000000/notes.txt', 'available')", nil},
		{"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (2, 1, 7, 'cache', 'media/example_remote_a/RJ00000000/notes.txt', 'available')", nil},
		{"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, stream_url) VALUES (3, 1, 7, 'remote_stream', 'notes.txt', 'available', ?)", []any{endpoint + "/media/notes.txt"}},
		{"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, stream_url) VALUES (4, 1, 7, 'remote_stream', 'elsewhere.txt', 'available', 'https://media.example.invalid/elsewhere.txt')", nil},
		{"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, stream_url) VALUES (5, 1, 8, 'remote_stream', 'disabled.txt', 'available', ?)", []any{endpoint + "/media/notes.txt"}},
		{"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (6, 2, 7, 'cache', 'media/example_remote_a/RJ00000000/cover.png', 'available')", nil},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	write := func(root string, relPath string, content []byte) {
		fullPath := filepath.Join(root, filepath.FromSlash(relPath))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(dataRoot, "Library/RJ00000000/notes.txt", []byte("local text\n"))
	write(cacheRoot, "media/example_remote_a/RJ00000000/notes.txt", []byte("cached text\n"))
	write(cacheRoot, "media/example_remote_a/RJ00000000/cover.png", append([]byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}, []byte("synthetic image bytes")...))
	return mediaTextFixture{server: NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})}
}

func (fixture mediaTextFixture) text(id string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/api/media/"+id+"/text", nil)
	request.SetPathValue("id", id)
	response := httptest.NewRecorder()
	fixture.server.serveMediaText(response, request)
	return response
}

// A text file previews from wherever its bytes are: the library, the cache, or
// the remote source it is tracked from.
func TestServeMediaTextReadsLocalCacheAndRemoteLocations(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests++
		if r.URL.Path != "/media/notes.txt" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte("remote text\n"))
	}))
	defer upstream.Close()
	fixture := newMediaTextFixture(t, upstream.URL)

	for id, want := range map[string]string{"1": "local text\n", "2": "cached text\n", "3": "remote text\n"} {
		response := fixture.text(id)
		var result struct {
			Content string `json:"content"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusOK || result.Content != want {
			t.Fatalf("location %s text = %d %q, want %q (%s)", id, response.Code, result.Content, want, response.Body.String())
		}
	}
	if upstreamRequests != 1 {
		t.Fatalf("upstream requests = %d, want only the remote location to reach the source", upstreamRequests)
	}
}

// The stored URL of a remote location is untrusted: it is requested only when
// it stays on the source's configured origin, and only for an enabled source.
func TestServeMediaTextKeepsRemoteLocationsOnTheConfiguredSource(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests++
		_, _ = w.Write([]byte("not reachable"))
	}))
	defer upstream.Close()
	fixture := newMediaTextFixture(t, upstream.URL)

	if response := fixture.text("4"); response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "remote text URL is not allowed") {
		t.Fatalf("off-origin location = %d %s", response.Code, response.Body.String())
	}
	if response := fixture.text("5"); response.Code != http.StatusNotFound {
		t.Fatalf("disabled-source location = %d %s", response.Code, response.Body.String())
	}
	if response := fixture.text("999"); response.Code != http.StatusNotFound {
		t.Fatalf("missing location = %d %s", response.Code, response.Body.String())
	}
	if upstreamRequests != 0 {
		t.Fatalf("upstream requests = %d, want none", upstreamRequests)
	}
}

func TestServeMediaTextBoundsRemoteResponses(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("a", maxTextPreviewBytes+1)))
	}))
	defer upstream.Close()
	fixture := newMediaTextFixture(t, upstream.URL)

	response := fixture.text("3")
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "too large") {
		t.Fatalf("oversized remote text = %d (%d bytes)", response.Code, response.Body.Len())
	}
}

func TestServeMediaAssetServesCachedImages(t *testing.T) {
	fixture := newMediaTextFixture(t, "https://source.example.invalid")
	request := httptest.NewRequest(http.MethodGet, "/api/media/6/asset", nil)
	request.SetPathValue("id", "6")
	response := httptest.NewRecorder()
	fixture.server.serveMediaAsset(response, request)

	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("cached image = %d %q", response.Code, response.Header().Get("Content-Type"))
	}
}

// The remote text endpoint accepts exactly the files the interface offers a
// text preview for: every text extension the local endpoint reads, plus any
// file the source itself lists as text.
func TestGetRemoteSourceWorkTextAcceptsEveryPreviewableTextFile(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("synthetic text\n"))
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/01.lrc")
	key := server.remoteWorkCacheKey(context.Background(), 7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	accepted := []string{".txt", ".md", ".json", ".lrc", ".cue", ".srt", ".vtt", ".ass", ".csv", ".log", ".ini", ".yaml", ".yml"}
	snapshot.Tracks = []kikoeru.Track{
		{Type: "text", Title: "listed-as-text.nfo", MediaStreamURL: upstream.URL + "/media/file"},
		{Type: "audio", Title: "track.mp3", MediaStreamURL: upstream.URL + "/media/file"},
		{Type: "other", Title: "archive.zip", MediaStreamURL: upstream.URL + "/media/file"},
	}
	for _, extension := range accepted {
		snapshot.Tracks = append(snapshot.Tracks, kikoeru.Track{Type: "other", Title: "file" + extension, MediaStreamURL: upstream.URL + "/media/file"})
	}
	server.remoteWorkTracksCache[key] = snapshot

	status := func(path string) int {
		response := httptest.NewRecorder()
		server.getRemoteSourceWorkText(response, remoteTextPreviewRequest(path))
		return response.Code
	}
	for _, extension := range accepted {
		if got := status("file" + extension); got != http.StatusOK {
			t.Fatalf("file%s = %d, want a text preview", extension, got)
		}
	}
	if got := status("listed-as-text.nfo"); got != http.StatusOK {
		t.Fatalf("a file the source lists as text = %d, want a text preview", got)
	}
	for _, path := range []string{"track.mp3", "archive.zip"} {
		if got := status(path); got != http.StatusNotFound {
			t.Fatalf("%s = %d, want no text preview", path, got)
		}
	}
}
