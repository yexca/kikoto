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
	"time"
)

const folderEditSecondTrack = "mp3/Track2.Second name.mp3"

// withSecondTrack puts a second audio file in the edited folder and returns
// the locations of both tracks by path below the folder.
func (fixture folderEditFixture) withSecondTrack(t *testing.T) map[string]int64 {
	t.Helper()
	if err := os.WriteFile(fixture.targetFile(folderEditSecondTrack), []byte("second synthetic audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	fixture.reindex(t)
	return fixture.locations(t)
}

func (fixture folderEditFixture) reindex(t *testing.T) {
	t.Helper()
	var fileSourceID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE id = ?", fixture.folderID).Scan(&fileSourceID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.indexLocalMediaForWork(context.Background(), fixture.workID, fileSourceID, fixture.root); err != nil {
		t.Fatal(err)
	}
}

// locations maps the edited folder's available files, by path below it, to
// their locations.
func (fixture folderEditFixture) locations(t *testing.T) map[string]int64 {
	t.Helper()
	rows, err := fixture.db.Query(`
		SELECT location.id, location.path FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
	`, fixture.workID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	found := map[string]int64{}
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			t.Fatal(err)
		}
		found[filepath.ToSlash(path)[len(fixture.root)+1:]] = id
	}
	return found
}

func (fixture folderEditFixture) mediaItemOf(t *testing.T, locationID int64) int64 {
	t.Helper()
	var id int64
	if err := fixture.db.QueryRow("SELECT media_item_id FROM media_file_location WHERE id = ?", locationID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (fixture folderEditFixture) run(t *testing.T, body map[string]any) {
	t.Helper()
	job := fixture.apply(t, body)
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if status := fixture.runStatus(t, job.RunID); status != "succeeded" {
		t.Fatalf("run status = %q", status)
	}
	fixture.assertNoEditStaging(t)
}

func move(locationID int64, path string) map[string]any {
	return map[string]any{"locationId": locationID, "path": path}
}

func TestWorkFolderEditMovesFilesAndKeepsTheirMediaItems(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	movedItem := fixture.mediaItemOf(t, before[originalName])
	body := map[string]any{
		"moves":   []any{move(before[originalName], "Disc 1/Track1.Original name.mp3")},
		"folders": []string{"Bonus"},
	}
	plan := fixture.plan(t, body)
	if plan.Summary.Move != 1 || plan.Summary.Folders != 1 || len(plan.Moves) != 1 {
		t.Fatalf("plan summary = %+v, moves = %+v", plan.Summary, plan.Moves)
	}

	fixture.run(t, body)
	after := fixture.locations(t)
	moved, ok := after["Disc 1/Track1.Original name.mp3"]
	if !ok {
		t.Fatalf("the moved file is not indexed at its new path: %v", after)
	}
	if got := fixture.mediaItemOf(t, moved); got != movedItem {
		t.Fatalf("the moved file has media item %d, want %d", got, movedItem)
	}
	if content, err := os.ReadFile(fixture.targetFile("Disc 1/Track1.Original name.mp3")); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("moved file = %q, %v", content, err)
	}
	if info, err := os.Stat(fixture.targetFile("Bonus")); err != nil || !info.IsDir() {
		t.Fatalf("the new folder is missing: %v", err)
	}
	// The folder still holds the second track, so it stays.
	if _, err := os.Stat(fixture.targetFile("mp3")); err != nil {
		t.Fatalf("a folder that still holds a file was removed: %v", err)
	}

	fixture.run(t, map[string]any{"moves": []any{move(after[folderEditSecondTrack], "Disc 1/Track2.Second name.mp3")}})
	if _, err := os.Stat(fixture.targetFile("mp3")); !os.IsNotExist(err) {
		t.Fatalf("the folder the edit emptied is still there: %v", err)
	}
}

func TestWorkFolderEditLetsFilesTradePlaces(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	firstItem := fixture.mediaItemOf(t, before[originalName])
	secondItem := fixture.mediaItemOf(t, before[folderEditSecondTrack])

	fixture.run(t, map[string]any{"moves": []any{
		move(before[originalName], folderEditSecondTrack),
		move(before[folderEditSecondTrack], originalName),
	}})
	if content, err := os.ReadFile(fixture.targetFile(folderEditSecondTrack)); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("%s = %q, %v", folderEditSecondTrack, content, err)
	}
	after := fixture.locations(t)
	if got := fixture.mediaItemOf(t, after[folderEditSecondTrack]); got != firstItem {
		t.Fatalf("the first track's item did not follow it: %d, want %d", got, firstItem)
	}
	if got := fixture.mediaItemOf(t, after[originalName]); got != secondItem {
		t.Fatalf("the second track's item did not follow it: %d, want %d", got, secondItem)
	}
}

