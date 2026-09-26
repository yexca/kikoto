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
)

func seedExecutableFetch(t *testing.T, server *Server, db *sql.DB, sourceURL string) remoteWorkSavePlan {
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

func assertCompletedFetch(t *testing.T, server *Server, db *sql.DB) {
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

func TestFetchRecoveryRetainsArchiveReviewAfterCandidateWriteFailure(t *testing.T) {
	ctx := context.Background()
	server, db := newFetchRecoveryServer(t)
	plan := seedExecutableFetch(t, server, db, "https://source.example.invalid")
	oldRoot := "Old/" + plan.PrimaryCode
	writeFetchTestFile(t, server.cfg.DataRoot, oldRoot+"/earlier.mp3", "earlier")
	if _, err := db.Exec(`INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state) VALUES (1, 2, ?, 'external', 'active')`, oldRoot); err != nil {
		t.Fatal(err)
	}
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
	var count int
	var archive string
	if err := db.QueryRow(`SELECT COUNT(*), json_extract(payload_json, '$.archived_roots[0].archive_path') FROM workflow_candidate WHERE workflow_run_id = 1 AND candidate_type = 'local_fetch_merge_cleanup'`).Scan(&count, &archive); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("review candidates=%d, want one", count)
	}
	data, err := os.ReadFile(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(archive), "earlier.mp3"))
	if err != nil || string(data) != "earlier" {
		t.Fatalf("reviewable archive=%q, %v", data, err)
	}
}
