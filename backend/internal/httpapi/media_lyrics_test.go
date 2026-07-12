package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLocalFileKindRecognizesSupportedLyrics(t *testing.T) {
	for _, path := range []string{"01_track.lrc", "01_track.srt", "01_track.mp3.vtt", "字幕.ass"} {
		if got := localFileKind(path); got != "text" {
			t.Fatalf("localFileKind(%q) = %q, want text", path, got)
		}
		if !isTextFile(path) {
			t.Fatalf("isTextFile(%q) = false", path)
		}
	}
}

func TestWorkDetailSeparatesMediaAndLoadsLyricsPreference(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO user_account (id, username, role) VALUES (7, 'listener', 'user')",
		"INSERT INTO work (id, primary_code, title) VALUES (11, 'RJTEST011', 'Progressive work')",
		"INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (21, 11, 'audio', 'Track', 'audio-21')",
		"INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (22, 11, 'text', 'Track lyrics', 'lyrics-22')",
		"INSERT INTO user_media_lyrics_preference (user_id, audio_media_item_id, lyrics_media_item_id) VALUES (7, 21, 22)",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	summary, err := server.loadWorkDetail(context.Background(), 7, 11, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.MediaItems) != 0 {
		t.Fatalf("summary media items = %d, want 0", len(summary.MediaItems))
	}
	detail, err := server.loadWorkDetail(context.Background(), 7, 11, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.MediaItems) != 2 || detail.MediaItems[0].PreferredLyricsMediaItemID == nil || *detail.MediaItems[0].PreferredLyricsMediaItemID != 22 {
		t.Fatalf("media preference was not loaded: %+v", detail.MediaItems)
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/media/21/lyrics-preference", nil)
	request.SetPathValue("id", "21")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 7, Permissions: []string{"playback:use"}}))
	response := httptest.NewRecorder()
	server.clearMediaLyricsPreference(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("clear preference status = %d, body = %s", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodPut, "/api/media/21/lyrics-preference", strings.NewReader(`{"lyricsMediaItemId":22}`))
	request.SetPathValue("id", "21")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 7, Permissions: []string{"playback:use"}}))
	response = httptest.NewRecorder()
	server.setMediaLyricsPreference(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("set preference status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestEnsureLocalMediaIndexedHonorsCompletedEmptyScan(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (31, 'RJTEST031', 'Empty work')",
		"INSERT INTO file_source (id, code, display_name, source_type) VALUES (41, 'empty-local', 'Empty local', 'local_folder')",
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability, raw_json)
		 VALUES (31, 41, 'local', 'missing-folder', 'available', '{"file_tree_scanned":true}')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{DataRoot: filepath.Join(t.TempDir(), "does-not-exist")})
	if err := server.ensureLocalMediaIndexed(context.Background(), 31); err != nil {
		t.Fatalf("completed empty scan was repeated: %v", err)
	}
}

func TestRefreshWorkLocalFilesForcesReindex(t *testing.T) {
	dataRoot := t.TempDir()
	workPath := filepath.Join(dataRoot, "RJTEST041")
	if err := os.MkdirAll(workPath, 0o755); err != nil {
		t.Fatal(err)
	}
	trackPath := filepath.Join(workPath, "track.mp3")
	if err := os.WriteFile(trackPath, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (41, 'RJTEST041', 'Refresh work')",
		"INSERT INTO file_source (id, code, display_name, source_type) VALUES (51, 'refresh-local', 'Refresh local', 'local_folder')",
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability, raw_json)
		 VALUES (41, 51, 'local', 'RJTEST041', 'available', '{"file_tree_scanned":true}')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	refresh := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/works/41/local-files/refresh", strings.NewReader(`{"fileSourceId":51}`))
		request.SetPathValue("id", "41")
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"downloads:manage"}}))
		response := httptest.NewRecorder()
		server.refreshWorkLocalFiles(response, request)
		return response
	}
	if response := refresh(); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"indexedFiles":1`) {
		t.Fatalf("initial refresh status = %d, body = %s", response.Code, response.Body.String())
	}
	if err := os.Remove(trackPath); err != nil {
		t.Fatal(err)
	}
	if response := refresh(); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"indexedFiles":0`) {
		t.Fatalf("second refresh status = %d, body = %s", response.Code, response.Body.String())
	}
	var availability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE file_source_id = 51").Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "missing" {
		t.Fatalf("removed file availability = %q, want missing", availability)
	}
}