// queueLiftedFolderEdit queues an edit that lifted its moved file into its
// staging folder, then stopped and waits for a retry or for recovery after a
// restart, with no executor working on it. It returns the job, the moved
// file's name below the folder, and the run's staging folder.
func (fixture folderEditFixture) queueLiftedFolderEdit(t *testing.T) (workflowJobRecord, string, string) {
	t.Helper()
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	job := fixture.apply(t, map[string]any{"moves": []any{move(fixture.originalLocationID, "Disc 1/Track1.Original name.mp3")}})
	execution := &workFolderEditExecution{server: fixture.server, job: job}
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &execution.payload); err != nil {
		t.Fatal(err)
	}
	execution.stagingAbs = filepath.Join(fixture.dataRoot, filepath.FromSlash(workFolderEditStagingRoot(execution.payload.TransactionPool, job.RunID)))
	if err := os.MkdirAll(execution.stagingAbs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(fixture.targetFile(originalName), execution.liftedPath(0)); err != nil {
		t.Fatal(err)
	}
	execution.checkpoint.Lifted = []int64{fixture.originalLocationID}
	if err := execution.saveCheckpoint(context.Background(), "publish"); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"UPDATE workflow_job SET status = 'queued' WHERE id = ?", "UPDATE workflow_run SET status = 'queued' WHERE id = ?"} {
		id := job.ID
		if strings.Contains(statement, "workflow_run") {
			id = job.RunID
		}
		if _, err := fixture.db.Exec(statement, id); err != nil {
			t.Fatal(err)
		}
	}
	return job, originalName, execution.stagingAbs
}

func (fixture folderEditFixture) cancelRun(t *testing.T, runID int64) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/"+jsonNumber(runID)+"/cancel", nil)
	request.SetPathValue("id", jsonNumber(runID))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 0, Permissions: []string{"workflows:run", "system:admin"}}))
	response := httptest.NewRecorder()
	fixture.server.cancelWorkflowRun(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body = %s", response.Code, response.Body.String())
	}
}

