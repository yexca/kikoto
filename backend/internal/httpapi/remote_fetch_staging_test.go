package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestFetchArchivesOldLocalRootAndReviewDeletesArchive(t *testing.T) {
	dataRoot := t.TempDir()
	oldRoot := filepath.Join(dataRoot, "Library", "RJ01234567")
	publishedRoot := filepath.Join(dataRoot, "remote", "RJ", "012", "RJ01234567")
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
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ01234567', 'Work')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'Old', 'old')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'local', 'Library/RJ01234567/old.mp3', 'available')`,
		`INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary) VALUES (1, 1, 1, 'Library/RJ01234567', 'external', 'active', 0), (2, 1, 1, 'remote/RJ/012/RJ01234567', 'managed_fetch', 'active', 1)`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'succeeded', 'manual')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	archived, err := server.quarantineFetchLocalRoots(context.Background(), 1, 1, 1, []remoteWorkSavePlanItem{{TargetPath: "remote/RJ/012/RJ01234567/track.mp3"}})
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
	result, err := db.Exec(`INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json) VALUES (1, 'local_fetch_merge_cleanup', 'RJ01234567', 'pending', ?)`, mustJSON(map[string]any{"archived_roots": archived}))
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
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ01234567', 'Work')`,
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
	cachePath := filepath.Join(cacheRoot, "remote", "RJ01234567", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, content, 0o644); err != nil {
		t.Fatal(err)
	}
	size := int64(len(content))
	plan := remoteWorkSavePlan{
		SourceID: 1, PrimaryCode: "RJ01234567", SaveRoot: "remote/RJ01234567",
		Items: []remoteWorkSavePlanItem{{ItemKey: "remote:track.mp3", Path: "track.mp3", Kind: "audio", SizeBytes: &size, SourceKind: "remote", Action: "cache_hit", CachePath: "remote/RJ01234567/track.mp3", TargetPath: "remote/RJ01234567/track.mp3", OriginalTargetPath: "remote/RJ01234567/track.mp3", Resolution: "auto", RemoteSourceID: 1, SourcePath: "https://remote.invalid/track.mp3"}},
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
	target := filepath.Join(dataRoot, "remote", "RJ01234567", "track.mp3")
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
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ01234567', 'Work')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'Selected', 'selected'), (2, 1, 'audio', 'Other', 'other')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES
			(1, 1, 'cache', 'remote/RJ01234567/selected.mp3', 'available'),
			(2, 1, 'cache', 'remote/RJ01234567/other.flac', 'available')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	selectedPath := filepath.Join(cacheRoot, "remote", "RJ01234567", "selected.mp3")
	otherPath := filepath.Join(cacheRoot, "remote", "RJ01234567", "other.flac")
	if err := os.MkdirAll(filepath.Dir(selectedPath), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{selectedPath, otherPath} {
		if err := os.WriteFile(path, []byte("cache"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	plan := remoteWorkSavePlan{Items: []remoteWorkSavePlanItem{{
		Action: "cache_hit", RemoteSourceID: 1, CachePath: "remote/RJ01234567/selected.mp3",
	}}}
	removed, err := server.cleanupPromotedFetchCache(context.Background(), plan)
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

func TestReconcileRemoteFetchDoesNotRequeueFailedRun(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	ctx := context.Background()
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ01234567', 'Work')`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type, finished_at) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'failed', 'manual', CURRENT_TIMESTAMP)`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status, recoverable, max_retries, retry_count) VALUES (1, 1, 'remote_work_fetch', 'failed', 1, 5, 2)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	plan := remoteWorkSavePlan{SourceID: 1, PrimaryCode: "RJ01234567", SaveRoot: "remote/RJ01234567", Items: []remoteWorkSavePlanItem{}}
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
