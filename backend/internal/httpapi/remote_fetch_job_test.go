package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func seedExecutableFetch(t *testing.T, server *Server, db *sqlutil.DB, sourceURL string) remoteWorkSavePlan {
	t.Helper()
	plan := seedPublishedFetch(t, server, db, 0, true)
	plan.Items[0].SourcePath = sourceURL + "/track.mp3"
	if _, err := db.Exec(`UPDATE remote_fetch_manifest SET plan_json = ? WHERE workflow_run_id = 1`, mustJSON(plan)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (1, ?, ?)`, sourceURL, sourceURL); err != nil {
		t.Fatal(err)
	}
	for i, node := range []string{"cache", "stage", "verify", "promote", "sync", "cleanup"} {
		if _, err := db.Exec(`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (?, 1, ?, 'fetch', ?, ?, 'queued')`, i+1, node, node, i+1); err != nil {
			t.Fatal(err)
		}
	}
	execFetchTestStatements(t, db,
		`UPDATE workflow_run SET status = 'queued', finished_at = NULL WHERE id = 1`,
		`UPDATE workflow_job SET status = 'queued', workflow_node_run_id = 1, recoverable = 1, max_retries = 3 WHERE id = 1`,
	)
	if _, err := db.Exec(`UPDATE workflow_job SET payload_json = ? WHERE id = 1`, mustJSON(remoteWorkFetchJobPayload{SourceID: 1, WorkCode: plan.PrimaryCode})); err != nil {
		t.Fatal(err)
	}
	return plan
}

func assertCompletedFetch(t *testing.T, server *Server, db *sqlutil.DB) {
	t.Helper()
	manifest, err := server.loadRemoteFetchManifest(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	jobStatus, runStatus, lease, _, _ := loadJobState(t, db, 1)
	if manifest.State != "completed" || jobStatus != "succeeded" || runStatus != "succeeded" || lease != "" {
		t.Fatalf("manifest=%s job=%s run=%s lease=%q", manifest.State, jobStatus, runStatus, lease)
	}
	var unfinished, streams, locations int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = 1 AND status <> 'succeeded'`).Scan(&unfinished); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND location_type = 'remote_stream'`).Scan(&streams); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND location_type = 'local' AND availability = 'available'`).Scan(&locations); err != nil {
		t.Fatal(err)
	}
	if unfinished != 0 || streams != 0 || locations != 1 {
		t.Fatalf("unfinished nodes=%d remote streams=%d local locations=%d", unfinished, streams, locations)
	}
}

// A published target is sufficient to finish, even after cache cleanup and
// while its remote source is unavailable. Both entry points must use it.
func TestPublishedFetchResumesWithoutDownloading(t *testing.T) {
	for _, state := range []string{"publishing", "published", "registered"} {
		t.Run(state, func(t *testing.T) {
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(http.StatusServiceUnavailable)
			}))
			defer upstream.Close()
			server, db := newFetchRecoveryServer(t)
			seedExecutableFetch(t, server, db, upstream.URL)
			if _, err := db.Exec(`UPDATE remote_fetch_manifest SET state = ?, error_message = 'synthetic interrupted write' WHERE workflow_run_id = 1`, state); err != nil {
				t.Fatal(err)
			}
			if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
				t.Fatal(err)
			}
			assertCompletedFetch(t, server, db)
			if requests.Load() != 0 {
				t.Fatalf("published Fetch made %d remote requests", requests.Load())
			}
		})
	}
}