// waitForPutBack waits until the cancelled edit's moved file is back in its
// place and its staging folder is gone.
func (fixture folderEditFixture) waitForPutBack(t *testing.T, originalName, stagingAbs string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		content, err := os.ReadFile(fixture.targetFile(originalName))
		if err == nil && string(content) == "synthetic audio" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the cancelled edit's moved file did not return to its place: %q, %v", content, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	for deadline := time.Now().Add(5 * time.Second); ; {
		if _, err := os.Stat(filepath.Dir(stagingAbs)); os.IsNotExist(err) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the cancelled edit's staging folder was left behind")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (fixture folderEditFixture) waitForJobStatus(t *testing.T, jobID int64, want string) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; {
		var status string
		if err := fixture.db.QueryRow("SELECT status FROM workflow_job WHERE id = ?", jobID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("job status = %q, want %q", status, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWorkFolderEditCancelledWhileWaitingPutsMovedFilesBack(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	job, originalName, stagingAbs := fixture.queueLiftedFolderEdit(t)
	fixture.cancelRun(t, job.RunID)
	fixture.waitForPutBack(t, originalName, stagingAbs)
}

// runQueuedJobBehindLibraryHolder claims the queued edit while another job
// holds the library folders and returns the worker's result channel.
func (fixture folderEditFixture) runQueuedJobBehindLibraryHolder(t *testing.T, ctx context.Context, jobID int64) <-chan error {
	t.Helper()
	fixture.server.mediaCleanupMu.Lock()
	result := make(chan error, 1)
	go func() { result <- fixture.server.runNextQueuedWorkflowJob(ctx) }()
	fixture.waitForJobStatus(t, jobID, "running")
	return result
}

func waitForWorker(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("a job waiting for the library folders kept waiting after its run stopped")
		return nil
	}
}

func TestWorkFolderEditCancelledWhileWaitingForLibraryFoldersPutsMovedFilesBack(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	job, originalName, stagingAbs := fixture.queueLiftedFolderEdit(t)
	result := fixture.runQueuedJobBehindLibraryHolder(t, context.Background(), job.ID)

	fixture.cancelRun(t, job.RunID)
	if err := waitForWorker(t, result); err != nil {
		t.Fatalf("worker after cancellation = %v", err)
	}
	// What the edit lifted goes back once the folders are free.
	fixture.server.mediaCleanupMu.Unlock()
	fixture.waitForPutBack(t, originalName, stagingAbs)
}

func TestWorkFolderEditStoppedWhileWaitingForLibraryFoldersStaysRecoverable(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	job, originalName, stagingAbs := fixture.queueLiftedFolderEdit(t)
	lifetime, stop := context.WithCancelCause(context.Background())
	result := fixture.runQueuedJobBehindLibraryHolder(t, lifetime, job.ID)

	stop(ErrShuttingDown)
	if err := waitForWorker(t, result); err != nil {
		t.Fatalf("worker after service stop = %v", err)
	}
	fixture.server.mediaCleanupMu.Unlock()
	var jobStatus, runStatus string
	if err := fixture.db.QueryRow(`SELECT job.status, run.status FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id WHERE job.id = ?`, job.ID).Scan(&jobStatus, &runStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "queued" || runStatus != "queued" {
		t.Fatalf("statuses after service stop = job %q run %q, want queued", jobStatus, runStatus)
	}
	// The edit resumes from its checkpoint, so the lifted file stays staged.
	if _, err := os.Stat(stagingAbs); err != nil {
		t.Fatalf("staging folder after service stop: %v", err)
	}
	if _, err := os.Stat(fixture.targetFile(originalName)); !os.IsNotExist(err) {
		t.Fatalf("lifted file after service stop: %v", err)
	}
}

func TestStartupSettlesCancelledWorkFolderEditWhoseSettlementStopped(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	job, originalName, stagingAbs := fixture.queueLiftedFolderEdit(t)
	fixture.server.mediaCleanupMu.Lock()
	fixture.cancelRun(t, job.RunID)
	// A service stop ends the settlement's wait for the library folders.
	if err := fixture.server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixture.server.mediaCleanupMu.Unlock()
	if _, err := os.Stat(stagingAbs); err != nil {
		t.Fatalf("staging folder after the stopped settlement: %v", err)
	}

	if err := fixture.server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixture.waitForPutBack(t, originalName, stagingAbs)
}

func TestWorkFolderEditPutsMovedFilesBackWhenItStops(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"selected.txt": "copied into the edited folder"})
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	movedTo := "Disc 1/Track1.Original name.mp3"
	job := fixture.apply(t, map[string]any{
		"moves":     []any{move(fixture.originalLocationID, movedTo)},
		"additions": []any{localAddition(siblingFolderID, "selected.txt")},
	})
	// A file that appears at an added file's path stops the edit after the
	// moved file left its place.
	if err := os.WriteFile(fixture.targetFile("selected.txt"), []byte("appeared after the plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the edit published over a file that appeared after the plan")
	}
	if status := fixture.runStatus(t, job.RunID); status != "failed" {
		t.Fatalf("run status = %q", status)
	}
	if content, err := os.ReadFile(fixture.targetFile(originalName)); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("the moved file did not return to its place: %q, %v", content, err)
	}
	if _, err := os.Stat(fixture.targetFile(movedTo)); !os.IsNotExist(err) {
		t.Fatalf("the moved file reached its new path: %v", err)
	}
	fixture.assertNoEditStaging(t)

	// A retry once the path is free moves the file again.
	if err := os.Remove(fixture.targetFile("selected.txt")); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.retryFailedWorkflowJob(context.Background(), job.RunID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow(`SELECT payload_json, checkpoint_json, retry_count, max_retries FROM workflow_job WHERE id = ?`, job.ID).Scan(
		&job.PayloadJSON, &job.CheckpointJSON, &job.RetryCount, &job.MaxRetries,
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
	if content, err := os.ReadFile(fixture.targetFile(movedTo)); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("the retried move = %q, %v", content, err)
	}
	fixture.assertNoEditStaging(t)
}

func TestWorkFolderEditMovedOntoARemovedFileKeepsItsOwnItem(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	movedItem := fixture.mediaItemOf(t, before[originalName])
	removedItem := fixture.mediaItemOf(t, before[folderEditSecondTrack])

	fixture.run(t, map[string]any{
		"moves":             []any{move(before[originalName], folderEditSecondTrack)},
		"removeLocationIds": []int64{before[folderEditSecondTrack]},
	})
	if content, err := os.ReadFile(fixture.targetFile(folderEditSecondTrack)); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("%s = %q, %v", folderEditSecondTrack, content, err)
	}
	after := fixture.locations(t)
	if got := fixture.mediaItemOf(t, after[folderEditSecondTrack]); got != movedItem {
		t.Fatalf("the moved file has media item %d, want its own %d and not the removed file's %d", got, movedItem, removedItem)
	}
}

