package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storagepool"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// The sibling edition RJ00000002 of the folder edit fixture is the work a
// Fetch publishes into a new folder; the origin edition's local folder and the
// sibling's own remote tree supply its follow-up.
const followUpFetchRoot = "RJ00000002"

func followUpFetchPlan() remoteWorkSavePlan {
	return remoteWorkSavePlan{
		SourceID: 7, PrimaryCode: "RJ00000002", EditionCode: "RJ00000002", SaveRoot: followUpFetchRoot,
		Items: []remoteWorkSavePlanItem{{
			ItemKey: "remote:" + folderEditAudioPath, Path: folderEditAudioPath, Kind: "audio",
			SourceKind: "remote", Action: "cache_download", TargetPath: followUpFetchRoot + "/" + folderEditAudioPath,
		}},
	}
}

func TestRemoteFetchFollowUpPreviewTakesTheFetchedFilesIntoAccount(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	originalName := strings.TrimPrefix(fixture.originalPath, fixture.root+"/")
	followUp := &remoteFetchFollowUp{Additions: []workFolderEditAdditionRequest{
		{Kind: "remote", SourceID: 7, RemoteCode: "RJ00000002", Path: folderEditVTTPath, Language: followUpLanguage("zh-cn")},
		{Kind: "local", FolderID: fixture.folderID, Path: originalName},
		// The Fetch already publishes this file at the same place.
		{Kind: "remote", SourceID: 7, RemoteCode: "RJ00000002", Path: folderEditAudioPath},
	}}

	preview, err := fixture.server.planRemoteFetchFollowUp(context.Background(), followUpFetchPlan(), followUp)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Summary.Add != 2 || preview.Summary.Lyrics != 1 || preview.Summary.Conflict != 1 {
		t.Fatalf("follow-up summary = %+v", preview.Summary)
	}
	targets := map[string]string{}
	for _, item := range preview.Items {
		targets[item.ItemKey] = item.TargetPath + " " + item.Action
	}
	for key, want := range map[string]string{
		"remote:7:RJ00000002:" + folderEditVTTPath:                   followUpFetchRoot + "/lyrics_kikoto/zh-hans/" + folderEditVTTPath + " cache_download",
		"local:" + jsonNumber(fixture.folderID) + ":" + originalName: followUpFetchRoot + "/" + originalName + " copy_local",
		"remote:7:RJ00000002:" + folderEditAudioPath:                 followUpFetchRoot + "/" + folderEditAudioPath + " conflict",
	} {
		if targets[key] != want {
			t.Fatalf("%s = %q, want %q", key, targets[key], want)
		}
	}

	followUp.Decisions = []remoteFetchFileDecision{{ItemKey: "remote:7:RJ00000002:" + folderEditAudioPath, Resolution: "exclude"}}
	if prepared, err := fixture.server.prepareRemoteFetchFollowUp(context.Background(), followUpFetchPlan(), followUp); err != nil || prepared == nil {
		t.Fatalf("a resolved follow-up was refused: %v", err)
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("a preview made %d upstream requests", fixture.requests.Load())
	}
	if _, err := os.Stat(fixture.targetFile("../" + followUpFetchRoot)); !os.IsNotExist(err) {
		t.Fatalf("a preview created the Fetch folder: %v", err)
	}
}

