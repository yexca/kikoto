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

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestCacheMaintenanceScansAndExecutesRecoverableCleanup(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})

	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Referenced work')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'referenced.mp3'), (2, 1, 'audio', 'missing.mp3')`); err != nil {
		t.Fatal(err)
	}
	referencedRel := "media/example_remote/RJ/RJ00000000/referenced.mp3"
	missingRel := "media/example_remote/RJ/RJ00000000/missing.mp3"
	if _, err := db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 'cache', ?, 'available'), (2, 1, 'cache', ?, 'available')`, referencedRel, missingRel); err != nil {
		t.Fatal(err)
	}

	referencedPath := writeCacheTestFile(t, cacheRoot, referencedRel, "referenced", 48*time.Hour)
	orphanRel := "media/example_remote/RJ/RJ00000001/orphan.mp3"
	orphanPath := writeCacheTestFile(t, cacheRoot, orphanRel, "orphan", 48*time.Hour)
	recentRel := "media/example_remote/RJ/RJ00000002/recent.mp3"
	recentPath := writeCacheTestFile(t, cacheRoot, recentRel, "recent", time.Hour)
	emptyPath := filepath.Join(cacheRoot, "media", "example_remote", "RJ", "RJ00000003", "nested")
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

	queued, err := server.enqueueOrphanCacheCleanup(context.Background(), nil)
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
	if _, err := os.Stat(filepath.Join(cacheRoot, "media", "example_remote", "RJ", "RJ00000003")); !os.IsNotExist(err) {
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
	relPath := "media/example_remote/RJ/RJ00000004/track.mp3"
	path := writeCacheTestFile(t, cacheRoot, relPath, "audio", 48*time.Hour)

	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000004', 'Late reference')`); err != nil {
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

func TestCacheMaintenanceQueuesOnlySelectedOrphanGroup(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	firstRel := "media/remote_a/RJ/RJ00000005/first.mp3"
	secondRel := "media/remote_a/RJ/RJ00000006/second.mp3"
	writeCacheTestFile(t, cacheRoot, firstRel, "first", 48*time.Hour)
	writeCacheTestFile(t, cacheRoot, secondRel, "second", 48*time.Hour)

	result, err := server.enqueueOrphanCacheCleanup(context.Background(), []string{cacheGroupKey(0, "remote_a", "RJ00000005")})
	if err != nil {
		t.Fatal(err)
	}
	if result.Queued != 1 {
		t.Fatalf("queued = %d, want 1", result.Queued)
	}
	job := loadCacheMaintenanceJob(t, server, result.JobID)
	var payload cacheOrphanCleanupPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Files) != 1 || payload.Files[0] != firstRel {
		t.Fatalf("files = %#v, want only %q", payload.Files, firstRel)
	}
}

func TestCacheMaintenanceQueuesOnlySelectedWorkCache(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote_a', 'Remote A', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000007', 'First'), (2, 'RJ00000008', 'Second')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'first.mp3'), (2, 2, 'audio', 'second.mp3')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (11, 1, 1, 'cache', 'media/remote_a/RJ/RJ00000007/first.mp3', 'available'), (12, 2, 1, 'cache', 'media/remote_a/RJ/RJ00000008/second.mp3', 'available')`); err != nil {
		t.Fatal(err)
	}

	result, err := server.enqueueWorkCacheCleanup(context.Background(), []int64{2})
	if err != nil {
		t.Fatal(err)
	}
	if result.Queued != 1 {
		t.Fatalf("queued = %d, want 1", result.Queued)
	}
	job := loadCacheMaintenanceJob(t, server, result.JobID)
	var payload mediaCleanupJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Targets) != 1 || payload.Targets[0].WorkID != 2 || payload.Targets[0].LocationID != 12 {
		t.Fatalf("targets = %#v, want only work 2 location 12", payload.Targets)
	}
}

func TestCacheLimitProtectsActiveRemoteFetchInputs(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	activeRel := "media/example_remote/RJ/RJ00000000/active.mp3"
	otherRel := "media/example_remote/RJ/RJ00000000/other.mp3"
	activePath := writeCacheTestFile(t, cacheRoot, activeRel, "active", 48*time.Hour)
	otherPath := writeCacheTestFile(t, cacheRoot, otherRel, "other", 48*time.Hour)
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type) VALUES
			(1, 'example_remote', 'Example Remote', 'kikoeru_compatible'),
			(2, 'main_local', 'Main local', 'local_folder');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Active Fetch');
		INSERT INTO media_item (id, work_id, kind, title) VALUES
			(1, 1, 'audio', 'active.mp3'),
			(2, 1, 'audio', 'other.mp3');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, size_bytes, availability, last_checked_at) VALUES
			(11, 1, 1, 'cache', 'media/example_remote/RJ/RJ00000000/active.mp3', 6, 'available', '2020-01-01 00:00:00'),
			(12, 2, 1, 'cache', 'media/example_remote/RJ/RJ00000000/other.mp3', 5, 'available', '2020-01-01 00:00:01');
		INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type)
		VALUES (1, 'remote_work_fetch', 'Active Fetch', 'running', 'manual');
		INSERT INTO remote_fetch_manifest (
			id, workflow_run_id, work_id, remote_source_id, local_source_id, edition_code,
			target_root, staging_root, state, plan_json
		) VALUES (
			1, 1, 1, 1, 2, 'RJ00000000', 'library/RJ00000000', '.kikoto-staging/1/work', 'planned',
			'{"sourceId":1,"items":[{"action":"cache_hit","cachePath":"media/example_remote/RJ/RJ00000000/active.mp3"}]}'
		);
	`); err != nil {
		t.Fatal(err)
	}

	protected, err := server.activeRemoteFetchCacheKeys(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := protected[cacheLocationKey(1, activeRel)]; !ok {
		t.Fatalf("active Fetch cache key not protected: %#v", protected)
	}
	if _, ok := protected[cacheLocationKey(1, otherRel)]; ok {
		t.Fatalf("unselected cache key was protected: %#v", protected)
	}

	removed, _, err := server.trimCacheScope(context.Background(), 0, 1, 0, protected)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want only the unprotected cache file", removed)
	}
	if _, err := os.Stat(activePath); err != nil {
		t.Fatalf("active Fetch cache was removed: %v", err)
	}
	if _, err := os.Stat(otherPath); !os.IsNotExist(err) {
		t.Fatalf("unprotected cache still exists or stat failed: %v", err)
	}
}