func TestWorkFolderEditRetryFinishesAfterAMergedSourceWasCleared(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"selected.txt": "copied into the edited folder"})
	job := fixture.apply(t, map[string]any{
		"additions":      []any{localAddition(siblingFolderID, "selected.txt")},
		"mergeFolderIds": []int64{siblingFolderID},
	})
	// A Fetch of the merged folder's work stops the merge after the copied
	// file was published.
	fetch := []string{
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type, input_json)
			VALUES ((SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'running', 'manual', '{"work_code":"RJ00000002"}')`,
	}
	for _, statement := range fetch {
		if _, err := fixture.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	var fetchRunID int64
	if err := fixture.db.Writer().QueryRow("SELECT last_insert_rowid()").Scan(&fetchRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec(`INSERT INTO workflow_job (workflow_run_id, worker_type, status) VALUES (?, 'remote_work_fetch', 'running')`, fetchRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	ctx := context.Background()
	if err := fixture.server.executeWorkFolderEditJob(ctx, job); err == nil {
		t.Fatal("the merge ran while a Fetch filled the merged folder")
	}
	// The merged folder was then deleted and recorded as gone, so the copied
	// file's source is no longer an active folder.
	merge := fixture.siblingMerge(t, siblingFolderID)
	target := mediaCleanupTarget{
		Kind: "local_root", FolderID: merge.FolderID, WorkID: merge.WorkID, SourceID: merge.FileSourceID,
		Path: merge.RootPath, ExpectedPath: merge.RootPath, CleanupRunID: job.RunID,
	}
	if err := fixture.server.claimMediaCleanupFolder(ctx, target, job.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.server.removeWorkFolderEditMergedFile(ctx, merge, "selected.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.server.clearLocalWorkRoot(ctx, target); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_run SET status = 'succeeded' WHERE id = ?", fetchRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET status = 'succeeded' WHERE workflow_run_id = ?", fetchRunID); err != nil {
		t.Fatal(err)
	}

	if err := fixture.server.retryFailedWorkflowJob(ctx, job.RunID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow(`SELECT payload_json, checkpoint_json, retry_count, max_retries FROM workflow_job WHERE id = ?`, job.ID).Scan(
		&job.PayloadJSON, &job.CheckpointJSON, &job.RetryCount, &job.MaxRetries,
	); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"UPDATE workflow_job SET status = 'running' WHERE id = ?", "UPDATE workflow_run SET status = 'running' WHERE id = ?"} {
		id := job.ID
		if strings.Contains(statement, "workflow_run") {
			id = job.RunID
		}
		if _, err := fixture.db.Exec(statement, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.server.executeWorkFolderEditJob(ctx, job); err != nil {
		t.Fatalf("retrying an edit whose merged source is gone: %v", err)
	}
	if status := fixture.runStatus(t, job.RunID); status != "succeeded" {
		t.Fatalf("run status = %q", status)
	}
	if content, err := os.ReadFile(fixture.targetFile("selected.txt")); err != nil || string(content) != "copied into the edited folder" {
		t.Fatalf("published file = %q, %v", content, err)
	}
}

func TestWorkFolderEditMergeKeepsAFileWhoseReviewedCopyIsGone(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"Same/copy.mp3": "synthetic audio"})
	body := map[string]any{"mergeFolderIds": []int64{siblingFolderID}}
	if check := fixture.mergeCheck(t, body); !check.Complete || len(check.Lost) != 0 {
		t.Fatalf("merge check = %+v", check)
	}
	job := fixture.apply(t, body)
	// The edited folder's copy, which the review relied on, is deleted before
	// the merge runs.
	if err := os.Remove(fixture.targetFile(originalName)); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the merge deleted a file whose reviewed copy is gone")
	}
	if content, err := os.ReadFile(filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002", "Same", "copy.mp3")); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("merged file = %q, %v", content, err)
	}
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM work_folder_location WHERE id = ?", siblingFolderID).Scan(&state); err != nil || state != "active" {
		t.Fatalf("merged folder state = %q, %v", state, err)
	}
}

func TestWorkFolderEditRejectsLayoutsThatCollide(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	for name, body := range map[string]map[string]any{
		"onto a staying file":   {"moves": []any{move(before[originalName], folderEditSecondTrack)}},
		"into the lyrics":       {"moves": []any{move(before[originalName], "lyrics_kikoto/jpn/a.mp3")}},
		"folder at a file path": {"folders": []string{folderEditSecondTrack}},
		"below a file":          {"moves": []any{move(before[originalName], folderEditSecondTrack+"/a.mp3")}},
		"moved and removed": {
			"moves":             []any{move(before[originalName], "Disc 1/a.mp3")},
			"removeLocationIds": []int64{before[originalName]},
		},
	} {
		response := fixture.request(t, fixture.server.planWorkFolderEdit, body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: plan status = %d, body = %s", name, response.Code, response.Body.String())
		}
	}
}

func TestWorkFolderEditPlacesAnAddedFileAtItsTargetPath(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{folderEditVTTPath: lyricsFetchVTT})
	addition := localAddition(siblingFolderID, folderEditVTTPath)
	addition["targetPath"] = "Extras/notes.vtt"
	body := map[string]any{"additions": []any{addition}}
	plan := fixture.plan(t, body)
	if len(plan.Items) != 1 || plan.Items[0].TargetPath != fixture.root+"/Extras/notes.vtt" {
		t.Fatalf("plan items = %+v", plan.Items)
	}
	fixture.run(t, body)
	if content, err := os.ReadFile(fixture.targetFile("Extras/notes.vtt")); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("placed file = %q, %v", content, err)
	}
}

func (fixture folderEditFixture) mergeCheck(t *testing.T, body map[string]any) workFolderEditMergeCheck {
	t.Helper()
	response := fixture.request(t, fixture.server.checkWorkFolderEditMerge, body)
	if response.Code != http.StatusOK {
		t.Fatalf("merge check status = %d, body = %s", response.Code, response.Body.String())
	}
	var check workFolderEditMergeCheck
	if err := json.Unmarshal(response.Body.Bytes(), &check); err != nil {
		t.Fatal(err)
	}
	return check
}

func TestWorkFolderEditMergeReportsLostFilesAndDeletesTheFolder(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{
		"only-here.txt":  "a note no other folder holds",
		"Same/copy.mp3":  "synthetic audio",
		"selected.txt":   "copied into the edited folder",
		"Empty/.keep.md": "",
	})
	body := map[string]any{
		"additions":      []any{localAddition(siblingFolderID, "selected.txt")},
		"mergeFolderIds": []int64{siblingFolderID},
	}
	plan := fixture.plan(t, body)
	if plan.Summary.Merge != 1 || plan.Summary.MergeFiles != 4 || len(plan.Merges) != 1 || plan.Merges[0].Files != nil {
		t.Fatalf("plan summary = %+v, merges = %+v", plan.Summary, plan.Merges)
	}

	check := fixture.mergeCheck(t, body)
	lost := map[string]bool{}
	for _, file := range check.Lost {
		lost[file.Path] = true
	}
	// The copy of the edited folder's audio and the copied file are kept;
	// the note and the empty file have no copy there.
	if !check.Complete || len(check.Lost) != 2 || !lost["RJ00000002/only-here.txt"] || !lost["RJ00000002/Empty/.keep.md"] {
		t.Fatalf("merge check = %+v", check)
	}

	fixture.run(t, body)
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, "RJ00000002")); !os.IsNotExist(err) {
		t.Fatalf("the merged folder is still there: %v", err)
	}
	if content, err := os.ReadFile(fixture.targetFile("selected.txt")); err != nil || string(content) != "copied into the edited folder" {
		t.Fatalf("copied file = %q, %v", content, err)
	}
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM work_folder_location WHERE id = ?", siblingFolderID).Scan(&state); err != nil || state != "ignored" {
		t.Fatalf("merged folder state = %q, %v", state, err)
	}
	var available int
	if err := fixture.db.QueryRow(`
		SELECT COUNT(*) FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = 902 AND location.availability = 'available'
	`).Scan(&available); err != nil || available != 0 {
		t.Fatalf("the merged edition still has %d available files, %v", available, err)
	}
}

func TestWorkFolderEditMergeKeepsAFolderThatChangedAfterReview(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"reviewed.txt": "reviewed"})
	job := fixture.apply(t, map[string]any{"mergeFolderIds": []int64{siblingFolderID}})
	added := filepath.Join(fixture.dataRoot, "RJ00000002", "added later.txt")
	if err := os.WriteFile(added, []byte("not in the review"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the merge deleted a folder that changed after it was reviewed")
	}
	for _, name := range []string{"reviewed.txt", "added later.txt"} {
		if _, err := os.Stat(filepath.Join(fixture.dataRoot, "RJ00000002", name)); err != nil {
			t.Fatalf("%s was deleted: %v", name, err)
		}
	}
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM work_folder_location WHERE id = ?", siblingFolderID).Scan(&state); err != nil || state != "active" {
		t.Fatalf("merged folder state = %q, %v", state, err)
	}
}

func TestWorkFolderEditMergeKeepsAFileRewrittenWithTheSameSize(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"reviewed.txt": "reviewed"})
	job := fixture.apply(t, map[string]any{"mergeFolderIds": []int64{siblingFolderID}})
	rewritten := filepath.Join(fixture.dataRoot, "RJ00000002", "reviewed.txt")
	if err := os.WriteFile(rewritten, []byte("REWRITTE"), 0o644); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(rewritten, later, later); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the merge deleted a file rewritten after it was reviewed")
	}
	if content, err := os.ReadFile(rewritten); err != nil || string(content) != "REWRITTE" {
		t.Fatalf("rewritten file = %q, %v", content, err)
	}
}

// siblingMerge is the merge of the sibling edition's folder.
func (fixture folderEditFixture) siblingMerge(t *testing.T, folderID int64) workFolderEditMerge {
	t.Helper()
	merge := workFolderEditMerge{FolderID: folderID}
	if err := fixture.db.QueryRow("SELECT work_id, file_source_id, root_path FROM work_folder_location WHERE id = ?", folderID).Scan(
		&merge.WorkID, &merge.FileSourceID, &merge.RootPath,
	); err != nil {
		t.Fatal(err)
	}
	return merge
}

func TestWorkFolderEditMergedFileReadsUnavailableOnceDeleted(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"first.mp3": "first synthetic audio", "second.mp3": "second synthetic audio"})
	merge := fixture.siblingMerge(t, siblingFolderID)
	if err := fixture.server.indexLocalMediaForWork(context.Background(), merge.WorkID, merge.FileSourceID, merge.RootPath); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.server.removeWorkFolderEditMergedFile(context.Background(), merge, "first.mp3"); err != nil {
		t.Fatal(err)
	}
	// The merge may stop before the folder is gone; the deleted file must not
	// read available until the next scan.
	availability := map[string]string{}
	rows, err := fixture.db.Query("SELECT path, availability FROM media_file_location WHERE file_source_id = ? AND path LIKE ? || '/%'", merge.FileSourceID, merge.RootPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var libraryPath, state string
		if err := rows.Scan(&libraryPath, &state); err != nil {
			t.Fatal(err)
		}
		availability[strings.TrimPrefix(libraryPath, merge.RootPath+"/")] = state
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if availability["first.mp3"] != "unavailable" || availability["second.mp3"] != "available" {
		t.Fatalf("availability after deleting one file = %v", availability)
	}
}

func TestWorkFolderEditMergeResumesAfterTheFolderWasCleared(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"reviewed.mp3": "synthetic audio"})
	job := fixture.apply(t, map[string]any{"mergeFolderIds": []int64{siblingFolderID}})
	// An earlier attempt deleted the folder and recorded it as gone, then
	// stopped before it saved its checkpoint.
	merge := fixture.siblingMerge(t, siblingFolderID)
	target := mediaCleanupTarget{
		Kind: "local_root", FolderID: merge.FolderID, WorkID: merge.WorkID, SourceID: merge.FileSourceID,
		Path: merge.RootPath, ExpectedPath: merge.RootPath, CleanupRunID: job.RunID,
	}
	ctx := context.Background()
	if err := fixture.server.claimMediaCleanupFolder(ctx, target, job.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.server.removeWorkFolderEditMergedFile(ctx, merge, "reviewed.mp3"); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.server.clearLocalWorkRoot(ctx, target); err != nil {
		t.Fatal(err)
	}

	if err := fixture.server.executeWorkFolderEditJob(ctx, job); err != nil {
		t.Fatalf("resuming a merge whose folder is already gone: %v", err)
	}
	if status := fixture.runStatus(t, job.RunID); status != "succeeded" {
		t.Fatalf("run status = %q", status)
	}
}

func TestWorkFolderEditMergeRequiresTheReviewOfTheSameFiles(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"reviewed.txt": "reviewed"})
	body := map[string]any{"mergeFolderIds": []int64{siblingFolderID}}
	if response := fixture.request(t, fixture.server.applyWorkFolderEdit, body); response.Code != http.StatusBadRequest {
		t.Fatalf("a merge without a check: status = %d, body = %s", response.Code, response.Body.String())
	}
	check := fixture.mergeCheck(t, body)
	if err := os.WriteFile(filepath.Join(fixture.dataRoot, "RJ00000002", "added later.txt"), []byte("not in the review"), 0o644); err != nil {
		t.Fatal(err)
	}
	response := fixture.request(t, fixture.server.applyWorkFolderEdit, map[string]any{
		"mergeFolderIds": []int64{siblingFolderID}, "mergeReview": check.Review,
	})
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "folder_edit_merge_changed") {
		t.Fatalf("a merge whose folder changed after the check: status = %d, body = %s", response.Code, response.Body.String())
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("a merge whose folder changed after the check queued a run")
	}
}

func TestWorkFolderEditRefusesToMergeAFolderOfAWorkAFetchIsFilling(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"reviewed.txt": "reviewed"})
	body := map[string]any{"mergeFolderIds": []int64{siblingFolderID}}
	check := fixture.mergeCheck(t, body)
	for _, statement := range []string{
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type, input_json)
			VALUES ((SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'running', 'manual', '{"work_code":"RJ00000002"}')`,
		`INSERT INTO workflow_job (workflow_run_id, worker_type, status) VALUES (last_insert_rowid(), 'remote_work_fetch', 'running')`,
	} {
		if _, err := fixture.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	response := fixture.request(t, fixture.server.applyWorkFolderEdit, map[string]any{
		"mergeFolderIds": []int64{siblingFolderID}, "mergeReview": check.Review,
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("merging a folder a Fetch is filling: status = %d, body = %s", response.Code, response.Body.String())
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("merging a folder a Fetch is filling queued a run")
	}
}

func TestWorkFolderEditMergeCheckDoesNotKeepAFileTheEditReplaces(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{
		originalName: "a different translated recording",
		"copy.mp3":   "synthetic audio",
	})
	check := fixture.mergeCheck(t, map[string]any{
		"additions":      []any{localAddition(siblingFolderID, originalName)},
		"decisions":      []any{map[string]any{"itemKey": "local:" + jsonNumber(siblingFolderID) + ":" + originalName, "resolution": "replace"}},
		"mergeFolderIds": []int64{siblingFolderID},
	})
	// The edited folder's copy of copy.mp3 is the file the addition replaces.
	if !check.Complete || len(check.Lost) != 1 || check.Lost[0].Path != "RJ00000002/copy.mp3" {
		t.Fatalf("merge check = %+v", check)
	}
}

