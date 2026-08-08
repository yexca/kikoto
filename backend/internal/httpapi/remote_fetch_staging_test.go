package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestFetchArchivesOldLocalRootAndReviewDeletesArchive(t *testing.T) {
	dataRoot := t.TempDir()
	oldRoot := filepath.Join(dataRoot, "Library", "RJ00000001")
	publishedRoot := filepath.Join(dataRoot, "remote", "RJ", "012", "RJ00000001")
	if err := os.MkdirAll(oldRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(publishedRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(oldRoot, "old.mp3"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Work')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'Old', 'old')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'local', 'Library/RJ00000001/old.mp3', 'available')`,
		`INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary) VALUES (1, 1, 1, 'Library/RJ00000001', 'external', 'active', 0), (2, 1, 1, 'remote/RJ/000/RJ00000001', 'managed_fetch', 'active', 1)`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'succeeded', 'manual')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	archived, err := server.quarantineFetchLocalRoots(context.Background(), 1, 1, 1, []remoteWorkSavePlanItem{{TargetPath: "remote/RJ/000/RJ00000001/track.mp3"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(archived) != 1 {
		t.Fatalf("archived roots = %d, want 1", len(archived))
	}
	archivePath := archived[0]["archive_path"].(string)
	if _, err := os.Stat(oldRoot); !os.IsNotExist(err) {
		t.Fatalf("old root still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, filepath.FromSlash(archivePath), "old.mp3")); err != nil {
		t.Fatalf("archived file: %v", err)
	}
	var folderState, locationAvailability string
	if err := db.QueryRow("SELECT state FROM work_folder_location WHERE id = 1").Scan(&folderState); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = 1").Scan(&locationAvailability); err != nil {
		t.Fatal(err)
	}
	if folderState != "pending_cleanup" || locationAvailability != "unavailable" {
		t.Fatalf("state = %q, availability = %q", folderState, locationAvailability)
	}
	result, err := db.Exec(`INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json) VALUES (1, 'local_fetch_merge_cleanup', 'RJ00000001', 'pending', ?)`, mustJSON(map[string]any{"archived_roots": archived}))
	if err != nil {
		t.Fatal(err)
	}
	candidateID, _ := result.LastInsertId()
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-candidates/1/archived-root-review", strings.NewReader(`{"action":"delete_archived","confirm":"DELETE"}`))
	request.SetPathValue("id", fmt.Sprintf("%d", candidateID))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"workflows:run"}}))
	response := httptest.NewRecorder()
	server.reviewArchivedFetchRoots(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("review status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dataRoot, filepath.FromSlash(archivePath))); !os.IsNotExist(err) {
		t.Fatalf("archive still exists: %v", err)
	}
	var remaining int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_folder_location WHERE id = 1").Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("remaining folder rows = %d, error = %v", remaining, err)
	}
}

func TestStageAndPublishRemoteFetchKeepsCacheAndPublishesCompleteRoot(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := filepath.Join(t.TempDir(), "data")
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	ctx := context.Background()
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Work')`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'running', 'manual')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status) VALUES (1, 1, 'remote_work_fetch', 'running')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	content := []byte("verified audio payload")
	cachePath := filepath.Join(cacheRoot, "remote", "RJ00000001", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, content, 0o644); err != nil {
		t.Fatal(err)
	}
	size := int64(len(content))
	plan := remoteWorkSavePlan{
		SourceID: 1, PrimaryCode: "RJ00000001", SaveRoot: "remote/RJ00000001",
		Items: []remoteWorkSavePlanItem{{ItemKey: "remote:track.mp3", Path: "track.mp3", Kind: "audio", SizeBytes: &size, SourceKind: "remote", Action: "cache_hit", CachePath: "remote/RJ00000001/track.mp3", TargetPath: "remote/RJ00000001/track.mp3", OriginalTargetPath: "remote/RJ00000001/track.mp3", Resolution: "auto", RemoteSourceID: 1, SourcePath: "https://remote.invalid/track.mp3"}},
	}
	plan.Summary = summarizeRemoteSavePlan(plan.Items)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createRemoteFetchManifest(ctx, tx, 1, 1, "", 1, 1, 2, plan); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var manifestSourceID int64
	var manifestResolution, manifestSourcePath string
	if err := db.QueryRow(`SELECT remote_source_id, resolution, source_path FROM remote_fetch_manifest_item WHERE manifest_id = 1`).Scan(&manifestSourceID, &manifestResolution, &manifestSourcePath); err != nil {
		t.Fatal(err)
	}
	if manifestSourceID != 1 || manifestResolution != "auto" || manifestSourcePath != "https://remote.invalid/track.mp3" {
		t.Fatalf("manifest source=%d resolution=%q path=%q", manifestSourceID, manifestResolution, manifestSourcePath)
	}
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if promoted, err := server.stageAndPublishRemoteFetch(ctx, manifest, plan); err != nil || promoted != 1 {
		t.Fatalf("promoted=%d err=%v", promoted, err)
	}
	target := filepath.Join(dataRoot, "remote", "RJ00000001", "track.mp3")
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(content) {
		t.Fatalf("target content = %q", got)
	}
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("cache should remain reusable: %v", err)
	}
	manifest, err = server.loadRemoteFetchManifest(ctx, 1)
	if err != nil || manifest.State != "published" {
		t.Fatalf("manifest = %+v err=%v", manifest, err)
	}
}

