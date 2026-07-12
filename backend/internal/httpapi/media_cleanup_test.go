package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestMediaLocationCleanupQueuesAndExecutesMixedTargets(t *testing.T) {
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	localPath := filepath.Join("RJTEST001", "audio", "local.mp3")
	if err := os.MkdirAll(filepath.Join(dataRoot, "RJTEST001", "audio"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, localPath), []byte("local"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheRoot, "cached.mp3"), []byte("cache"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	localID := insertTestLocalMediaLocation(t, db, filepath.ToSlash(localPath))
	var mediaItemID, sourceID int64
	if err := db.QueryRow("SELECT media_item_id, file_source_id FROM media_file_location WHERE id = ?", localID).Scan(&mediaItemID, &sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability)
		SELECT work_id, ?, 'local', 'RJTEST001', 'available' FROM media_item WHERE id = ?`, sourceID, mediaItemID); err != nil {
		t.Fatal(err)
	}
	result, err := db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'cache', 'cached.mp3', 'available')`, mediaItemID, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	cacheID, _ := result.LastInsertId()
	result, err = db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'remote_stream', 'remote.mp3', 'available')`, mediaItemID, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	remoteID, _ := result.LastInsertId()

	queued, err := server.enqueueMediaLocationCleanup(context.Background(), []mediaCleanupTargetRequest{
		{Kind: "local", LocationID: localID},
		{Kind: "cache", LocationID: cacheID},
		{Kind: "cache", LocationID: cacheID},
		{Kind: "local_root", LocationID: localID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if queued.Status != "queued" || queued.Queued != 3 {
		t.Fatalf("queued result = %#v, want three unique queued targets", queued)
	}
	var job workflowJobRecord
	if err := db.QueryRow(`SELECT id, workflow_run_id, workflow_node_run_id, worker_type, payload_json, checkpoint_json,
		'', resume_count, retry_count, max_retries FROM workflow_job WHERE id = ?`, queued.JobID).Scan(
		&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON, &job.CheckpointJSON,
		&job.LockedBy, &job.ResumeCount, &job.RetryCount, &job.MaxRetries,
	); err != nil {
		t.Fatal(err)
	}
	if job.WorkerType != "media_location_cleanup" {
		t.Fatalf("worker type = %q", job.WorkerType)
	}
	if deleted, err := server.clearLocalMediaLocation(context.Background(), localID, filepath.ToSlash(localPath)); err != nil || !deleted {
		t.Fatalf("seed completed local cleanup = deleted %t, error %v", deleted, err)
	}
	job.CheckpointJSON = mustJSON(mediaCleanupCheckpoint{CompletedKeys: []string{mediaCleanupTargetKey(mediaCleanupTarget{Kind: "local", LocationID: localID})}, Deleted: 1})
	if _, err := db.Exec("UPDATE workflow_job SET status = 'running' WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if err := server.executeMediaLocationCleanupJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(dataRoot, "RJTEST001"), filepath.Join(cacheRoot, "cached.mp3")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("path %s still exists or stat failed unexpectedly: %v", path, err)
		}
	}
	for _, id := range []int64{localID, cacheID} {
		var availability string
		if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", id).Scan(&availability); err != nil {
			t.Fatal(err)
		}
		if availability != "unavailable" {
			t.Fatalf("location %d availability = %q", id, availability)
		}
	}
	var remoteAvailability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", remoteID).Scan(&remoteAvailability); err != nil {
		t.Fatal(err)
	}
	if remoteAvailability != "available" {
		t.Fatalf("remote location availability = %q, want available", remoteAvailability)
	}
	var localPresence string
	if err := db.QueryRow("SELECT availability FROM work_source_presence WHERE file_source_id = ? AND presence_type = 'local'", sourceID).Scan(&localPresence); err != nil {
		t.Fatal(err)
	}
	if localPresence != "unavailable" {
		t.Fatalf("local presence availability = %q, want unavailable", localPresence)
	}
	var runStatus, jobStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_job WHERE id = ?", queued.JobID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" || jobStatus != "succeeded" {
		t.Fatalf("statuses = run %q job %q", runStatus, jobStatus)
	}
	var summary string
	if err := db.QueryRow("SELECT summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if summary != `{"deleted":3,"locations":3}` {
		t.Fatalf("summary = %s, want recovered total delete count", summary)
	}
}

func TestMediaCleanupRequiresDownloadsManage(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/media/cleanup", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"library:read"},
	}))
	response := httptest.NewRecorder()

	server.cleanupMediaLocations(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestFetchSubmissionRequiresDownloadsManage(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/remote-sources/1/works/RJTEST001/fetch", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"library:read"},
	}))
	response := httptest.NewRecorder()

	server.saveRemoteSourceWork(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestFetchPlanRequiresDownloadsManageBecauseItMaySyncMetadata(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/remote-sources/1/works/RJTEST001/fetch-plan", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"library:read"},
	}))
	response := httptest.NewRecorder()

	server.planRemoteSourceWorkSave(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}
