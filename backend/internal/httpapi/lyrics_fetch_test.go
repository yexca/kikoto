package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

const lyricsFetchVTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSynthetic translated line\n"

type lyricsFetchFixture struct {
	server   *Server
	db       *sql.DB
	dataRoot string
	workID   int64
	audioID  int64
	folderID int64
	root     string
	requests *atomic.Int32
}

// newLyricsFetchFixture builds a scanned local origin edition, a translated
// sibling edition known only as metadata, and a configured remote source whose
// cached tree lists the sibling's lyrics at textURL.
func newLyricsFetchFixture(t *testing.T, handler http.HandlerFunc, textURL func(upstream string) string) lyricsFetchFixture {
	t.Helper()
	requests := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		handler(w, r)
	}))
	t.Cleanup(upstream.Close)

	dataRoot := t.TempDir()
	audioDir := filepath.Join(dataRoot, "RJ00000001", "mp3")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(audioDir, "Track1.Original name.mp3"), []byte("synthetic audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := storagepool.WriteMarker(dataRoot, "synthetic-library"); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	executeLocalScanForTest(t, server)

	ctx := context.Background()
	fixture := lyricsFetchFixture{server: server, db: db, dataRoot: dataRoot, requests: requests}
	var fileSourceID int64
	if err := db.QueryRow(`
		SELECT folder.id, folder.work_id, folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN work ON work.id = folder.work_id
		WHERE work.primary_code = 'RJ00000001'
	`).Scan(&fixture.folderID, &fixture.workID, &fileSourceID, &fixture.root); err != nil {
		t.Fatal(err)
	}
	if err := server.indexLocalMediaForWork(ctx, fixture.workID, fileSourceID, fixture.root); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT id FROM media_item WHERE work_id = ? AND kind = 'audio'", fixture.workID).Scan(&fixture.audioID); err != nil {
		t.Fatal(err)
	}
	// One statement per Exec: placeholders do not bind across statements.
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{query: "INSERT INTO work (id, primary_code, title) VALUES (902, 'RJ00000002', 'Example Work 2'), (903, 'RJ00000003', 'Example Work 3')"},
		{query: "INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (?, ?, 'RJ00000001')", args: []any{fixture.workID, fixture.workID}},
		{query: `INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical) VALUES
			(?, ?, 'RJ00000001', 'RJ00000001', 'JPN', 1),
			(902, ?, 'RJ00000002', 'RJ00000001', 'CHI_HANS', 0)`, args: []any{fixture.workID, fixture.workID, fixture.workID}},
		{query: "INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)"},
		{query: "INSERT INTO file_source_endpoint (file_source_id, api_url, base_url, restrict_outbound_hosts) VALUES (7, ?, ?, 1)", args: []any{upstream.URL, upstream.URL}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	source, err := server.currentRemoteCacheSource(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	for _, code := range []string{"RJ00000002", "RJ00000003"} {
		work := kikoeru.Work{ID: 70, SourceID: code, Title: "Example Work"}
		tracks := []kikoeru.Track{
			{Type: "folder", Title: "Translated", Children: []kikoeru.Track{
				{Type: "text", Title: "Track1.Translated name.mp3.vtt", MediaDownloadURL: textURL(upstream.URL)},
				{Type: "audio", Title: "Track1.Translated name.mp3", MediaDownloadURL: upstream.URL + "/media/audio.mp3"},
			}},
		}
		key := remoteWorkCacheKeyForLanguages(source.ID, code, server.instanceMetadataLanguages(ctx))
		expiresAt := time.Now().Add(time.Minute)
		server.remoteWorkCache[key] = remoteWorkSnapshot{Source: source, Work: work, ExpiresAt: expiresAt}
		server.remoteWorkTracksCache[key] = remoteWorkTracksSnapshot{Source: source, Work: work, Tracks: tracks, ExpiresAt: expiresAt}
	}
	return fixture
}

func (fixture lyricsFetchFixture) post(t *testing.T, body map[string]any, permissions ...string) *httptest.ResponseRecorder {
	t.Helper()
	if len(permissions) == 0 {
		permissions = []string{"downloads:manage", "library:write"}
	}
	payload := map[string]any{
		"sourceId":   7,
		"remoteCode": "RJ00000002",
		"folderId":   fixture.folderID,
		"files":      []string{"Translated/Track1.Translated name.mp3.vtt"},
		"assignments": []map[string]any{
			{"audioMediaItemId": fixture.audioID, "path": "Translated/Track1.Translated name.mp3.vtt"},
		},
	}
	for key, value := range body {
		payload[key] = value
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	workID := jsonNumber(fixture.workID)
	request := httptest.NewRequest(http.MethodPost, "/api/works/"+workID+"/lyrics-fetch", strings.NewReader(string(encoded)))
	request.SetPathValue("id", workID)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 0, Permissions: permissions}))
	response := httptest.NewRecorder()
	fixture.server.fetchWorkLyrics(response, request)
	return response
}