func TestCleanupPromotedFetchCacheRemovesOnlySelectedItems(t *testing.T) {
	db := openMigratedTestDB(t)
	cacheRoot := t.TempDir()
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Work')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'Selected', 'selected'), (2, 1, 'audio', 'Other', 'other')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES
			(1, 1, 'cache', 'remote/RJ00000001/selected.mp3', 'available'),
			(2, 1, 'cache', 'remote/RJ00000001/other.flac', 'available')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	selectedPath := filepath.Join(cacheRoot, "remote", "RJ00000001", "selected.mp3")
	otherPath := filepath.Join(cacheRoot, "remote", "RJ00000001", "other.flac")
	if err := os.MkdirAll(filepath.Dir(selectedPath), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{selectedPath, otherPath} {
		if err := os.WriteFile(path, []byte("cache"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	plan := remoteWorkSavePlan{Items: []remoteWorkSavePlanItem{{
		Action: "cache_hit", RemoteSourceID: 1, CachePath: "remote/RJ00000001/selected.mp3",
	}}}
	removed, err := server.cleanupPromotedFetchCache(context.Background(), plan, 1)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	if _, err := os.Stat(selectedPath); !os.IsNotExist(err) {
		t.Fatalf("selected cache still exists: %v", err)
	}
	if _, err := os.Stat(otherPath); err != nil {
		t.Fatalf("unselected cache was removed: %v", err)
	}
	var selectedAvailability, otherAvailability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE media_item_id = 1").Scan(&selectedAvailability); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE media_item_id = 2").Scan(&otherAvailability); err != nil {
		t.Fatal(err)
	}
	if selectedAvailability != "unavailable" || otherAvailability != "available" {
		t.Fatalf("availability selected=%s other=%s", selectedAvailability, otherAvailability)
	}
}

func TestCleanupPromotedFetchCacheKeepsTrackedSourceCache(t *testing.T) {
	db := openMigratedTestDB(t)
	cacheRoot := t.TempDir()
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'synthetic_remote')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'TEST-WORK-001', 'Work')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'Selected', 'selected')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES (1, 1, 'tracked', 'TEST-WORK-001', 'available')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 'cache', 'remote/TEST-WORK-001/selected.mp3', 'available')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	cachePath := filepath.Join(cacheRoot, "remote", "TEST-WORK-001", "selected.mp3")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, []byte("cache"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := remoteWorkSavePlan{SourceID: 1, Items: []remoteWorkSavePlanItem{{
		Action: "cache_hit", RemoteSourceID: 1, CachePath: "remote/TEST-WORK-001/selected.mp3",
	}}}
	removed, err := server.cleanupPromotedFetchCache(context.Background(), plan, 1)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 {
		t.Fatalf("removed = %d, want 0", removed)
	}
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("tracked source cache was removed: %v", err)
	}
	var availability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE media_item_id = 1").Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "available" {
		t.Fatalf("availability = %s, want available", availability)
	}
}

func TestReconcileRemoteFetchDoesNotRequeueFailedRun(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	ctx := context.Background()
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Work')`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type, finished_at) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'failed', 'manual', CURRENT_TIMESTAMP)`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status, recoverable, max_retries, retry_count) VALUES (1, 1, 'remote_work_fetch', 'failed', 1, 5, 2)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	plan := remoteWorkSavePlan{SourceID: 1, PrimaryCode: "RJ00000001", SaveRoot: "remote/RJ00000001", Items: []remoteWorkSavePlanItem{}}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createRemoteFetchManifest(ctx, tx, 1, 1, "", 1, 1, 2, plan); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := server.reconcileRemoteFetchManifests(ctx); err != nil {
		t.Fatal(err)
	}
	var runStatus, jobStatus string
	var retryCount int
	if err := db.QueryRow(`SELECT run.status, job.status, job.retry_count FROM workflow_run AS run INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id WHERE run.id = 1`).Scan(&runStatus, &jobStatus, &retryCount); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || jobStatus != "failed" || retryCount != 2 {
		t.Fatalf("run=%s job=%s retries=%d", runStatus, jobStatus, retryCount)
	}
}

