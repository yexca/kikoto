package httpapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func lyricsAddition(addition map[string]any, language string) map[string]any {
	addition["language"] = language
	return addition
}

func TestWorkFolderEditAddsLyricsAndAssignsThemAfterIndexing(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	var originalAudioID int64
	if err := fixture.db.QueryRow("SELECT media_item_id FROM media_file_location WHERE id = ?", fixture.originalLocationID).Scan(&originalAudioID); err != nil {
		t.Fatal(err)
	}
	lyricsKey := "remote:7:RJ00000002:" + folderEditVTTPath
	body := map[string]any{
		"additions": []any{
			lyricsAddition(remoteAddition("RJ00000002", folderEditVTTPath), "ja"),
			remoteAddition("RJ00000002", folderEditAudioPath),
		},
		"assignments": []any{
			map[string]any{"audioMediaItemId": originalAudioID, "itemKey": lyricsKey},
			// The added audio has no media item yet; it is named by its path.
			map[string]any{"audioPath": folderEditAudioPath, "itemKey": lyricsKey},
		},
	}

	plan := fixture.plan(t, body)
	lyricsTarget := fixture.root + "/lyrics_kikoto/ja/" + folderEditVTTPath
	if plan.Summary.Add != 2 || plan.Summary.Lyrics != 1 || plan.Summary.Conflict != 0 {
		t.Fatalf("plan summary = %+v", plan.Summary)
	}
	for _, item := range plan.Items {
		if item.ItemKey == lyricsKey && (item.TargetPath != lyricsTarget || item.Language == nil || *item.Language != "ja-jp") {
			t.Fatalf("lyrics item = %+v", item)
		}
	}

	if response := fixture.request(t, fixture.server.applyWorkFolderEdit, body, "downloads:manage", "remote:fetch"); response.Code != http.StatusForbidden {
		t.Fatalf("assigning without library:write: status = %d", response.Code)
	}
	response := fixture.request(t, fixture.server.applyWorkFolderEdit, body, "downloads:manage", "remote:fetch", "library:write")
	if response.Code != http.StatusAccepted {
		t.Fatalf("apply status = %d, body = %s", response.Code, response.Body.String())
	}
	var job workflowJobRecord
	if err := fixture.db.QueryRow("SELECT id, workflow_run_id, payload_json, checkpoint_json FROM workflow_job WHERE worker_type = ?", workFolderEditWorkerType).Scan(
		&job.ID, &job.RunID, &job.PayloadJSON, &job.CheckpointJSON,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET status = 'running' WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_run SET status = 'running' WHERE id = ?", job.RunID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(fixture.targetFile("lyrics_kikoto/ja/" + folderEditVTTPath)); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("lyrics file = %q, %v", content, err)
	}
	if !lyricsRootOwned(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root))) {
		t.Fatal("the lyrics folder is not marked as Kikoto's")
	}
	rows, err := fixture.db.Query(`
		SELECT assignment.language, assignment.origin, location.path
		FROM media_lyrics_assignment AS assignment
		INNER JOIN media_file_location AS location ON location.media_item_id = assignment.audio_media_item_id
			AND location.location_type = 'local' AND location.availability = 'available'
		INNER JOIN media_file_location AS lyrics ON lyrics.media_item_id = assignment.lyrics_media_item_id
			AND lyrics.location_type = 'local'
		WHERE lyrics.path = ?
		ORDER BY location.path
	`, lyricsTarget)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	assigned := []string{}
	for rows.Next() {
		var language, origin, audioPath string
		if err := rows.Scan(&language, &origin, &audioPath); err != nil {
			t.Fatal(err)
		}
		if language != "ja-jp" || origin != "remote_fetch" {
			t.Fatalf("assignment of %s = %q from %q", audioPath, language, origin)
		}
		assigned = append(assigned, audioPath)
	}
	if len(assigned) != 2 || assigned[0] != fixture.root+"/"+folderEditAudioPath || assigned[1] != fixture.originalPath {
		t.Fatalf("assigned audio = %v", assigned)
	}
	fixture.assertNoEditStaging(t)
}

func TestWorkFolderEditRefusesLyricsItCannotPlace(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	for name, body := range map[string]map[string]any{
		"audio as lyrics":      {"additions": []any{lyricsAddition(remoteAddition("RJ00000002", folderEditAudioPath), "ja")}},
		"an unknown language":  {"additions": []any{lyricsAddition(remoteAddition("RJ00000002", folderEditVTTPath), "klingon")}},
		"assigning plain file": {"additions": []any{remoteAddition("RJ00000002", folderEditVTTPath)}, "assignments": []any{map[string]any{"audioPath": folderEditAudioPath, "itemKey": "remote:7:RJ00000002:" + folderEditVTTPath}}},
	} {
		response := fixture.request(t, fixture.server.applyWorkFolderEdit, body, "downloads:manage", "remote:fetch", "library:write")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, body = %s", name, response.Code, response.Body.String())
		}
	}

	// A folder of that name Kikoto did not create is never written into.
	if err := os.MkdirAll(fixture.targetFile("lyrics_kikoto"), 0o755); err != nil {
		t.Fatal(err)
	}
	response := fixture.request(t, fixture.server.planWorkFolderEdit, map[string]any{
		"additions": []any{lyricsAddition(remoteAddition("RJ00000002", folderEditVTTPath), "ja")},
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("blocked lyrics folder: status = %d, body = %s", response.Code, response.Body.String())
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("a refused edit queued a run")
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("refused edits made %d upstream requests", fixture.requests.Load())
	}
}