func jsonNumber(value int64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func (fixture lyricsFetchFixture) lyricsFolders(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root)))
	if err != nil {
		t.Fatal(err)
	}
	folders := []string{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "Lyrics") {
			folders = append(folders, entry.Name())
		}
	}
	return folders
}

func (fixture lyricsFetchFixture) assertNoStagingLeft(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(fixture.dataRoot, ".kikoto-staging"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "lyrics-") {
			t.Fatalf("lyrics staging %q was left behind", entry.Name())
		}
	}
}

func TestLyricsFetchPublishesNewFolderAndAssigns(t *testing.T) {
	fixture := newLyricsFetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/media/1.vtt" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(lyricsFetchVTT))
	}, func(upstream string) string { return upstream + "/media/1.vtt" })

	response := fixture.post(t, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result lyricsFetchResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	folders := fixture.lyricsFolders(t)
	if len(folders) != 1 || !strings.HasPrefix(folders[0], "Lyrics - CHI_HANS - RJ00000002 - ") {
		t.Fatalf("lyrics folders = %v", folders)
	}
	if result.Folder != fixture.root+"/"+folders[0] || result.Downloaded != 1 || result.Assigned != 1 {
		t.Fatalf("result = %+v", result)
	}
	published := filepath.Join(fixture.dataRoot, filepath.FromSlash(result.Folder), "Translated", "Track1.Translated name.mp3.vtt")
	if content, err := os.ReadFile(published); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("published lyrics = %q, %v", content, err)
	}
	if fixture.requests.Load() != 1 {
		t.Fatalf("upstream requests = %d, want only the selected lyrics file", fixture.requests.Load())
	}
	var origin, lyricsPath string
	if err := fixture.db.QueryRow(`
		SELECT assignment.origin, location.path
		FROM media_lyrics_assignment AS assignment
		INNER JOIN media_file_location AS location ON location.media_item_id = assignment.lyrics_media_item_id
		WHERE assignment.audio_media_item_id = ?
	`, fixture.audioID).Scan(&origin, &lyricsPath); err != nil {
		t.Fatal(err)
	}
	if origin != "remote_fetch" || lyricsPath != result.Folder+"/Translated/Track1.Translated name.mp3.vtt" {
		t.Fatalf("assignment = %q -> %q", origin, lyricsPath)
	}
	var sibling int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_item WHERE work_id = 902").Scan(&sibling); err != nil || sibling != 0 {
		t.Fatalf("sibling edition gained media items: %d, %v", sibling, err)
	}
	fixture.assertNoStagingLeft(t)
}

func TestLyricsFetchClaimsAFolderWithoutReplacingExistingEntries(t *testing.T) {
	root := t.TempDir()
	base := "Lyrics - CHI_HANS - RJ00000002 - 20261008-153012"
	if err := os.Mkdir(filepath.Join(root, base), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, base, "keep.vtt"), []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, base+" (2)"), []byte("a file, not a folder"), 0o644); err != nil {
		t.Fatal(err)
	}
	name, absolute, err := claimLyricsFolder(root, base)
	if err != nil || name != base+" (3)" || absolute != filepath.Join(root, base+" (3)") {
		t.Fatalf("claimed %q at %q, err %v", name, absolute, err)
	}
	if content, err := os.ReadFile(filepath.Join(root, base, "keep.vtt")); err != nil || string(content) != "existing" {
		t.Fatalf("existing folder changed: %q, %v", content, err)
	}
	if info, err := os.Stat(filepath.Join(root, base+" (2)")); err != nil || info.IsDir() {
		t.Fatalf("existing file changed: %v, %v", info, err)
	}
	for attempt := 4; attempt <= lyricsFetchFolderAttempts; attempt++ {
		if _, _, err := claimLyricsFolder(root, base); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := claimLyricsFolder(root, base); err == nil {
		t.Fatal("claim succeeded after every candidate name was taken")
	}
}

func TestLyricsFolderNameIsPortable(t *testing.T) {
	now := time.Date(2026, 10, 8, 15, 30, 12, 0, time.UTC)
	if got := lyricsFolderName("chi_hans", "RJ00000002", now); got != "Lyrics - CHI_HANS - RJ00000002 - 20261008-153012" {
		t.Fatalf("folder name = %q", got)
	}
	if got := lyricsFolderName("../x:y", "RJ00000002", now); got != "Lyrics - XY - RJ00000002 - 20261008-153012" {
		t.Fatalf("unsafe language produced %q", got)
	}
}