func TestRemoteFetchFollowUpEditsThePublishedFolderOnce(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	// The Fetch published the sibling's audio into a folder of its own.
	fixture.addSiblingFolder(t, map[string]string{folderEditAudioPath: folderEditRemoteAudio})
	var localSourceID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE work_id = 902").Scan(&localSourceID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	payload := remoteWorkFetchJobPayload{SourceID: 7, WorkCode: "RJ00000002", FollowUp: &remoteFetchFollowUp{
		Additions:   []workFolderEditAdditionRequest{{Kind: "remote", SourceID: 7, RemoteCode: "RJ00000002", Path: folderEditVTTPath, Language: followUpLanguage("zh-cn")}},
		Assignments: []workFolderEditAssignment{{AudioPath: folderEditAudioPath, ItemKey: "remote:7:RJ00000002:" + folderEditVTTPath}},
	}}
	tx, err := fixture.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_work_fetch", "Fetch remote work", "", remoteWorkFetchDefinition())
	if err != nil {
		t.Fatal(err)
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_work_fetch", "Fetch RJ00000002", "succeeded", "manual", "fetch_selected", payload, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	manifest := remoteFetchManifestRecord{WorkflowRunID: runID, WorkID: 902, LocalSourceID: localSourceID, TargetRoot: followUpFetchRoot}

	fixture.server.startRemoteFetchFollowUp(ctx, manifest)
	fixture.server.startRemoteFetchFollowUp(ctx, manifest)
	if runs := fixture.queuedRuns(t); runs != 1 {
		t.Fatalf("follow-up runs = %d, want 1", runs)
	}
	var job workflowJobRecord
	var editRunID int64
	if err := fixture.db.QueryRow(`
		SELECT job.id, job.workflow_run_id, job.payload_json, job.checkpoint_json,
			CAST(json_extract(fetch.summary_json, '$.follow_up_run_id') AS INTEGER)
		FROM workflow_job AS job, workflow_run AS fetch
		WHERE job.worker_type = ? AND fetch.id = ?
	`, workFolderEditWorkerType, runID).Scan(&job.ID, &job.RunID, &job.PayloadJSON, &job.CheckpointJSON, &editRunID); err != nil {
		t.Fatal(err)
	}
	if editRunID != job.RunID {
		t.Fatalf("the Fetch run records follow-up run %d, want %d", editRunID, job.RunID)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET status = 'running' WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_run SET status = 'running' WHERE id = ?", job.RunID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.executeWorkFolderEditJob(ctx, job); err != nil {
		t.Fatal(err)
	}
	lyricsPath := followUpFetchRoot + "/lyrics_kikoto/zh-hans/" + folderEditVTTPath
	if content, err := os.ReadFile(fixture.targetFile("../" + lyricsPath)); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("follow-up lyrics = %q, %v", content, err)
	}
	var assigned int
	if err := fixture.db.QueryRow(`
		SELECT COUNT(*) FROM media_lyrics_assignment AS assignment
		INNER JOIN media_file_location AS audio ON audio.media_item_id = assignment.audio_media_item_id
		WHERE assignment.language = 'zh-cn' AND audio.path = ?
	`, followUpFetchRoot+"/"+folderEditAudioPath).Scan(&assigned); err != nil || assigned != 1 {
		t.Fatalf("assignments of the fetched audio = %d, %v", assigned, err)
	}
}

