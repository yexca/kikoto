package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// Without anonymous remote browsing, a visitor without an account reaches
// local content only: works with a local folder and local folder files. Remote
// catalogs, remote and cache files, source listings, remote-only works, and
// the remote presence of local works need an account.
func TestAnonymousVisitorReachesLocalContentOnly(t *testing.T) {
	db := openMigratedTestDB(t)
	execFetchTestStatements(t, db,
		`INSERT INTO app_setting (key, value_json) VALUES ('anonymous_access_enabled', 'true')`,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder'), (2, 'example_remote', 'Example Remote', 'kikoeru_compatible')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000020', 'Local Work'), (2, 'RJ00000021', 'Remote Work')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (1, 1, 'local', 'available'), (1, 2, 'source', 'available'), (2, 2, 'tracked', 'available')`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Track'), (2, 2, 'audio', 'Track')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(1, 1, 1, 'local', 'RJ00000020/track.mp3', 'available'),
			(2, 1, 2, 'remote_stream', 'track.mp3', 'available'),
			(3, 1, 2, 'cache', 'example_remote/RJ00000020/track.mp3', 'available'),
			(4, 2, 2, 'remote_stream', 'track.mp3', 'available')`,
	)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	handler := server.Routes()
	get := func(path string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		return response
	}

	for _, path := range []string{
		"/api/library-sources",
		"/api/remote-sources/2/works",
		"/api/works/RJ00000020/source-availability",
		"/api/voices/1/remote-matches",
		"/api/media/2/stream",
		"/api/media/3/download",
		"/api/media/4/playback",
		"/api/works/2",
		"/api/works/2/media",
		"/api/works/RJ00000021/resolve",
	} {
		if response := get(path); response.Code != http.StatusUnauthorized {
			t.Errorf("anonymous %s = %d, want 401", path, response.Code)
		}
	}

	var page struct {
		Works []struct {
			PrimaryCode    string               `json:"primaryCode"`
			SourcePresence []sourcePresenceItem `json:"sourcePresence"`
		} `json:"works"`
	}
	response := get("/api/works")
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != http.StatusOK {
		t.Fatalf("library = %d %s", response.Code, response.Body.String())
	}
	if len(page.Works) != 1 || page.Works[0].PrimaryCode != "RJ00000020" {
		t.Fatalf("anonymous library = %+v, want only the local work", page.Works)
	}
	for _, presence := range page.Works[0].SourcePresence {
		if presence.Type != "local" {
			t.Fatalf("anonymous library card shows a %s presence", presence.Type)
		}
	}

	var detail struct {
		SourcePresence []sourcePresenceItem `json:"sourcePresence"`
		MediaItems     []struct {
			Locations []fileLocationDetail `json:"locations"`
		} `json:"mediaItems"`
	}
	response = get("/api/works/1")
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil || response.Code != http.StatusOK {
		t.Fatalf("local work = %d %s", response.Code, response.Body.String())
	}
	for _, presence := range detail.SourcePresence {
		if presence.Type != "local" {
			t.Fatalf("anonymous work detail shows a %s presence", presence.Type)
		}
	}
	for _, item := range detail.MediaItems {
		for _, location := range item.Locations {
			if location.LocationType != "local" {
				t.Fatalf("anonymous work detail lists a %s location", location.LocationType)
			}
		}
	}

	// The queue resolve is a read: it answers a visitor, with local works and
	// local locations only, so the local work's cached and remote copies never
	// stand in for its local file.
	resolveResponse := httptest.NewRecorder()
	handler.ServeHTTP(resolveResponse, httptest.NewRequest(http.MethodPost, "/api/playback/queue/resolve", strings.NewReader(
		`{"items":[{"mediaItemId":1,"workId":1,"locationId":3},{"mediaItemId":2,"workId":2,"locationId":4}]}`,
	)))
	var resolved playbackQueueResolveResponse
	if err := json.Unmarshal(resolveResponse.Body.Bytes(), &resolved); err != nil || resolveResponse.Code != http.StatusOK {
		t.Fatalf("anonymous queue resolve = %d %s", resolveResponse.Code, resolveResponse.Body.String())
	}
	if len(resolved.Items) != 2 || resolved.Items[0].Status == playbackQueueItemMissing || resolved.Items[1].Status != playbackQueueItemMissing {
		t.Fatalf("anonymous queue resolve = %+v, want the local work resolved and the remote-only work missing", resolved.Items)
	}
	if track := resolved.Items[0].Track; track != nil {
		for _, location := range track.Locations {
			if location.LocationType != "local" {
				t.Fatalf("anonymous queue resolve lists a %s location", location.LocationType)
			}
		}
	}

	// With anonymous remote browsing on, remote content is reachable again.
	if _, err := db.Exec(`INSERT INTO user_account (id, username, role) VALUES (1, 'example-admin', 'super_admin')`); err != nil {
		t.Fatal(err)
	}
	if _, err := server.accessPolicy.UpdateRemoteBrowsing(context.Background(), 1, true); err != nil {
		t.Fatal(err)
	}
	if response := get("/api/works/2"); response.Code == http.StatusUnauthorized {
		t.Fatalf("remote work with anonymous remote browsing on = %d", response.Code)
	}
}