func TestLyricsFetchRejectsUnsafeRequestsWithoutWriting(t *testing.T) {
	okHandler := func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(lyricsFetchVTT)) }
	sameOrigin := func(upstream string) string { return upstream + "/media/1.vtt" }
	for _, testCase := range []struct {
		name         string
		handler      http.HandlerFunc
		textURL      func(string) string
		body         map[string]any
		permissions  []string
		status       int
		wantRequests int32
	}{
		{name: "edition outside the family", handler: okHandler, textURL: sameOrigin, body: map[string]any{"remoteCode": "RJ00000003"}, status: http.StatusBadRequest},
		{name: "file outside the remote tree", handler: okHandler, textURL: sameOrigin, body: map[string]any{"files": []string{"Translated/other.vtt"}, "assignments": []any{}}, status: http.StatusNotFound},
		{name: "non-lyrics file", handler: okHandler, textURL: sameOrigin, body: map[string]any{"files": []string{"Translated/Track1.Translated name.mp3"}, "assignments": []any{}}, status: http.StatusBadRequest},
		{name: "unconfigured host", handler: okHandler, textURL: func(string) string { return "https://media.invalid/1.vtt" }, status: http.StatusBadGateway},
		{name: "credentials in URL", handler: okHandler, textURL: func(upstream string) string {
			withCredentials, err := url.Parse(upstream + "/media/1.vtt")
			if err != nil {
				t.Fatal(err)
			}
			withCredentials.User = url.UserPassword("synthetic-user", "synthetic-password")
			return withCredentials.String()
		}, status: http.StatusBadGateway},
		{name: "redirect to another origin", handler: func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://media.invalid/1.vtt", http.StatusFound)
		}, textURL: sameOrigin, status: http.StatusBadGateway, wantRequests: 1},
		{name: "oversized lyrics", handler: func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(strings.Repeat("x", maxLyricsFetchFileBytes+1)))
		}, textURL: sameOrigin, status: http.StatusBadRequest, wantRequests: 1},
		{name: "upstream error", handler: func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "synthetic failure", http.StatusInternalServerError)
		}, textURL: sameOrigin, status: http.StatusBadGateway, wantRequests: 1},
		{name: "assignment without library write", handler: okHandler, textURL: sameOrigin, permissions: []string{"downloads:manage"}, status: http.StatusForbidden},
		{name: "assignment of another work's audio", handler: okHandler, textURL: sameOrigin, body: map[string]any{"assignments": []map[string]any{{"audioMediaItemId": 999999, "path": "Translated/Track1.Translated name.mp3.vtt"}}}, status: http.StatusBadRequest},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			fixture := newLyricsFetchFixture(t, testCase.handler, testCase.textURL)
			response := fixture.post(t, testCase.body, testCase.permissions...)
			if response.Code != testCase.status {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, testCase.status, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "127.0.0.1") || strings.Contains(response.Body.String(), "media.invalid") || strings.Contains(response.Body.String(), fixture.dataRoot) {
				t.Fatalf("error exposes a URL or local path: %s", response.Body.String())
			}
			if got := fixture.requests.Load(); got != testCase.wantRequests {
				t.Fatalf("upstream requests = %d, want %d", got, testCase.wantRequests)
			}
			if folders := fixture.lyricsFolders(t); len(folders) != 0 {
				t.Fatalf("a rejected fetch created %v", folders)
			}
			fixture.assertNoStagingLeft(t)
		})
	}
}

func TestLyricsFetchStopsWhenCancelled(t *testing.T) {
	fixture := newLyricsFetchFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(lyricsFetchVTT))
	}, func(upstream string) string { return upstream + "/media/1.vtt" })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	source, err := fixture.server.currentRemoteCacheSource(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	target := lyricsFetchTarget{WorkID: fixture.workID, RootPath: fixture.root}
	files := []lyricsFetchFile{{RemotePath: "Translated/1.vtt", URL: "http://127.0.0.1:1/never"}}
	if _, err := fixture.server.downloadAndPublishLyrics(ctx, source, target, files, "Lyrics - cancelled"); err == nil {
		t.Fatal("a cancelled fetch published lyrics")
	}
	if folders := fixture.lyricsFolders(t); len(folders) != 0 {
		t.Fatalf("a cancelled fetch created %v", folders)
	}
	fixture.assertNoStagingLeft(t)
}