func TestFetchCompletionRollsBackWithWorkflowResult(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	server, db := newFetchRecoveryServer(t)
	seedExecutableFetch(t, server, db, upstream.URL)
	manifest, err := server.loadRemoteFetchManifest(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	writeFetchTestFile(t, server.cfg.DataRoot, manifest.BackupRoot+"/earlier.mp3", "earlier")
	execFetchTestStatements(t, db, `CREATE TRIGGER fail_fetch_result BEFORE UPDATE OF status ON workflow_run
		WHEN NEW.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic result write failure'); END`)
	if err := server.runNextQueuedWorkflowJob(context.Background()); err == nil || !strings.Contains(err.Error(), "synthetic result write failure") {
		t.Fatalf("fault injection did not prevent completion: %v", err)
	}
	manifest, err = server.loadRemoteFetchManifest(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	jobStatus, runStatus, _, _, _ := loadJobState(t, db, 1)
	if manifest.State == "completed" || jobStatus != "failed" || runStatus != "failed" {
		t.Fatalf("partial completion: manifest=%s job=%s run=%s", manifest.State, jobStatus, runStatus)
	}
	var streams int
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND location_type = 'remote_stream'`).Scan(&streams); err != nil {
		t.Fatal(err)
	}
	if streams != 1 {
		t.Fatal("remote identity retired before completion committed")
	}
	if _, err := os.Stat(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(manifest.BackupRoot), "earlier.mp3")); err != nil {
		t.Fatalf("rollback backup was removed before completion: %v", err)
	}
	execFetchTestStatements(t, db, `DROP TRIGGER fail_fetch_result`)
	if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletedFetch(t, server, db)
}

func TestQueuedFetchDownloadsPublishesAndRegisters(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte("track"))
	}))
	defer upstream.Close()
	server, db := newFetchRecoveryServer(t)
	plan := seedExecutableFetch(t, server, db, upstream.URL)
	execFetchTestStatements(t, db, `UPDATE remote_fetch_manifest SET state = 'planned' WHERE workflow_run_id = 1`)
	if err := os.Remove(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.Items[0].TargetPath))); err != nil {
		t.Fatal(err)
	}
	writeFetchTestFile(t, server.cfg.DataRoot, plan.SaveRoot+"/earlier.mp3", "earlier")
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletedFetch(t, server, db)
	if requests.Load() != 1 {
		t.Fatalf("downloads=%d, want one", requests.Load())
	}
	for name, want := range map[string]string{"track.mp3": "track", "earlier.mp3": "earlier"} {
		data, err := os.ReadFile(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.SaveRoot), name))
		if err != nil || string(data) != want {
			t.Fatalf("published %s = %q, %v", name, data, err)
		}
	}
	var current, total, bytesCurrent int
	if err := db.QueryRow(`SELECT progress_current, progress_total, progress_bytes_current FROM workflow_job WHERE id = 1`).Scan(&current, &total, &bytesCurrent); err != nil {
		t.Fatal(err)
	}
	if current != 2 || total != 2 || bytesCurrent != 5 {
		t.Fatalf("progress=%d/%d bytes=%d", current, total, bytesCurrent)
	}
}

func TestFetchDownloadFailureReturnsToQueueBeforePublication(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer upstream.Close()
	server, db := newFetchRecoveryServer(t)
	plan := seedExecutableFetch(t, server, db, upstream.URL)
	execFetchTestStatements(t, db, `UPDATE remote_fetch_manifest SET state = 'planned' WHERE workflow_run_id = 1`)
	if err := os.Remove(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.Items[0].TargetPath))); err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	jobStatus, runStatus, lease, _, retries := loadJobState(t, db, 1)
	if jobStatus != "queued" || runStatus != "queued" || lease != "" || retries != 1 {
		t.Fatalf("job=%s run=%s lease=%q retries=%d", jobStatus, runStatus, lease, retries)
	}
	manifest, err := server.loadRemoteFetchManifest(context.Background(), 1)
	if err != nil || manifest.State != "planned" {
		t.Fatalf("manifest=%s, %v", manifest.State, err)
	}
	if _, err := os.Stat(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.Items[0].TargetPath))); !os.IsNotExist(err) {
		t.Fatalf("failed download published a target: %v", err)
	}
}

func TestRecoveryRepairsLegacyCompletedFetchResult(t *testing.T) {
	server, db := newFetchRecoveryServer(t)
	seedExecutableFetch(t, server, db, "https://source.example.invalid")
	execFetchTestStatements(t, db,
		`UPDATE remote_fetch_manifest SET state = 'completed' WHERE workflow_run_id = 1`,
		`UPDATE workflow_job SET status = 'succeeded' WHERE id = 1`,
		`UPDATE workflow_run SET status = 'running' WHERE id = 1`,
	)
	if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletedFetch(t, server, db)
}

// consolidateIntoExecutableFetch adds to the Fetch a local file copied from
// another folder of the work, as the Fetch dialog does when files are
// consolidated, and returns that folder.
func consolidateIntoExecutableFetch(t *testing.T, server *Server, db *sqlutil.DB, plan remoteWorkSavePlan) string {
	t.Helper()
	oldRoot := "Old/" + plan.PrimaryCode
	writeFetchTestFile(t, server.cfg.DataRoot, oldRoot+"/earlier.mp3", "earlier")
	// The fixture's Fetch is already published, so its copy is in place.
	writeFetchTestFile(t, server.cfg.DataRoot, plan.SaveRoot+"/earlier.mp3", "earlier")
	execFetchTestStatements(t, db,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (2, 1, 'audio', 'Earlier')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (2, 2, 'local', '`+oldRoot+`/earlier.mp3', 'available')`,
		`INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state) VALUES (1, 2, '`+oldRoot+`', 'external', 'active')`,
	)
	plan.Items = append(plan.Items, remoteWorkSavePlanItem{
		ItemKey: "local:" + oldRoot + "/earlier.mp3", Path: "earlier.mp3", Kind: "audio", SourceKind: "local",
		Action: "copy_local", Status: "copy_local", LocalSourcePath: oldRoot + "/earlier.mp3", MediaItemID: 2,
		TargetPath: plan.SaveRoot + "/earlier.mp3", OriginalTargetPath: plan.SaveRoot + "/earlier.mp3",
	})
	plan.Summary = summarizeRemoteSavePlan(plan.Items)
	if _, err := db.Exec(`UPDATE remote_fetch_manifest SET plan_json = ? WHERE workflow_run_id = 1`, mustJSON(plan)); err != nil {
		t.Fatal(err)
	}
	return oldRoot
}

// addUntouchedFetchSibling gives the work another folder the Fetch neither
// reads nor writes.
func addUntouchedFetchSibling(t *testing.T, server *Server, db *sqlutil.DB, code string) string {
	t.Helper()
	root := "Other/" + code
	writeFetchTestFile(t, server.cfg.DataRoot, root+"/other.mp3", "other")
	execFetchTestStatements(t, db, `INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state) VALUES (1, 2, '`+root+`', 'external', 'active')`)
	return root
}

func assertFetchFolderKept(t *testing.T, server *Server, db *sqlutil.DB, root string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(root))); err != nil {
		t.Fatalf("folder %s was moved: %v", root, err)
	}
	var state string
	if err := db.QueryRow(`SELECT state FROM work_folder_location WHERE root_path = ?`, root).Scan(&state); err != nil || state != "active" {
		t.Fatalf("folder %s state = %q, %v", root, state, err)
	}
}