func TestWorkFolderEditRefusesToMergeTheEditedFolder(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	response := fixture.request(t, fixture.server.planWorkFolderEdit, map[string]any{"mergeFolderIds": []int64{fixture.folderID}})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("plan status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestWorkFolderEditMovedFileKeepsItsItemWhenItsOtherCopyIsMergedAway(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	copyPath := filepath.Join(fixture.dataRoot, "RJ00000001 copy", filepath.FromSlash(originalName))
	if err := os.MkdirAll(filepath.Dir(copyPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copyPath, []byte("synthetic audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	executeLocalScanForTest(t, fixture.server)
	if err := fixture.server.indexAdditionalLocalFolders(context.Background(), fixture.workID, true); err != nil {
		t.Fatal(err)
	}
	var copyFolderID int64
	if err := fixture.db.QueryRow("SELECT id FROM work_folder_location WHERE work_id = ? AND id <> ?", fixture.workID, fixture.folderID).Scan(&copyFolderID); err != nil {
		t.Fatal(err)
	}
	item := fixture.mediaItemOf(t, fixture.originalLocationID)
	var shared int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE media_item_id = ? AND availability = 'available'", item).Scan(&shared); err != nil || shared != 2 {
		t.Fatalf("the copy does not share the item: %d, %v", shared, err)
	}

	fixture.run(t, map[string]any{
		"moves":          []any{move(fixture.originalLocationID, "Disc 1/Track1.Original name.mp3")},
		"mergeFolderIds": []int64{copyFolderID},
	})
	moved, ok := fixture.locations(t)["Disc 1/Track1.Original name.mp3"]
	if !ok {
		t.Fatal("the moved file is not indexed at its new path")
	}
	if got := fixture.mediaItemOf(t, moved); got != item {
		t.Fatalf("the moved file has media item %d, want %d", got, item)
	}
}

func TestWorkFolderEditMergeRefusesALossTheReviewDidNotReport(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"Same/copy.mp3": "synthetic audio"})
	body := map[string]any{"mergeFolderIds": []int64{siblingFolderID}}
	check := fixture.mergeCheck(t, body)
	if !check.Complete || len(check.Lost) != 0 {
		t.Fatalf("merge check = %+v", check)
	}
	// Every file keeps its version, but the edited folder's copy no longer
	// compares equal, as when it cannot be read any more.
	if _, err := fixture.db.Exec("UPDATE media_file_location SET content_hash = 'unreadable' WHERE id = ?", fixture.originalLocationID); err != nil {
		t.Fatal(err)
	}
	response := fixture.request(t, fixture.server.applyWorkFolderEdit, map[string]any{
		"mergeFolderIds": []int64{siblingFolderID}, "mergeReview": check.Review,
	})
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "folder_edit_merge_changed") {
		t.Fatalf("a loss the review did not report: status = %d, body = %s", response.Code, response.Body.String())
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("a merge with a loss the review did not report queued a run")
	}
}

