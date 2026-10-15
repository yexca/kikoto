package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"testing"
	"time"
)

func TestLLMLyricsTranslationJoinsTheTrackLyricsAndKeepsTheOriginal(t *testing.T) {
	f := newLyricsFetchFixture(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("Example")) }, func(origin string) string { return origin + "/example.vtt" })
	if _, err := f.db.Exec("INSERT INTO user_account(username,role) VALUES('synthetic-admin','admin')"); err != nil {
		t.Fatal(err)
	}
	var userID, sourceID int64
	_ = f.db.QueryRow("SELECT id FROM user_account WHERE username='synthetic-admin'").Scan(&userID)
	_ = f.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE id=?", f.folderID).Scan(&sourceID)
	_, _ = f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID)
	original := "[00:01.00]Example original\n[00:02.00]Second line\n"
	relative := filepath.ToSlash(filepath.Join(f.root, "example.lrc"))
	absolute := filepath.Join(f.dataRoot, filepath.FromSlash(relative))
	if err := os.WriteFile(absolute, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	item, err := f.db.Exec("INSERT INTO media_item(work_id,kind,title,fingerprint) VALUES(?,'text','Example lyrics','synthetic-lyrics')", f.workID)
	if err != nil {
		t.Fatal(err)
	}
	itemID, _ := item.LastInsertId()
	location, err := f.db.Exec("INSERT INTO media_file_location(media_item_id,file_source_id,location_type,path,availability) VALUES(?,?,'local',?,'available')", itemID, sourceID, relative)
	if err != nil {
		t.Fatal(err)
	}
	locationID, _ := location.LastInsertId()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"lyrics\":[\"Example translation\",\"Translated line\"]}"}}]}`))
	}))
	defer upstream.Close()
	fixture := manualOverrideFixture{db: f.db, server: f.server, userID: userID, workID: f.workID}
	p := llmTestProvider(t, fixture, upstream.URL, "external", "safe")

	// The track decides the work folder; another folder is refused.
	elsewhere := llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"lyrics"}, LyricsLocationID: locationID, AudioMediaItemID: f.audioID, FolderID: f.folderID + 1}
	body, _ := json.Marshal(elsewhere)
	w := httptest.NewRecorder()
	f.server.translateWorkWithLLM(w, llmTestRequest(fixture, "POST", string(body)))
	if w.Code != 422 {
		t.Fatalf("translate into another folder %d %s", w.Code, w.Body.String())
	}

	payload := llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"lyrics"}, LyricsLocationID: locationID, AudioMediaItemID: f.audioID}
	body, _ = json.Marshal(payload)
	w = httptest.NewRecorder()
	f.server.translateWorkWithLLM(w, llmTestRequest(fixture, "POST", string(body)))
	if w.Code != 200 {
		t.Fatalf("translate %d %s", w.Code, w.Body.String())
	}
	var preview struct {
		ID string `json:"previewId"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	f.server.applyLLMTranslation(w, llmTestRequest(fixture, "PUT", `{"previewId":"`+preview.ID+`"}`))
	if w.Code != 200 {
		t.Fatalf("apply %d %s", w.Code, w.Body.String())
	}
	source, err := os.ReadFile(absolute)
	if err != nil || string(source) != original {
		t.Fatalf("original was replaced: %q %v", source, err)
	}
	var assetPath, status string
	var lyricsID int64
	if err := f.db.QueryRow("SELECT relative_path,status,COALESCE(media_item_id,0) FROM llm_lyrics_asset WHERE id=?", preview.ID).Scan(&assetPath, &status, &lyricsID); err != nil {
		t.Fatal(err)
	}
	if want := path.Join(f.root, "lyrics_zh_hans", "mp3", "Track1.Original name.lrc"); assetPath != want || status != "accepted" {
		t.Fatalf("asset path=%q status=%q, want %q accepted", assetPath, status, want)
	}
	translated, err := os.ReadFile(filepath.Join(f.dataRoot, filepath.FromSlash(assetPath)))
	if err != nil || string(translated) != "[00:01.00]Example translation\n[00:02.00]Translated line\n" {
		t.Fatalf("translated file %q %v", translated, err)
	}
	var assigned int64
	var origin string
	if err := f.db.QueryRow("SELECT lyrics_media_item_id,origin FROM media_lyrics_assignment WHERE audio_media_item_id=? AND language='zh-cn'", f.audioID).Scan(&assigned, &origin); err != nil {
		t.Fatal(err)
	}
	if assigned != lyricsID || origin != "translation" {
		t.Fatalf("assignment lyrics=%d origin=%q, want %d translation", assigned, origin, lyricsID)
	}

	// Publication recovery uses the durable result, never the external
	// endpoint, and keeps a different file that took the track's name.
	if err := os.WriteFile(filepath.Join(f.dataRoot, filepath.FromSlash(assetPath)), []byte("different"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _ = f.db.Exec("UPDATE llm_lyrics_asset SET status='publishing' WHERE id=?", preview.ID)
	if err := f.server.publishLLMLyricsAsset(context.Background(), preview.ID); err != nil {
		t.Fatal(err)
	}
	_ = f.db.QueryRow("SELECT relative_path FROM llm_lyrics_asset WHERE id=?", preview.ID).Scan(&assetPath)
	if want := path.Join(f.root, "lyrics_zh_hans", "mp3", "Track1.Original name (2).lrc"); assetPath != want {
		t.Fatalf("republished at %q, want %q", assetPath, want)
	}
	if kept, _ := os.ReadFile(filepath.Join(f.dataRoot, f.root, "lyrics_zh_hans", "mp3", "Track1.Original name.lrc")); string(kept) != "different" {
		t.Fatalf("publication replaced another file: %q", kept)
	}
	if err := f.server.indexLocalMediaForWork(context.Background(), f.workID, sourceID, f.root); err != nil {
		t.Fatal(err)
	}
	var count int
	_ = f.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path=?", assetPath).Scan(&count)
	if count != 1 {
		t.Fatalf("indexing duplicated the translated lyrics: %d", count)
	}
}

func TestLLMLyricsTranslationStateFollowsReviewAndPublication(t *testing.T) {
	now := time.Unix(1_000, 0)
	for _, test := range []struct {
		task, preview string
		expires       int64
		asset, want   string
	}{
		{task: "requesting", want: "requesting"},
		{task: "uncertain", want: "uncertain"},
		{task: "ready", preview: "proposed", expires: 2_000, want: "ready"},
		{task: "ready", preview: "proposed", expires: 500, want: "expired"},
		{task: "ready", preview: "rejected", expires: 2_000, want: "rejected"},
		{task: "ready", preview: "accepted", expires: 2_000, asset: "publishing", want: "publishing"},
		{task: "ready", preview: "accepted", expires: 500, asset: "accepted", want: "accepted"},
	} {
		if got := llmLyricsTranslationState(test.task, test.preview, test.expires, test.asset, now); got != test.want {
			t.Errorf("state(%q,%q,%d,%q) = %q, want %q", test.task, test.preview, test.expires, test.asset, got, test.want)
		}
	}
}