func TestFetchWithoutLocalFilesKeepsEveryExistingFolder(t *testing.T) {
	server, db := newFetchRecoveryServer(t)
	plan := seedExecutableFetch(t, server, db, "https://source.example.invalid")
	sibling := addUntouchedFetchSibling(t, server, db, plan.PrimaryCode)
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletedFetch(t, server, db)
	assertFetchFolderKept(t, server, db, sibling)
	var candidates int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_candidate WHERE candidate_type = 'local_fetch_merge_cleanup'`).Scan(&candidates); err != nil || candidates != 0 {
		t.Fatalf("cleanup review candidates = %d, %v", candidates, err)
	}
}

func TestFetchRecoveryRetainsArchiveReviewAfterCandidateWriteFailure(t *testing.T) {
	ctx := context.Background()
	server, db := newFetchRecoveryServer(t)
	plan := seedExecutableFetch(t, server, db, "https://source.example.invalid")
	oldRoot := consolidateIntoExecutableFetch(t, server, db, plan)
	sibling := addUntouchedFetchSibling(t, server, db, plan.PrimaryCode)
	execFetchTestStatements(t, db, `CREATE TRIGGER fail_fetch_candidate BEFORE INSERT ON workflow_candidate
		WHEN NEW.candidate_type = 'local_fetch_merge_cleanup' BEGIN SELECT RAISE(ABORT, 'synthetic candidate write failure'); END`)
	if err := server.runNextQueuedWorkflowJob(ctx); err == nil || !strings.Contains(err.Error(), "synthetic candidate write failure") {
		t.Fatalf("expected failed candidate write: %v", err)
	}
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	jobStatus, runStatus, _, _, _ := loadJobState(t, db, 1)
	if manifest.State != "registered" || jobStatus != "failed" || runStatus != "failed" {
		t.Fatalf("manifest=%s job=%s run=%s", manifest.State, jobStatus, runStatus)
	}
	if _, err := os.Stat(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(oldRoot))); !os.IsNotExist(err) {
		t.Fatalf("old root should have moved before the candidate failure: %v", err)
	}
	execFetchTestStatements(t, db, `DROP TRIGGER fail_fetch_candidate`)
	if err := server.RecoverInterruptedWorkflows(ctx); err != nil {
		t.Fatal(err)
	}
	assertCompletedFetch(t, server, db)
	assertFetchFolderKept(t, server, db, sibling)
	var count, archivedCount int
	var archive, original string
	if err := db.QueryRow(`SELECT COUNT(*), json_array_length(payload_json, '$.archived_roots'), json_extract(payload_json, '$.archived_roots[0].archive_path'), json_extract(payload_json, '$.archived_roots[0].original_path') FROM workflow_candidate WHERE workflow_run_id = 1 AND candidate_type = 'local_fetch_merge_cleanup'`).Scan(&count, &archivedCount, &archive, &original); err != nil {
		t.Fatal(err)
	}
	if count != 1 || archivedCount != 1 || original != oldRoot {
		t.Fatalf("review candidates=%d archived=%d original=%q, want one archive of %s", count, archivedCount, original, oldRoot)
	}
	data, err := os.ReadFile(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(archive), "earlier.mp3"))
	if err != nil || string(data) != "earlier" {
		t.Fatalf("reviewable archive=%q, %v", data, err)
	}
}

// A Fetch composed by folder management copies no local file itself; its
// follow-up adds files from the work's other folders once the Fetch has
// finished, so finishing the Fetch must leave those folders in place.
func TestFetchFinishLeavesTheFollowUpSourcesInPlace(t *testing.T) {
	server, db := newFetchRecoveryServer(t)
	plan := seedPublishedFetch(t, server, db, 0, true)
	sourceRoot := addUntouchedFetchSibling(t, server, db, plan.PrimaryCode)
	execFetchTestStatements(t, db,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (2, 1, 'audio', 'Other')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (2, 2, 'local', '`+sourceRoot+`/other.mp3', 'available')`,
	)
	var folderID int64
	if err := db.QueryRow(`SELECT id FROM work_folder_location WHERE root_path = ?`, sourceRoot).Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	payload := remoteWorkFetchJobPayload{SourceID: 1, WorkCode: plan.PrimaryCode, FollowUp: &remoteFetchFollowUp{
		Additions: []workFolderEditAdditionRequest{{Kind: "local", FolderID: folderID, Path: "other.mp3"}},
	}}
	if _, err := db.Exec(`UPDATE workflow_run SET input_json = ? WHERE id = 1`, mustJSON(payload)); err != nil {
		t.Fatal(err)
	}
	if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertFetchFolderKept(t, server, db, sourceRoot)
	var followUpRunID sql.NullInt64
	var followUpError sql.NullString
	if err := db.QueryRow(`SELECT CAST(json_extract(summary_json, '$.follow_up_run_id') AS INTEGER), json_extract(summary_json, '$.follow_up_error') FROM workflow_run WHERE id = 1`).Scan(&followUpRunID, &followUpError); err != nil {
		t.Fatal(err)
	}
	if !followUpRunID.Valid || followUpRunID.Int64 <= 0 || followUpError.Valid {
		t.Fatalf("follow-up run = %v, error = %v", followUpRunID, followUpError)
	}
}

