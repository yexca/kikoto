package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

const lyricsFetchVTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSynthetic translated line\n"

type lyricsFetchFixture struct {
	server   *Server
	db       *sqlutil.DB
	dataRoot string
	workID   int64
	audioID  int64
	folderID int64
	root     string
	requests *atomic.Int32
	// pool holds the origin edition's folder and siblingPool the folders the
	// fixture adds for the sibling edition; both are empty in standard mode.
	pool        string
	siblingPool string
}

// newLyricsFetchFixture builds a scanned local origin edition, a translated
// sibling edition known only as metadata, and a configured remote source whose
// cached tree lists the sibling's lyrics at textURL.
func newLyricsFetchFixture(t *testing.T, handler http.HandlerFunc, textURL func(upstream string) string) lyricsFetchFixture {
	t.Helper()
	return buildLyricsFetchFixture(t, handler, textURL, false)
}

// lyricsFetchTestPools are the storage pools of a pool-mode fixture: the
// origin edition lives on the first and the sibling edition on the second.
var lyricsFetchTestPools = []storagepool.Pool{{Path: "disk1", ID: "pool-disk1"}, {Path: "disk2", ID: "pool-disk2"}}

// newPoolLyricsFetchFixture builds the fixture in a library in storage pool
// mode, with the origin and sibling editions on different online pools.
func newPoolLyricsFetchFixture(t *testing.T, handler http.HandlerFunc, textURL func(upstream string) string) lyricsFetchFixture {
	t.Helper()
	return buildLyricsFetchFixture(t, handler, textURL, true)
}