func TestCacheMaintenanceRejectsInvalidCleanupRequest(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	for _, body := range []string{`{"mode":"unknown"}`, `{invalid`} {
		request := httptest.NewRequest(http.MethodPost, "/api/cache/cleanup", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"downloads:manage"}}))
		response := httptest.NewRecorder()
		server.cleanupOrphanCache(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %q status = %d, want %d", body, response.Code, http.StatusBadRequest)
		}
	}
}

func TestCacheMaintenanceRequiresDownloadsManage(t *testing.T) {
	server := NewServer(nil, config.Config{})
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/cache/overview", nil),
		httptest.NewRequest(http.MethodPost, "/api/cache/cleanup", nil),
		httptest.NewRequest(http.MethodDelete, "/api/cache/transcodes", nil),
	} {
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"library:read"}}))
		response := httptest.NewRecorder()
		if request.Method == http.MethodGet {
			server.getCacheOverview(response, request)
		} else if request.Method == http.MethodDelete {
			server.clearTranscodeCache(response, request)
		} else {
			server.cleanupOrphanCache(response, request)
		}
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s status = %d, want %d", request.Method, response.Code, http.StatusForbidden)
		}
	}
}

func TestCacheMaintenanceReportsAndClearsTranscodes(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	writeCacheTestFile(t, cacheRoot, "transcodes/hls/1/revision/segment-000000.ts", "first", time.Hour)
	writeCacheTestFile(t, cacheRoot, "transcodes/hls/1/revision/segment-000001.ts", "second", time.Hour)
	actor := currentUser{ID: 1, Permissions: []string{"downloads:manage"}}

	overviewRequest := httptest.NewRequest(http.MethodGet, "/api/cache/overview", nil)
	overviewRequest = overviewRequest.WithContext(context.WithValue(overviewRequest.Context(), currentUserKey, actor))
	overviewResponse := httptest.NewRecorder()
	server.getCacheOverview(overviewResponse, overviewRequest)
	if overviewResponse.Code != http.StatusOK {
		t.Fatalf("overview status = %d, body = %s", overviewResponse.Code, overviewResponse.Body.String())
	}
	var overview cacheOverview
	if err := json.Unmarshal(overviewResponse.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	if overview.Transcode.Files != 2 || overview.Transcode.Bytes != 11 || overview.Transcode.LimitBytes != int64(5)<<30 {
		t.Fatalf("transcode overview = %+v", overview.Transcode)
	}

	clearRequest := httptest.NewRequest(http.MethodDelete, "/api/cache/transcodes", nil)
	clearRequest = clearRequest.WithContext(context.WithValue(clearRequest.Context(), currentUserKey, actor))
	clearResponse := httptest.NewRecorder()
	server.clearTranscodeCache(clearResponse, clearRequest)
	if clearResponse.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body = %s", clearResponse.Code, clearResponse.Body.String())
	}
	var cleared transcodeCacheClearResult
	if err := json.Unmarshal(clearResponse.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.DeletedFiles != 2 || cleared.FreedBytes != 11 {
		t.Fatalf("clear result = %+v", cleared)
	}
	if _, err := os.Stat(filepath.Join(cacheRoot, "transcodes")); !os.IsNotExist(err) {
		t.Fatalf("transcode cache root still exists or stat failed: %v", err)
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
