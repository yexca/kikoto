package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	mediaRequest := httptest.NewRequest(http.MethodGet, "/api/works/11/media", nil)
	mediaRequest.SetPathValue("id", "11")
	mediaRequest = mediaRequest.WithContext(context.WithValue(mediaRequest.Context(), currentUserKey, currentUser{ID: 7, Permissions: []string{"library:read"}}))
	mediaResponse := httptest.NewRecorder()
	server.getWorkMedia(mediaResponse, mediaRequest)
	if mediaResponse.Code != http.StatusOK || !strings.Contains(mediaResponse.Body.String(), `"preferredLyricsMediaItemId":22`) {
		t.Fatalf("media endpoint status = %d, body = %s", mediaResponse.Code, mediaResponse.Body.String())
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

func TestEnsureLocalMediaIndexedIndexesRequestedEditionDespiteSiblingMedia(t *testing.T) {
	dataRoot := t.TempDir()
	originPath := filepath.Join(dataRoot, "RJ00000005")
	translationPath := filepath.Join(dataRoot, "RJ00000006")
	for _, path := range []string{originPath, translationPath} {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(translationPath, "translated.mp3"), []byte("translated audio"), 0o644); err != nil {
		t.Fatal(err)
	}

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(81, 'RJ00000005', 'Origin work'),
			(82, 'RJ00000006', 'Translated work');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (81, 81, 'RJ00000005');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical) VALUES
			(81, 81, 'RJ00000005', 'RJ00000005', 'JPN', 1),
			(82, 81, 'RJ00000006', 'RJ00000005', 'ENG', 0);
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (91, 'edition-local', 'Edition local', 'local_folder');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability, raw_json) VALUES
			(81, 91, 'local', 'RJ00000005', 'available', '{"file_tree_scanned":true}'),
			(82, 91, 'local', 'RJ00000006', 'available', '{"file_tree_scanned":false}');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (101, 81, 'audio', 'Origin track', 'origin-track');
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (101, 91, 'local', 'RJ00000005/origin.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{DataRoot: dataRoot})
	before, err := server.loadLogicalWorkTranslations(context.Background(), "RJ00000005")
	if err != nil {
		t.Fatal(err)
	}
	if state := translationMediaStateForCode(before, "RJ00000006"); state != workMediaStatePresentUnindexed {
		t.Fatalf("translation state before indexing = %q, want %q", state, workMediaStatePresentUnindexed)
	}
	if err := server.ensureLocalMediaIndexed(context.Background(), 82); err != nil {
		t.Fatal(err)
	}

	var translatedLocations int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = 82 AND location.location_type = 'local' AND location.availability = 'available'
	`).Scan(&translatedLocations); err != nil {
		t.Fatal(err)
	}
	if translatedLocations != 1 {
		t.Fatalf("translated locations = %d, want 1", translatedLocations)
	}
	after, err := server.loadLogicalWorkTranslations(context.Background(), "RJ00000005")
	if err != nil {
		t.Fatal(err)
	}
	if state := translationMediaStateForCode(after, "RJ00000006"); state != workMediaStateIndexedAvailable {
		t.Fatalf("translation state after indexing = %q, want %q", state, workMediaStateIndexedAvailable)
	}
}

func TestLoadWorkTranslationsPromotesMaterializedEditionMediaState(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(83, 'RJ00000007', 'Origin work'),
			(84, 'RJ00000008', 'Translated work');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (83, 83, 'RJ00000007');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical, translation_kind) VALUES
			(83, 83, 'RJ00000007', 'RJ00000007', 'JPN', 1, 'origin'),
			(84, 83, 'RJ00000008', 'RJ00000007', 'ENG', 0, 'third_party');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (92, 'translated-local', 'Translated local', 'local_folder');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability, raw_json)
		VALUES (84, 92, 'local', 'RJ00000008', 'available', '{"file_tree_scanned":false}');
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	translations, err := server.loadWorkTranslations(context.Background(), "RJ00000007", "RJ00000007", []workTranslation{
		{PrimaryCode: "RJ00000007", MetadataLanguage: "JPN", Origin: true, TranslationKind: "origin"},
		{PrimaryCode: "RJ00000008", MetadataLanguage: "ENG", TranslationKind: "unknown"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if state := translationMediaStateForCode(translations, "RJ00000008"); state != workMediaStatePresentUnindexed {
		t.Fatalf("merged translation state = %q, want %q", state, workMediaStatePresentUnindexed)
	}
	for _, item := range translations {
		if item.PrimaryCode == "RJ00000008" && item.TranslationKind != "third_party" {
			t.Fatalf("merged translation kind = %q, want third_party", item.TranslationKind)
		}
	}
}

func TestLoadWorkTranslationsOnlyResolvesDeclaredLegacyCodes(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(85, 'RJ00000009', 'Legacy origin'),
			(86, 'RJ00000010', 'Declared translation'),
			(87, 'RJ00000011', 'Unrelated snapshot');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (93, 'legacy-local', 'Legacy local', 'local_folder');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability, raw_json)
		VALUES (86, 93, 'local', 'RJ00000010', 'available', '{"file_tree_scanned":false}');
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		SELECT 87, id, 'RJ00000011', '{"product_id":"RJ00000011","base_code":"RJ00000009","language":"ENG"}'
		FROM metadata_provider WHERE code = 'dlsite';
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	translations, err := server.loadWorkTranslations(context.Background(), "RJ00000009", "RJ00000009", []workTranslation{
		{PrimaryCode: "RJ00000009", MetadataLanguage: "JPN", Origin: true, TranslationKind: "origin"},
		{PrimaryCode: "RJ00000010", MetadataLanguage: "ENG", TranslationKind: "official"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(translations) != 2 {
		t.Fatalf("translations = %+v, want only the two declared codes", translations)
	}
	if state := translationMediaStateForCode(translations, "RJ00000010"); state != workMediaStatePresentUnindexed {
		t.Fatalf("declared translation state = %q, want %q", state, workMediaStatePresentUnindexed)
	}
	for _, item := range translations {
		if item.PrimaryCode == "RJ00000011" {
			t.Fatalf("unrelated snapshot was included: %+v", item)
		}
	}
}

func TestResolveMediaWorkIDForRequestUsesMediaBearingEdition(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(51, 'RJ00000000', 'Origin work'),
			(52, 'RJ00000001', 'Media edition');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (51, 51, 'RJ00000000');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(51, 51, 'RJ00000000', 'RJ00000000', 1),
			(52, 51, 'RJ00000001', 'RJ00000000', 0);
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (53, 'media-edition', 'Media edition', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (54, 52, 'audio', 'Track', 'edition-track');
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (54, 53, 'local', 'RJ00000001/track.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	mediaWorkID, err := server.resolveMediaWorkIDForRequest(context.Background(), 51)
	if err != nil {
		t.Fatal(err)
	}
	if mediaWorkID != 52 {
		t.Fatalf("media work id = %d, want 52", mediaWorkID)
	}
}

func TestResolveMediaWorkIDForRequestDoesNotFallbackFromSelectedTranslation(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(61, 'RJ00000003', 'Origin work'),
			(62, 'RJ00000004', 'Selected translation');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (61, 61, 'RJ00000003');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(61, 61, 'RJ00000003', 'RJ00000003', 1),
			(62, 61, 'RJ00000004', 'RJ00000003', 0);
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (63, 'origin-media', 'Origin media', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (64, 61, 'audio', 'Origin track', 'origin-track-71');
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (64, 63, 'local', 'RJ00000003/track.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	mediaWorkID, err := server.resolveMediaWorkIDForRequest(context.Background(), 62)
	if err != nil {
		t.Fatal(err)
	}
	if mediaWorkID != 62 {
		t.Fatalf("media work id = %d, want selected translation 62", mediaWorkID)
	}
}

func translationMediaStateForCode(items []workTranslation, code string) string {
	for _, item := range items {
		if item.PrimaryCode == code {
			return item.MediaState
		}
	}
	return ""
}

func TestIndexLocalMediaForWorkCoalescesConcurrentRequests(t *testing.T) {
	dataRoot := t.TempDir()
	workPath := filepath.Join(dataRoot, "RJ00000002")
	if err := os.MkdirAll(workPath, 0o755); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 100; index++ {
		name := filepath.Join(workPath, fmt.Sprintf("note-%03d.txt", index))
		if err := os.WriteFile(name, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (61, 'RJ00000002', 'Concurrent index work');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (71, 'concurrent-local', 'Concurrent local', 'local_folder');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability, raw_json)
		VALUES (61, 71, 'local', 'RJ00000002', 'available', '{"file_tree_scanned":false}');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	start := make(chan struct{})
	errorsByWorker := make(chan error, 8)
	var workers sync.WaitGroup
	for index := 0; index < 8; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			errorsByWorker <- server.indexLocalMediaForWork(context.Background(), 61, 71, "RJ00000002")
		}()
	}
	close(start)
	workers.Wait()
	close(errorsByWorker)
	for err := range errorsByWorker {
		if err != nil {
			t.Fatal(err)
		}
	}
	var mediaItems int
	var fingerprints int
	var locations int
	if err := db.QueryRow("SELECT COUNT(*), COUNT(DISTINCT fingerprint) FROM media_item WHERE work_id = 61").Scan(&mediaItems, &fingerprints); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = 61 AND location.file_source_id = 71
	`).Scan(&locations); err != nil {
		t.Fatal(err)
	}
	if mediaItems != 100 || fingerprints != 100 || locations != 100 {
		t.Fatalf("indexed media = %d, fingerprints = %d, locations = %d; want 100 each", mediaItems, fingerprints, locations)
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