// A partial Fetch promotes only the selected files. The work's unselected
// files keep their cache and their remote streams.
func TestPartialFetchKeepsUnselectedCacheAndRemoteStreams(t *testing.T) {
	server, db := newFetchRecoveryServer(t)
	plan := seedPublishedFetch(t, server, db, 0, true)
	unselectedCache := "remote/" + plan.PrimaryCode + "/other.mp3"
	writeFetchTestFile(t, server.cfg.CacheRoot, unselectedCache, "other")
	execFetchTestStatements(t, db,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (2, 1, 'audio', 'Other')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (2, 1, 'remote_stream', 'other.mp3', 'available')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (2, 1, 'cache', '`+unselectedCache+`', 'available')`,
	)
	if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	var promotedStreams, unselectedStreams, unselectedCaches int
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND location_type = 'remote_stream'`).Scan(&promotedStreams); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 2 AND location_type = 'remote_stream'`).Scan(&unselectedStreams); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 2 AND location_type = 'cache' AND availability = 'available'`).Scan(&unselectedCaches); err != nil {
		t.Fatal(err)
	}
	if promotedStreams != 0 || unselectedStreams != 1 || unselectedCaches != 1 {
		t.Fatalf("promoted streams=%d unselected streams=%d unselected caches=%d", promotedStreams, unselectedStreams, unselectedCaches)
	}
	if _, err := os.Stat(filepath.Join(server.cfg.CacheRoot, filepath.FromSlash(unselectedCache))); err != nil {
		t.Fatalf("unselected cache file: %v", err)
	}
}