func TestCleanupExpiredRemoteFetchStagingRemovesOnlyEligibleStateAndKeepsRetry(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir()})
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Work')`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type, finished_at) VALUES
			(1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Expired failed Fetch', 'failed', 'manual', '2026-07-20 00:00:00'),
			(2, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Recent cancelled Fetch', 'cancelled', 'manual', '2026-08-03 00:00:00'),
			(3, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Active Fetch', 'running', 'manual', NULL),
			(4, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Published Fetch', 'failed', 'manual', '2026-07-20 00:00:00'),
			(5, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Completed Fetch', 'succeeded', 'manual', '2026-07-20 00:00:00')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status, recoverable, max_retries) VALUES (1, 1, 'remote_work_fetch', 'failed', 1, 5)`,
		`INSERT INTO remote_fetch_manifest (id, workflow_run_id, workflow_job_id, work_id, remote_source_id, local_source_id, edition_code, target_root, staging_root, backup_root, state, plan_json, updated_at) VALUES
			(1, 1, 1, 1, 1, 2, 'RJ00000000', 'library/RJ00000000', 'outside/ignored', '.kikoto-backup/1/work', 'staged', '{}', '2026-07-20 00:00:00'),
			(2, 2, NULL, 1, 1, 2, 'RJ00000000', 'library/RJ00000000', '.kikoto-staging/2/work', '.kikoto-backup/2/work', 'staged', '{}', '2026-08-03 00:00:00'),
			(3, 3, NULL, 1, 1, 2, 'RJ00000000', 'library/RJ00000000', '.kikoto-staging/3/work', '.kikoto-backup/3/work', 'staged', '{}', '2026-07-20 00:00:00'),
			(4, 4, NULL, 1, 1, 2, 'RJ00000000', 'library/RJ00000000', '.kikoto-staging/4/work', '.kikoto-backup/4/work', 'published', '{}', '2026-07-20 00:00:00'),
			(5, 5, NULL, 1, 1, 2, 'RJ00000000', 'library/RJ00000000', '.kikoto-staging/5/work', '.kikoto-backup/5/work', 'completed', '{}', '2026-07-20 00:00:00')`,
		`INSERT INTO remote_fetch_manifest_item (manifest_id, relative_path, target_path, source_kind, action, state, content_hash, error_message) VALUES (1, 'track.mp3', 'library/RJ00000000/track.mp3', 'remote', 'cache_download', 'verified', 'hash', 'old error')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, runID := range []int{1, 2, 3, 4, 5} {
		root := filepath.Join(dataRoot, ".kikoto-staging", fmt.Sprintf("%d", runID), "work")
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "track.mp3"), []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(dataRoot, "outside", "sentinel.txt")
	if err := os.MkdirAll(filepath.Dir(outside), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := server.cleanupExpiredRemoteFetchStaging(context.Background(), time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if result.Cleaned != 1 || result.Blocked != 0 || result.Files != 1 || result.Bytes != 5 {
		t.Fatalf("cleanup result = %+v", result)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, ".kikoto-staging", "1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expired staging still exists: %v", err)
	}
	for _, runID := range []int{2, 3, 4, 5} {
		if _, err := os.Stat(filepath.Join(dataRoot, ".kikoto-staging", fmt.Sprintf("%d", runID), "work", "track.mp3")); err != nil {
			t.Fatalf("run %d staging should remain: %v", runID, err)
		}
	}
	if content, err := os.ReadFile(outside); err != nil || string(content) != "keep" {
		t.Fatalf("stored manifest path escaped fixed staging namespace: content=%q err=%v", content, err)
	}
	var state, cleanedAt, itemState, itemHash, itemError string
	if err := db.QueryRow(`SELECT state, COALESCE(staging_cleaned_at, '') FROM remote_fetch_manifest WHERE id = 1`).Scan(&state, &cleanedAt); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT state, content_hash, error_message FROM remote_fetch_manifest_item WHERE manifest_id = 1`).Scan(&itemState, &itemHash, &itemError); err != nil {
		t.Fatal(err)
	}
	if state != "planned" || cleanedAt == "" || itemState != "planned" || itemHash != "" || itemError != "" {
		t.Fatalf("manifest state=%q cleaned=%q item=%q hash=%q error=%q", state, cleanedAt, itemState, itemHash, itemError)
	}
	var cleanupEvents int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = 1 AND event_type = 'fetch.staging_cleaned'`).Scan(&cleanupEvents); err != nil || cleanupEvents != 1 {
		t.Fatalf("cleanup events=%d err=%v", cleanupEvents, err)
	}
	if err := server.retryFailedWorkflowJob(context.Background(), 1); err != nil {
		t.Fatalf("retry after cleanup: %v", err)
	}
	var runStatus, jobStatus, retryCleanedAt string
	if err := db.QueryRow(`SELECT run.status, job.status, COALESCE(manifest.staging_cleaned_at, '') FROM workflow_run AS run INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id INNER JOIN remote_fetch_manifest AS manifest ON manifest.workflow_run_id = run.id WHERE run.id = 1`).Scan(&runStatus, &jobStatus, &retryCleanedAt); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" || jobStatus != "queued" || retryCleanedAt != "" {
		t.Fatalf("retry state run=%q job=%q cleaned=%q", runStatus, jobStatus, retryCleanedAt)
	}
}

func TestCleanupExpiredRemoteFetchStagingStopsAtSymlink(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Work')`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type, finished_at) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'failed', 'manual', '2026-07-20 00:00:00')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status, recoverable, max_retries) VALUES (1, 1, 'remote_work_fetch', 'failed', 1, 5)`,
		`INSERT INTO remote_fetch_manifest (id, workflow_run_id, workflow_job_id, work_id, remote_source_id, local_source_id, edition_code, target_root, staging_root, backup_root, state, plan_json, updated_at) VALUES (1, 1, 1, 1, 1, 2, 'RJ00000000', 'library/RJ00000000', '.kikoto-staging/1/work', '.kikoto-backup/1/work', 'staged', '{}', '2026-07-20 00:00:00')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	stagingRoot := filepath.Join(dataRoot, ".kikoto-staging", "1", "work")
	if err := os.MkdirAll(stagingRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "outside.mp3")
	if err := os.WriteFile(target, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(stagingRoot, "linked.mp3")); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}
	result, err := server.cleanupExpiredRemoteFetchStaging(context.Background(), time.Date(2026, 8, 4, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if result.Cleaned != 0 || result.Blocked != 1 {
		t.Fatalf("cleanup result = %+v", result)
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != "outside" {
		t.Fatalf("symlink target changed: content=%q err=%v", content, err)
	}
	var state, cleanedAt, detail string
	if err := db.QueryRow(`SELECT state, COALESCE(staging_cleaned_at, '') FROM remote_fetch_manifest WHERE id = 1`).Scan(&state, &cleanedAt); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT detail_json FROM workflow_event WHERE workflow_run_id = 1 AND event_type = 'fetch.staging_cleanup_blocked'`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if state != "cleaning_staging" || cleanedAt != "" || strings.Contains(detail, dataRoot) || strings.Contains(detail, target) {
		t.Fatalf("blocked cleanup state=%q cleaned=%q detail=%q", state, cleanedAt, detail)
	}
	if err := server.requeueFailedWorkflowJob(context.Background(), workflowJobRecord{ID: 1, RunID: 1, WorkerType: "remote_work_fetch"}, 0, "retry"); err == nil || !strings.Contains(err.Error(), "cleanup is in progress") {
		t.Fatalf("retry during blocked cleanup error = %v", err)
	}
}

func TestRemoveFetchStagingTreeRejectsSymlinkedNamespace(t *testing.T) {
	dataRoot := t.TempDir()
	outsideRoot := t.TempDir()
	outsideRun := filepath.Join(outsideRoot, "1")
	if err := os.MkdirAll(outsideRun, 0o755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(outsideRun, "keep.txt")
	if err := os.WriteFile(sentinel, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideRoot, filepath.Join(dataRoot, ".kikoto-staging")); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}

	_, err := removeFetchStagingTree(dataRoot, filepath.Join(dataRoot, ".kikoto-staging", "1"))
	if err == nil {
		t.Fatal("cleanup accepted a symlinked staging namespace")
	}
	if content, readErr := os.ReadFile(sentinel); readErr != nil || string(content) != "keep" {
		t.Fatalf("outside staging changed: content=%q err=%v", content, readErr)
	}
}