func TestWorkFolderEditMergeLeavesNASMetadataOutOfTheReview(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{
		"only-here.txt": "a note no other folder holds",
		"Thumbs.db":     "thumbnail cache",
		"@eaDir/only-here.txt/SYNOINDEX_MEDIA_INFO": "indexer metadata",
	})
	body := map[string]any{"mergeFolderIds": []int64{siblingFolderID}}
	check := fixture.mergeCheck(t, body)
	if !check.Complete || len(check.Lost) != 1 || check.Lost[0].Path != "RJ00000002/only-here.txt" {
		t.Fatalf("merge check = %+v", check)
	}
	// The NAS rewrites its metadata after the review.
	metadata := filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002", "@eaDir", "only-here.txt", "SYNOINDEX_MEDIA_INFO")
	if err := os.WriteFile(metadata, []byte("indexer metadata, rewritten"), 0o644); err != nil {
		t.Fatal(err)
	}
	fixture.run(t, map[string]any{"mergeFolderIds": []int64{siblingFolderID}, "mergeReview": check.Review})
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002")); !os.IsNotExist(err) {
		t.Fatalf("the merged folder is still there: %v", err)
	}
}

func TestWorkFolderEditKeepsARemovedFileRewrittenAfterPlanning(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	job := fixture.apply(t, map[string]any{"removeLocationIds": []int64{fixture.originalLocationID}})
	// Another writer, such as a Fetch, puts a new version at the path.
	if err := os.WriteFile(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.originalPath)), []byte("a newer recording"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the edit removed a file that changed after it was planned")
	}
	if content, err := os.ReadFile(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.originalPath))); err != nil || string(content) != "a newer recording" {
		t.Fatalf("rewritten file = %q, %v", content, err)
	}
}

func TestWorkFolderEditReplacesOnlyTheExactRemovedFile(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	originalName := strings.TrimPrefix(fixture.originalPath, fixture.root+"/")
	otherName := strings.ToLower(originalName)
	if err := os.WriteFile(fixture.targetFile(otherName), []byte("another recording"), 0o644); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(fixture.targetFile(originalName)); err != nil || string(content) != "synthetic audio" {
		t.Skip("the filesystem does not tell letter case apart")
	}
	locations := fixture.withSecondTrack(t)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"incoming.mp3": "an incoming recording"})
	addition := localAddition(siblingFolderID, "incoming.mp3")
	addition["targetPath"] = originalName
	// Removing the lower-case file does not free the path of the file whose
	// name differs from it only in letter case.
	plan := fixture.plan(t, map[string]any{"additions": []any{addition}, "removeLocationIds": []int64{locations[otherName]}})
	if len(plan.Items) != 1 || plan.Items[0].Status == "replace_target" || plan.Items[0].Action != "conflict" {
		t.Fatalf("plan items = %+v", plan.Items)
	}
}