// A cancellation that arrives after a Fetch's publication swap started does not
// keep the run cancelled: the published Fetch registers its files, succeeds,
// and queues its follow-up.
func TestPublishedFetchSucceedsAfterALateCancel(t *testing.T) {
	server, db := newFetchRecoveryServer(t)
	plan := seedPublishedFetch(t, server, db, 0, true)
	sourceRoot := addUntouchedFetchSibling(t, server, db, plan.PrimaryCode)
	execFetchTestStatements(t, db,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (2, 1, 'audio', 'Other')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (2, 2, 'local', '`+sourceRoot+`/other.mp3', 'available')`,
		`UPDATE workflow_run SET status = 'cancelled' WHERE id = 1`,
		`UPDATE workflow_job SET status = 'cancelled' WHERE id = 1`,
	)
	var folderID int64
	if err := db.QueryRow(`SELECT id FROM work_folder_location WHERE root_path = ?`, sourceRoot).Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	payload := remoteWorkFetchJobPayload{SourceID: 1, WorkCode: plan.PrimaryCode, FollowUp: &remoteFetchFollowUp{
		Additions: []workFolderEditAdditionRequest{{Kind: "local", FolderID: folderID, Path: "other.mp3"}},
	}}
	if _, err := db.Exec(`UPDATE workflow_run SET input_json = ? WHERE id = 1`, mustJSON(payload)); err != nil {
		t.Fatal(err)
	}
	if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	jobStatus, runStatus, _, _, _ := loadJobState(t, db, 1)
	if jobStatus != "succeeded" || runStatus != "succeeded" {
		t.Fatalf("job=%s run=%s, want the published Fetch to succeed", jobStatus, runStatus)
	}
	var followUpRunID sql.NullInt64
	if err := db.QueryRow(`SELECT CAST(json_extract(summary_json, '$.follow_up_run_id') AS INTEGER) FROM workflow_run WHERE id = 1`).Scan(&followUpRunID); err != nil {
		t.Fatal(err)
	}
	if !followUpRunID.Valid || followUpRunID.Int64 <= 0 {
		t.Fatalf("follow-up run = %v, want it queued", followUpRunID)
	}
}

// In the running job, a cancellation that arrives once the publication swap
// has started, cancelling the job's context and the run, does not stop the
// Fetch: it registers its files, succeeds, and queues its follow-up.
func TestRunningFetchSucceedsAfterALateCancel(t *testing.T) {
	server, db := newFetchRecoveryServer(t)
	plan := seedPublishedFetch(t, server, db, 0, true)
	sourceRoot := addUntouchedFetchSibling(t, server, db, plan.PrimaryCode)
	execFetchTestStatements(t, db,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (2, 1, 'audio', 'Other')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (2, 2, 'local', '`+sourceRoot+`/other.mp3', 'available')`,
		`UPDATE workflow_run SET status = 'cancelled' WHERE id = 1`,
		`UPDATE workflow_job SET status = 'cancelled' WHERE id = 1`,
	)
	var folderID int64
	if err := db.QueryRow(`SELECT id FROM work_folder_location WHERE root_path = ?`, sourceRoot).Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	payload := remoteWorkFetchJobPayload{SourceID: 1, WorkCode: plan.PrimaryCode, FollowUp: &remoteFetchFollowUp{
		Additions: []workFolderEditAdditionRequest{{Kind: "local", FolderID: folderID, Path: "other.mp3"}},
	}}
	if _, err := db.Exec(`UPDATE workflow_run SET input_json = ? WHERE id = 1`, mustJSON(payload)); err != nil {
		t.Fatal(err)
	}
	manifest, err := server.loadRemoteFetchManifest(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	result, err := server.finishRemoteFetchAfterPublication(cancelled, 1, remoteWorkFetchExecution{manifest: manifest, plan: plan}, manifest, 1, remoteFetchMaterializeCounts{})
	if err != nil || result.Status != "succeeded" {
		t.Fatalf("result = %+v, %v", result, err)
	}
	jobStatus, runStatus, _, _, _ := loadJobState(t, db, 1)
	if jobStatus != "succeeded" || runStatus != "succeeded" {
		t.Fatalf("job=%s run=%s, want the published Fetch to succeed", jobStatus, runStatus)
	}
	var followUpRunID sql.NullInt64
	if err := db.QueryRow(`SELECT CAST(json_extract(summary_json, '$.follow_up_run_id') AS INTEGER) FROM workflow_run WHERE id = 1`).Scan(&followUpRunID); err != nil {
		t.Fatal(err)
	}
	if !followUpRunID.Valid || followUpRunID.Int64 <= 0 {
		t.Fatalf("follow-up run = %v, want it queued", followUpRunID)
	}
}