// A Fetch whose completion committed before the service stopped has no
// recorded follow-up. Startup recovery queues it exactly once, waits while its
// storage pool is offline, or records in Activity why it cannot be queued.
func TestRemoteFetchFollowUpStartsOnceAfterARestart(t *testing.T) {
	fixture := newPoolFolderEditFixture(t, serveFolderEditMedia)
	fixture.addSiblingFolder(t, map[string]string{folderEditAudioPath: folderEditRemoteAudio})
	var localSourceID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE work_id = 902").Scan(&localSourceID); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	seedCompletedFetch := func(targetRoot string) int64 {
		t.Helper()
		payload := remoteWorkFetchJobPayload{SourceID: 7, WorkCode: "RJ00000002", FollowUp: &remoteFetchFollowUp{
			Additions: []workFolderEditAdditionRequest{{Kind: "remote", SourceID: 7, RemoteCode: "RJ00000002", Path: folderEditVTTPath, Language: followUpLanguage("zh-cn")}},
		}}
		tx, err := fixture.db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback() }()
		definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_work_fetch", "Fetch remote work", "", remoteWorkFetchDefinition())
		if err != nil {
			t.Fatal(err)
		}
		runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_work_fetch", "Fetch RJ00000002", "succeeded", "manual", "fetch_selected", payload, map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO remote_fetch_manifest (workflow_run_id, work_id, remote_source_id, local_source_id, edition_code, target_root, staging_root, state, plan_json)
			VALUES (?, 902, 7, ?, 'RJ00000002', ?, '.kikoto-staging/fetch/work', 'completed', '{}')
		`, runID, localSourceID, targetRoot); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return runID
	}
	type followUpOutcome struct {
		editRunID                int64
		waiting, failure         string
		waitEvents, failedEvents int
	}
	outcome := func(runID int64) followUpOutcome {
		t.Helper()
		var editRunID sql.NullInt64
		var waiting, failure sql.NullString
		var result followUpOutcome
		if err := fixture.db.QueryRow(`
			SELECT json_extract(summary_json, '$.follow_up_run_id'), json_extract(summary_json, '$.follow_up_waiting'),
				json_extract(summary_json, '$.follow_up_error'),
				(SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = run.id AND event_type = 'fetch.follow_up_waiting'),
				(SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = run.id AND event_type = 'fetch.follow_up_failed')
			FROM workflow_run AS run WHERE id = ?
		`, runID).Scan(&editRunID, &waiting, &failure, &result.waitEvents, &result.failedEvents); err != nil {
			t.Fatal(err)
		}
		result.editRunID, result.waiting, result.failure = editRunID.Int64, waiting.String, failure.String
		return result
	}
	recoverTwice := func() {
		t.Helper()
		for range 2 {
			if err := fixture.server.RecoverInterruptedWorkflows(ctx); err != nil {
				t.Fatal(err)
			}
		}
	}

	fetched := seedCompletedFetch(fixture.siblingPool + "/" + followUpFetchRoot)
	// The pool holding the fetched folder is not mounted at startup.
	fixture.takePoolOffline(t, fixture.siblingPool)
	recoverTwice()
	if got := outcome(fetched); fixture.queuedRuns(t) != 0 || got.waiting != errStoragePoolOffline.Message || got.waitEvents != 1 || got.failure != "" {
		t.Fatalf("a follow-up on an offline pool queued %d runs and recorded %+v", fixture.queuedRuns(t), got)
	}
	if err := storagepool.WriteMarker(filepath.Join(fixture.dataRoot, fixture.siblingPool), lyricsFetchTestPools[1].ID); err != nil {
		t.Fatal(err)
	}
	fixture.server.retryRemoteFetchFollowUps(ctx)
	editRunID := outcome(fetched).editRunID
	if got := outcome(fetched); fixture.queuedRuns(t) != 1 || editRunID == 0 || got.waiting != "" {
		t.Fatalf("once the pool was back, %d follow-up runs were queued and %+v recorded", fixture.queuedRuns(t), got)
	}

	// The service stopped after queueing the follow-up but before recording it.
	if _, err := fixture.db.Exec("UPDATE workflow_run SET summary_json = '{}' WHERE id = ?", fetched); err != nil {
		t.Fatal(err)
	}
	recoverTwice()
	if got := outcome(fetched); fixture.queuedRuns(t) != 1 || got.editRunID != editRunID {
		t.Fatalf("a repeated recovery queued %d follow-up runs, recorded run %d, want run %d", fixture.queuedRuns(t), got.editRunID, editRunID)
	}

	lost := seedCompletedFetch(fixture.siblingPool + "/RJ00000002-removed")
	recoverTwice()
	if got := outcome(lost); got.failure != "the fetched folder is no longer in the library" || got.failedEvents != 1 {
		t.Fatalf("a follow-up that cannot be queued recorded %+v", got)
	}
	if runs := fixture.queuedRuns(t); runs != 1 {
		t.Fatalf("follow-up runs = %d, want 1", runs)
	}
}

func TestRemoteFetchWithFollowUpNeedsFilePermissionAndAFetchedFile(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	followUp := map[string]any{"additions": []any{lyricsAddition(remoteAddition("RJ00000002", folderEditVTTPath), "zh-cn")}}
	for name, test := range map[string]struct {
		body        map[string]any
		permissions []string
		status      int
	}{
		"without file permission": {
			body:        map[string]any{"paths": []string{folderEditAudioPath}, "followUp": followUp},
			permissions: []string{"remote:fetch", "metadata:sync"}, status: http.StatusForbidden,
		},
		"assigning without library permission": {
			body: map[string]any{"paths": []string{folderEditAudioPath}, "followUp": map[string]any{
				"additions":   followUp["additions"],
				"assignments": []any{map[string]any{"audioPath": folderEditAudioPath, "itemKey": "remote:7:RJ00000002:" + folderEditVTTPath}},
			}},
			permissions: []string{"remote:fetch", "metadata:sync", "downloads:manage"}, status: http.StatusForbidden,
		},
		"without a fetched file": {
			body:        map[string]any{"followUp": followUp},
			permissions: []string{"remote:fetch", "metadata:sync", "downloads:manage"}, status: http.StatusBadRequest,
		},
	} {
		encoded, err := json.Marshal(test.body)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/remote-sources/7/works/RJ00000002/save", strings.NewReader(string(encoded)))
		request.SetPathValue("id", "7")
		request.SetPathValue("code", "RJ00000002")
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{Permissions: test.permissions}))
		response := httptest.NewRecorder()
		fixture.server.saveRemoteSourceWork(response, request)
		if response.Code != test.status {
			t.Fatalf("%s: status = %d, body = %s", name, response.Code, response.Body.String())
		}
	}
	var runs int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code IN ('remote_work_fetch', ?)", workFolderEditWorkflowCode).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("refused Fetches queued %d runs, %v", runs, err)
	}
}

func followUpLanguage(language string) *string {
	return &language
}