func buildLyricsFetchFixture(t *testing.T, handler http.HandlerFunc, textURL func(upstream string) string, pools bool) lyricsFetchFixture {
	t.Helper()
	requests := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		handler(w, r)
	}))
	t.Cleanup(upstream.Close)

	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	fixture := lyricsFetchFixture{db: db, dataRoot: dataRoot, requests: requests}
	if pools {
		fixture.pool, fixture.siblingPool = lyricsFetchTestPools[0].Path, lyricsFetchTestPools[1].Path
		for _, pool := range lyricsFetchTestPools {
			if err := os.MkdirAll(filepath.Join(dataRoot, pool.Path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := storagepool.WriteMarker(filepath.Join(dataRoot, pool.Path), pool.ID); err != nil {
				t.Fatal(err)
			}
		}
		encoded, err := json.Marshal(lyricsFetchTestPools)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE app_setting SET value_json = '"pools"' WHERE key = 'library_mode'`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO app_setting (key, value_json) VALUES ('storage_pools', ?)", string(encoded)); err != nil {
			t.Fatal(err)
		}
	} else if err := storagepool.WriteMarker(dataRoot, "synthetic-library"); err != nil {
		t.Fatal(err)
	}
	audioDir := filepath.Join(dataRoot, fixture.pool, "RJ00000001", "mp3")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(audioDir, "Track1.Original name.mp3"), []byte("synthetic audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	fixture.server = server
	executeLocalScanForTest(t, server)

	ctx := context.Background()
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

const (
	lyricsEditRemotePath = "Translated/Track1.Translated name.mp3.vtt"
	lyricsEditRemoteKey  = "remote:7:RJ00000002:" + lyricsEditRemotePath
)

// remoteAddition adds the sibling edition's lyrics file from the configured
// remote source, declared as language.
func lyricsEditRemoteAddition(language string) map[string]any {
	return map[string]any{"kind": "remote", "sourceId": 7, "remoteCode": "RJ00000002", "path": lyricsEditRemotePath, "language": language}
}

func lyricsEditFolderAddition(file string, language string) map[string]any {
	return map[string]any{"kind": "folder", "path": file, "language": language}
}

func (fixture lyricsFetchFixture) request(t *testing.T, suffix string, handler http.HandlerFunc, body map[string]any, permissions ...string) *httptest.ResponseRecorder {
	t.Helper()
	if len(permissions) == 0 {
		permissions = []string{"downloads:manage", "library:write"}
	}
	payload := map[string]any{"folderId": fixture.folderID}
	for key, value := range body {
		payload[key] = value
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	workID := jsonNumber(fixture.workID)
	request := httptest.NewRequest(http.MethodPost, "/api/works/"+workID+"/lyrics-edit"+suffix, strings.NewReader(string(encoded)))
	request.SetPathValue("id", workID)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 0, Permissions: permissions}))
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

// edit applies a lyrics edit of the fixture's folder.
func (fixture lyricsFetchFixture) edit(t *testing.T, body map[string]any, permissions ...string) *httptest.ResponseRecorder {
	t.Helper()
	return fixture.request(t, "", fixture.server.applyWorkLyricsEdit, body, permissions...)
}

// plan previews a lyrics edit of the fixture's folder.
func (fixture lyricsFetchFixture) plan(t *testing.T, body map[string]any) lyricsEditPlan {
	t.Helper()
	response := fixture.request(t, "/plan", fixture.server.planWorkLyricsEdit, body)
	if response.Code != http.StatusOK {
		t.Fatalf("plan status = %d, body = %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "127.0.0.1") || strings.Contains(response.Body.String(), fixture.dataRoot) {
		t.Fatalf("plan exposes a URL or an absolute path: %s", response.Body.String())
	}
	var plan lyricsEditPlan
	if err := json.Unmarshal(response.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	return plan
}

// write puts files, named by their path below the folder, into the fixture's
// folder and indexes them. Files below the lyrics folder go into a lyrics
// folder Kikoto created.
func (fixture lyricsFetchFixture) write(t *testing.T, files map[string]string) {
	t.Helper()
	for file, content := range files {
		if strings.HasPrefix(file, localfs.LyricsRootName+"/") {
			ownLyricsRoot(t, fixture.absolute(""))
		}
		absolute := fixture.absolute(file)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var fileSourceID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE id = ?", fixture.folderID).Scan(&fileSourceID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.indexLocalMediaForWork(context.Background(), fixture.workID, fileSourceID, fixture.root); err != nil {
		t.Fatal(err)
	}
}

func (fixture lyricsFetchFixture) absolute(file string) string {
	return filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), filepath.FromSlash(file))
}

// content returns a file of the folder, or "" when it is not there.
func (fixture lyricsFetchFixture) content(file string) string {
	content, err := os.ReadFile(fixture.absolute(file))
	if err != nil {
		return ""
	}
	return string(content)
}

// location returns the available local location and the media item of a file
// of the folder.
func (fixture lyricsFetchFixture) location(t *testing.T, file string) (int64, int64) {
	t.Helper()
	var locationID, mediaItemID int64
	if err := fixture.db.QueryRow(
		"SELECT id, media_item_id FROM media_file_location WHERE path = ? AND availability = 'available'", fixture.root+"/"+file,
	).Scan(&locationID, &mediaItemID); err != nil {
		t.Fatalf("location of %q: %v", file, err)
	}
	return locationID, mediaItemID
}

func jsonNumber(value int64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

// lyricsFolders returns the language folders inside the folder's lyrics
// folder.
func (fixture lyricsFetchFixture) lyricsFolders(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(fixture.absolute(localfs.LyricsRootName))
	if errors.Is(err, os.ErrNotExist) {
		return []string{}
	}
	if err != nil {
		t.Fatal(err)
	}
	folders := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			folders = append(folders, entry.Name())
		}
	}
	return folders
}

// ownLyricsRoot creates the lyrics folder of the work folder at workRoot as
// Kikoto does.
func ownLyricsRoot(t *testing.T, workRoot string) {
	t.Helper()
	if err := os.MkdirAll(workRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensureLyricsRoot(workRoot); err != nil {
		t.Fatal(err)
	}
}

func (fixture lyricsFetchFixture) decode(t *testing.T, response *httptest.ResponseRecorder) lyricsEditResult {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result lyricsEditResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

// assignedLanguages lists the track's library lyrics whose file is in the
// library, as "language=origin:path".
func (fixture lyricsFetchFixture) assignedLanguages(t *testing.T) []string {
	t.Helper()
	rows, err := fixture.db.Query(`
		SELECT assignment.language, assignment.origin, location.path
		FROM media_lyrics_assignment AS assignment
		INNER JOIN media_file_location AS location ON location.media_item_id = assignment.lyrics_media_item_id
		WHERE assignment.audio_media_item_id = ? AND location.availability = 'available'
		ORDER BY assignment.language
	`, fixture.audioID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	result := []string{}
	for rows.Next() {
		var language, origin, lyricsPath string
		if err := rows.Scan(&language, &origin, &lyricsPath); err != nil {
			t.Fatal(err)
		}
		result = append(result, language+"="+origin+":"+lyricsPath)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func serveLyricsFetchVTT(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/media/1.vtt" {
		http.NotFound(w, r)
		return
	}
	_, _ = w.Write([]byte(lyricsFetchVTT))
}

func lyricsFetchVTTURL(upstream string) string { return upstream + "/media/1.vtt" }

func (fixture lyricsFetchFixture) assertNoStagingLeft(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(fixture.dataRoot, fixture.pool, ".kikoto-staging"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "lyrics-") {
			t.Fatalf("lyrics staging %q was left behind", entry.Name())
		}
	}
}
