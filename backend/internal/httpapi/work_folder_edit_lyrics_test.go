package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

const folderEditManagedLyricsPath = "lyrics_kikoto/ja/Track1.vtt"

// siblingWithManagedLyrics gives the sibling edition a local folder whose
// lyrics folder Kikoto created and holds Japanese lyrics.
func (fixture folderEditFixture) siblingWithManagedLyrics(t *testing.T) int64 {
	t.Helper()
	sibling := filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002")
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensureLyricsRoot(sibling); err != nil {
		t.Fatal(err)
	}
	return fixture.addSiblingFolder(t, map[string]string{folderEditManagedLyricsPath: lyricsFetchVTT})
}

func TestWorkFolderEditCopiesManagedLyricsIntoAMarkedLyricsFolder(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.siblingWithManagedLyrics(t)
	body := map[string]any{"additions": []any{localAddition(siblingFolderID, folderEditManagedLyricsPath)}}

	plan := fixture.plan(t, body)
	if len(plan.Items) != 1 || plan.Items[0].TargetPath != fixture.root+"/"+folderEditManagedLyricsPath || plan.Items[0].Action != "copy_local" {
		t.Fatalf("plan items = %+v", plan.Items)
	}
	job := fixture.apply(t, body)
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(fixture.targetFile(folderEditManagedLyricsPath)); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("lyrics file = %q, %v", content, err)
	}
	if !lyricsRootOwned(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root))) {
		t.Fatal("the lyrics folder is not marked as Kikoto's")
	}
	fixture.assertNoEditStaging(t)
}

// An edit queued while edits still bound added lyrics to tracks adds its
// lyrics and reports the bindings it no longer stores, rather than dropping
// them silently.
func TestWorkFolderEditReportsLyricsBindingsQueuedBeforeTheUpdate(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.siblingWithManagedLyrics(t)
	job := fixture.apply(t, map[string]any{"additions": []any{localAddition(siblingFolderID, folderEditManagedLyricsPath)}})
	var payload map[string]any
	if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	items := payload["items"].([]any)
	payload["assignments"] = []any{map[string]any{"itemKey": items[0].(map[string]any)["itemKey"], "audioPath": folderEditAudioPath}}
	job.PayloadJSON = mustJSON(payload)
	if _, err := fixture.db.Exec("UPDATE workflow_job SET payload_json = ? WHERE id = ?", job.PayloadJSON, job.ID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(fixture.targetFile(folderEditManagedLyricsPath)); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("lyrics file = %q, %v", content, err)
	}
	var status string
	var notStored, events int
	if err := fixture.db.QueryRow(`
		SELECT status, CAST(json_extract(summary_json, '$.lyrics_bindings_not_stored') AS INTEGER),
			(SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = run.id AND event_type = 'work_folder_edit.lyrics_bindings_not_stored' AND level = 'warn')
		FROM workflow_run AS run WHERE id = ?
	`, job.RunID).Scan(&status, &notStored, &events); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || notStored != 1 || events != 1 {
		t.Fatalf("run = %s, %d bindings not stored, %d events", status, notStored, events)
	}
}

func TestWorkFolderEditNeverWritesIntoALyricsFolderItDidNotCreate(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.siblingWithManagedLyrics(t)
	if err := os.MkdirAll(fixture.targetFile("lyrics_kikoto"), 0o755); err != nil {
		t.Fatal(err)
	}
	response := fixture.request(t, fixture.server.planWorkFolderEdit, map[string]any{
		"additions": []any{localAddition(siblingFolderID, folderEditManagedLyricsPath)},
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("blocked lyrics folder: status = %d, body = %s", response.Code, response.Body.String())
	}

	// A file is never placed into the lyrics folder; lyrics of a language are
	// added in Manage lyrics.
	placed := remoteAddition("RJ00000002", folderEditVTTPath)
	placed["targetPath"] = "lyrics_kikoto/ja/Track1.vtt"
	response = fixture.request(t, fixture.server.planWorkFolderEdit, map[string]any{"additions": []any{placed}})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("placed into the lyrics folder: status = %d, body = %s", response.Code, response.Body.String())
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("a refused edit queued a run")
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("refused edits made %d upstream requests", fixture.requests.Load())
	}
}
