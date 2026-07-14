package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestCacheMaintenanceScansAndExecutesRecoverableCleanup(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})

	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ09990001', 'Referenced work')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'referenced.mp3'), (2, 1, 'audio', 'missing.mp3')`); err != nil {
		t.Fatal(err)
	}
	referencedRel := "media/example_remote/RJ/RJ09990001/referenced.mp3"
	missingRel := "media/example_remote/RJ/RJ09990001/missing.mp3"
	if _, err := db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 'cache', ?, 'available'), (2, 1, 'cache', ?, 'available')`, referencedRel, missingRel); err != nil {
		t.Fatal(err)
	}

	referencedPath := writeCacheTestFile(t, cacheRoot, referencedRel, "referenced", 48*time.Hour)
	orphanRel := "media/example_remote/RJ/RJ09990002/orphan.mp3"
	orphanPath := writeCacheTestFile(t, cacheRoot, orphanRel, "orphan", 48*time.Hour)
	recentRel := "media/example_remote/RJ/RJ09990003/recent.mp3"
	recentPath := writeCacheTestFile(t, cacheRoot, recentRel, "recent", time.Hour)
	emptyPath := filepath.Join(cacheRoot, "media", "example_remote", "RJ", "RJ09990004", "nested")
	if err := os.MkdirAll(emptyPath, 0o755); err != nil {
		t.Fatal(err)
	}

	scan, err := server.scanManagedMediaCache(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if scan.Overview.MediaFiles != 3 || scan.Overview.ReferencedFiles != 1 || scan.Overview.OrphanFiles != 1 || scan.Overview.ProtectedFiles != 1 {
		t.Fatalf("unexpected scan counts: %+v", scan.Overview)
	}
	if scan.Overview.MissingReferences != 1 || scan.Overview.EmptyDirectories != 1 {
		t.Fatalf("unexpected reference/directory counts: %+v", scan.Overview)
	}
	if len(scan.OrphanPaths) != 1 || scan.OrphanPaths[0] != orphanRel {
		t.Fatalf("orphan paths = %#v", scan.OrphanPaths)
	}

	queued, err := server.enqueueOrphanCacheCleanup(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if queued.Status != "queued" || queued.Queued != 2 {
		t.Fatalf("cleanup result = %+v, want one file and one empty directory", queued)
	}
	job := loadCacheMaintenanceJob(t, server, queued.JobID)
	if _, err := db.Exec("UPDATE workflow_job SET status = 'running' WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if err := server.executeCacheOrphanCleanupJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(orphanPath); !os.IsNotExist(err) {
		t.Fatalf("old orphan still exists or stat failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cacheRoot, "media", "example_remote", "RJ", "RJ09990004")); !os.IsNotExist(err) {
		t.Fatalf("empty parent tree still exists or stat failed: %v", err)
	}
	for _, path := range []string{referencedPath, recentPath} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("protected cache file %s was removed: %v", path, err)
		}
	}
	var runStatus, jobStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_job WHERE id = ?", queued.JobID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" || jobStatus != "succeeded" {
		t.Fatalf("cleanup statuses = run %q, job %q", runStatus, jobStatus)
	}
}

func TestCacheCleanupRechecksDatabaseReferenceBeforeDelete(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	relPath := "media/example_remote/RJ/RJ09990100/track.mp3"
	path := writeCacheTestFile(t, cacheRoot, relPath, "audio", 48*time.Hour)

	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ09990100', 'Late reference')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'track.mp3')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 'cache', ?, 'available')`, relPath); err != nil {
		t.Fatal(err)
	}

	deleted, _, err := server.deleteOrphanCacheFile(context.Background(), relPath)
	if err != nil {
		t.Fatal(err)
	}
	if deleted {
		t.Fatal("referenced file was deleted")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("referenced file missing: %v", err)
	}
}

func TestCacheMaintenanceRequiresDownloadsManage(t *testing.T) {
	server := NewServer(nil, config.Config{})
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/cache/overview", nil),
		httptest.NewRequest(http.MethodPost, "/api/cache/cleanup", nil),
	} {
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"library:read"}}))
		response := httptest.NewRecorder()
		if request.Method == http.MethodGet {
			server.getCacheOverview(response, request)
		} else {
			server.cleanupOrphanCache(response, request)
		}
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s status = %d, want %d", request.Method, response.Code, http.StatusForbidden)
		}
	}
}

func writeCacheTestFile(t *testing.T, root, relPath, content string, age time.Duration) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relPath))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	modified := time.Now().Add(-age)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	return path
}

func loadCacheMaintenanceJob(t *testing.T, server *Server, jobID int64) workflowJobRecord {
	t.Helper()
	var job workflowJobRecord
	if err := server.db.QueryRow(`SELECT id, workflow_run_id, workflow_node_run_id, worker_type, payload_json, checkpoint_json,
		'', resume_count, retry_count, max_retries FROM workflow_job WHERE id = ?`, jobID).Scan(
		&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON, &job.CheckpointJSON,
		&job.LockedBy, &job.ResumeCount, &job.RetryCount, &job.MaxRetries,
	); err != nil {
		t.Fatal(err)
	}
	return job
}
