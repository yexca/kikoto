package httpapi

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func localPresenceAvailability(t *testing.T, db *sql.DB, workID, sourceID int64) string {
	t.Helper()
	var availability string
	if err := db.QueryRow(`
		SELECT availability FROM work_source_presence
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
	`, workID, sourceID).Scan(&availability); err != nil {
		t.Fatal(err)
	}
	return availability
}

func runQueuedLocalScan(t *testing.T, server *Server) (int64, error) {
	t.Helper()
	result, err := server.enqueueLocalScan(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "local-scan-safety-test")
	if err != nil || !ok || job.RunID != result.RunID {
		t.Fatalf("claim local scan job = %#v, %t, %v", job, ok, err)
	}
	return result.RunID, server.executeLocalScanJob(context.Background(), job)
}

// An unmounted Docker volume leaves an empty directory behind. A scan of it
// must not report the whole library missing.
func TestLocalScanOfUnmountedLibraryRootMarksNothingMissing(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 3})
	code := "RJ00000030"
	seeded := seedIndexedLocalScanWork(t, db, server, code, code, code+"/track.mp3")

	runID, err := runQueuedLocalScan(t, server)
	if err == nil {
		t.Fatal("a scan of an empty, unmarked library root must fail")
	}
	if got := localPresenceAvailability(t, db, seeded.workID, seeded.sourceID); got != "available" {
		t.Fatalf("presence = %q, want the work left available", got)
	}
	var status, message string
	if err := db.QueryRow(`
		SELECT run.status, COALESCE(job.error_message, '')
		FROM workflow_run AS run INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.id = ?
	`, runID).Scan(&status, &message); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || !strings.Contains(message, "mounted") {
		t.Fatalf("run status = %q, message = %q", status, message)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, storagepool.MarkerName)); !os.IsNotExist(err) {
		t.Fatalf("an empty root of a library with works must not be adopted: %v", err)
	}

	// Once the volume is mounted again, the root is adopted and scanned.
	if err := os.MkdirAll(filepath.Join(dataRoot, code), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, code, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runQueuedLocalScan(t, server); err != nil {
		t.Fatalf("scan after remount: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, storagepool.MarkerName)); err != nil {
		t.Fatalf("a visible library root should be marked: %v", err)
	}
	if got := localPresenceAvailability(t, db, seeded.workID, seeded.sourceID); got != "available" {
		t.Fatalf("presence after remount = %q", got)
	}
}

// A work saved deeper than the scan reaches cannot be seen by that scan, so it
// must keep its state; the effective depth also rises to reach Fetch folders.
func TestLocalScanDepthReachesFetchFoldersAndSparesDeeperWorks(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 3})
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('local_scan_depth', '1')`); err != nil {
		t.Fatal(err)
	}
	code := "RJ00000031"
	fetchRoot := "example_source/RJ_000/" + code
	seeded := seedIndexedLocalScanWork(t, db, server, code, fetchRoot, fetchRoot+"/track.mp3")
	if _, err := db.Exec(`
		INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state, is_primary)
		VALUES (?, ?, ?, 'managed_fetch', 'active', 1)
	`, seeded.workID, seeded.sourceID, fetchRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dataRoot, filepath.FromSlash(fetchRoot)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, filepath.FromSlash(fetchRoot), "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := server.effectiveLocalScanDepth(context.Background()); got != 3 {
		t.Fatalf("effective depth = %d, want the Fetch folder level 3", got)
	}
	if _, err := runQueuedLocalScan(t, server); err != nil {
		t.Fatal(err)
	}
	if got := localPresenceAvailability(t, db, seeded.workID, seeded.sourceID); got != "available" {
		t.Fatalf("Fetched work = %q, want available", got)
	}

	scope := localScanScope{mode: storagepool.ModeStandard, online: []string{""}, depth: 2}
	if scope.contains(fetchRoot) {
		t.Fatal("a root deeper than the scan depth is outside the scan's reach")
	}
	if !scope.contains("example_source/" + code) {
		t.Fatal("a root within the scan depth is inside the scan's reach")
	}
}

func TestLocalScanInPoolModeSkipsOfflinePoolsAndUnregisteredFolders(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	pools := []storagepool.Pool{{Path: "disk1", ID: "pool-disk1"}, {Path: "disk2", ID: "pool-disk2"}}
	for _, pool := range pools {
		if err := os.MkdirAll(filepath.Join(dataRoot, pool.Path), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// disk1 is mounted and marked; disk2 is an unmounted, empty mount point.
	if err := storagepool.WriteMarker(filepath.Join(dataRoot, "disk1"), "pool-disk1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		UPDATE app_setting SET value_json = '"pools"' WHERE key = 'library_mode';
		INSERT INTO app_setting (key, value_json) VALUES ('storage_pools', '[{"path":"disk1","id":"pool-disk1"},{"path":"disk2","id":"pool-disk2"}]');
	`); err != nil {
		t.Fatal(err)
	}
	offlineCode := "RJ00000032"
	offline := seedIndexedLocalScanWork(t, db, server, offlineCode, "disk2/"+offlineCode, "disk2/"+offlineCode+"/track.mp3")
	for _, rel := range []string{"disk1/Works/RJ00000033", "loose/RJ00000034"} {
		if err := os.MkdirAll(filepath.Join(dataRoot, filepath.FromSlash(rel)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataRoot, filepath.FromSlash(rel), "track.mp3"), []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	runID, err := runQueuedLocalScan(t, server)
	if err != nil {
		t.Fatal(err)
	}
	if got := localPresenceAvailability(t, db, offline.workID, offline.sourceID); got != "available" {
		t.Fatalf("work in the offline pool = %q, want unchanged", got)
	}
	var found, unregistered int
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000033'").Scan(&found); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000034'").Scan(&unregistered); err != nil {
		t.Fatal(err)
	}
	if found != 1 || unregistered != 0 {
		t.Fatalf("pool work found = %d, unregistered folder work = %d", found, unregistered)
	}
	var status, summary string
	if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", runID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "partial" || !strings.Contains(summary, `"disk2"`) {
		t.Fatalf("run status = %q, summary = %s", status, summary)
	}
}
