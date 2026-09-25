package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func clearLibraryMode(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec("DELETE FROM app_setting WHERE key = 'library_mode'"); err != nil {
		t.Fatal(err)
	}
}

func localScanTriggerStates(t *testing.T, server *Server) libraryScanTriggers {
	t.Helper()
	triggers, err := server.localScanTriggers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return triggers
}

func libraryLayoutRequest(t *testing.T, server *Server, method, target, body string) (*httptest.ResponseRecorder, libraryLayoutResponse) {
	t.Helper()
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(method, target, body))
	var layout libraryLayoutResponse
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &layout); err != nil {
			t.Fatal(err)
		}
	}
	return response, layout
}

func TestPrepareLibraryLayoutLeavesFreshInstallUnconfiguredWithScansOff(t *testing.T) {
	db := openMigratedTestDB(t)
	clearLibraryMode(t, db)
	server := NewServer(db, config.Config{DataRoot: t.TempDir()})
	if before := localScanTriggerStates(t, server); !before.StartupScan || !before.WatchFolders {
		t.Fatalf("seeded triggers = %+v, want both enabled", before)
	}
	if err := server.PrepareLibraryLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	layout, err := server.loadLibraryLayout(context.Background())
	if err != nil || layout.configured() {
		t.Fatalf("fresh layout = %+v, err = %v; want unconfigured", layout, err)
	}
	if after := localScanTriggerStates(t, server); after.StartupScan || after.WatchFolders {
		t.Fatalf("fresh install triggers = %+v, want both off until onboarding", after)
	}
	// A trigger turned on during onboarding stays on across restarts.
	if err := server.setLocalScanTriggers(context.Background(), libraryScanTriggers{WatchFolders: true}); err != nil {
		t.Fatal(err)
	}
	if err := server.PrepareLibraryLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if again := localScanTriggerStates(t, server); !again.WatchFolders {
		t.Fatalf("restart turned the folder watcher off again: %+v", again)
	}
}

func TestPrepareLibraryLayoutKeepsUpgradedInstanceStandard(t *testing.T) {
	db := openMigratedTestDB(t)
	clearLibraryMode(t, db)
	if _, err := db.Exec("UPDATE schema_state SET last_successful_app_version = 'v0.6.1'"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: t.TempDir()})
	if err := server.PrepareLibraryLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	response, layout := libraryLayoutRequest(t, server, http.MethodGet, "/api/library/layout", "")
	if response.Code != http.StatusOK {
		t.Fatalf("layout status = %d, body = %s", response.Code, response.Body.String())
	}
	if layout.Mode != storagepool.ModeStandard || !layout.OnboardingCompleted {
		t.Fatalf("upgraded layout = %+v, want standard with onboarding done", layout)
	}
	if triggers := localScanTriggerStates(t, server); !triggers.StartupScan || !triggers.WatchFolders {
		t.Fatalf("upgrade changed the scan triggers: %+v", triggers)
	}
}

func TestLibraryLayoutRegistersPoolsAndLocksModeOnceWorksExist(t *testing.T) {
	dataRoot := t.TempDir()
	for _, name := range []string{"disk1", "disk2", ".kikoto-staging"} {
		if err := os.MkdirAll(filepath.Join(dataRoot, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	db := openMigratedTestDB(t)
	clearLibraryMode(t, db)
	insertUnlinkedMaintenanceUser(t, db, 1)
	server := NewServer(db, config.Config{DataRoot: dataRoot})

	response, layout := libraryLayoutRequest(t, server, http.MethodGet, "/api/library/layout", "")
	if response.Code != http.StatusOK || layout.Configured || strings.Join(layout.Candidates, ",") != "disk1,disk2" {
		t.Fatalf("unconfigured layout = %d %+v", response.Code, layout)
	}
	response, _ = libraryLayoutRequest(t, server, http.MethodPut, "/api/library/layout", `{"mode":"pools","pools":["disk1"],"fetchPool":"disk2"}`)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "fetch_pool_invalid") {
		t.Fatalf("fetch pool outside pools = %d %s", response.Code, response.Body.String())
	}
	response, layout = libraryLayoutRequest(t, server, http.MethodPut, "/api/library/layout", `{"mode":"pools","pools":["disk1","disk2"],"fetchPool":"disk1"}`)
	if response.Code != http.StatusOK || layout.Mode != storagepool.ModePools || layout.FetchPool != "disk1" || len(layout.Pools) != 2 {
		t.Fatalf("registered layout = %d %+v", response.Code, layout)
	}
	for _, pool := range layout.Pools {
		if !pool.Online {
			t.Fatalf("registered pool %q is offline: %s", pool.Path, pool.Reason)
		}
		if _, err := os.Stat(filepath.Join(dataRoot, pool.Path, storagepool.MarkerName)); err != nil {
			t.Fatalf("pool %q has no marker: %v", pool.Path, err)
		}
	}

	// A local work in disk2 locks the mode and keeps disk2 registered.
	code := "RJ00000040"
	seedIndexedLocalScanWork(t, db, server, code, "disk2/"+code, "disk2/"+code+"/track.mp3")
	response, _ = libraryLayoutRequest(t, server, http.MethodPut, "/api/library/layout", `{"mode":"standard"}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "library_mode_locked") {
		t.Fatalf("mode change with works = %d %s", response.Code, response.Body.String())
	}
	response, _ = libraryLayoutRequest(t, server, http.MethodPut, "/api/library/layout", `{"mode":"pools","pools":["disk1"],"fetchPool":"disk1"}`)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "storage_pool_in_use") {
		t.Fatalf("removing a pool with works = %d %s", response.Code, response.Body.String())
	}
	// The fetch pool can still change after the mode is locked.
	response, layout = libraryLayoutRequest(t, server, http.MethodPut, "/api/library/layout", `{"mode":"pools","pools":["disk1","disk2"],"fetchPool":"disk2"}`)
	if response.Code != http.StatusOK || layout.FetchPool != "disk2" || !layout.Locked {
		t.Fatalf("changing the fetch pool = %d %+v", response.Code, layout)
	}
}

func TestFetchDestinationFollowsFetchPool(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	ctx := context.Background()
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a"}
	if err := os.MkdirAll(filepath.Join(dataRoot, "disk1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		UPDATE app_setting SET value_json = '"pools"' WHERE key = 'library_mode';
		INSERT INTO app_setting (key, value_json) VALUES ('storage_pools', '[{"path":"disk1","id":"pool-disk1"}]');
		INSERT INTO work (id, primary_code, title) VALUES (41, 'RJ00000041', 'Pool work');
		INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (5, 'example_remote_a', 'Example', 'kikoeru_compatible', 10, 1);
	`); err != nil {
		t.Fatal(err)
	}
	if err := server.EnsureLocalSource(ctx); err != nil {
		t.Fatal(err)
	}

	_, err := server.resolveRemoteFetchSaveRoot(ctx, source, "RJ00000041", "")
	var destination fetchDestinationError
	if !errors.As(err, &destination) || destination.Code != "fetch_pool_required" {
		t.Fatalf("without a fetch pool = %v, want fetch_pool_required", err)
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('fetch_pool', '"disk1"')`); err != nil {
		t.Fatal(err)
	}
	_, err = server.resolveRemoteFetchSaveRoot(ctx, source, "RJ00000041", "")
	if !errors.As(err, &destination) || destination.Code != "fetch_pool_offline" {
		t.Fatalf("unmarked fetch pool = %v, want fetch_pool_offline", err)
	}
	if err := storagepool.WriteMarker(filepath.Join(dataRoot, "disk1"), "pool-disk1"); err != nil {
		t.Fatal(err)
	}
	saveRoot, err := server.resolveRemoteFetchSaveRoot(ctx, source, "RJ00000041", "")
	if err != nil || saveRoot != "disk1/example_remote_a/RJ_000/RJ00000041" {
		t.Fatalf("save root = %q, err = %v", saveRoot, err)
	}
	managed, ok := server.remoteFetchManagedRoot(ctx, source)
	if !ok || managed != "disk1/example_remote_a" {
		t.Fatalf("managed root = %q/%v", managed, ok)
	}
	pool, err := server.fetchTransactionPool(ctx, saveRoot)
	if err != nil || pool != "disk1" {
		t.Fatalf("transaction pool = %q, err = %v", pool, err)
	}
	// Depth counts inside the pool: the template places works three levels
	// below the pool root, and the scan walks one more level from /data.
	if got := server.effectiveLocalScanDepth(ctx); got != 3 {
		t.Fatalf("effective depth = %d, want the Fetch template depth inside a pool", got)
	}

	// Staging and backup follow the target's pool.
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	plan := remoteWorkSavePlan{PrimaryCode: "RJ00000041", SaveRoot: saveRoot, TransactionPool: pool}
	if _, err := createRemoteFetchManifestForTest(ctx, tx, plan); err != nil {
		t.Fatal(err)
	}
	var stagingRoot, backupRoot string
	if err := tx.QueryRow("SELECT staging_root, backup_root FROM remote_fetch_manifest").Scan(&stagingRoot, &backupRoot); err != nil {
		t.Fatal(err)
	}
	if stagingRoot != "disk1/.kikoto-staging/1/work" || backupRoot != "disk1/.kikoto-backup/1/work" {
		t.Fatalf("transaction roots = %q, %q", stagingRoot, backupRoot)
	}
	candidate := fetchStagingCleanupCandidate{RunID: 1, StagingRoot: stagingRoot}
	if runPath, err := fetchStagingRunPath(dataRoot, candidate); err != nil || runPath != filepath.Join(dataRoot, "disk1", ".kikoto-staging", "1") {
		t.Fatalf("staging cleanup path = %q, err = %v", runPath, err)
	}
	for archive, allowed := range map[string]bool{
		".kikoto-trash/fetch/1/2-RJ00000041":       true,
		"disk1/.kikoto-trash/fetch/1/2-RJ00000041": true,
		"disk1/works/.kikoto-trash/fetch/1":        false,
		"../.kikoto-trash/fetch/1":                 false,
	} {
		if fetchTrashArchiveAllowed(archive) != allowed {
			t.Fatalf("trash archive %q allowed = %v", archive, !allowed)
		}
	}
}

func createRemoteFetchManifestForTest(ctx context.Context, tx *sql.Tx, plan remoteWorkSavePlan) (int64, error) {
	var localSourceID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM file_source WHERE code = 'main_local_library'").Scan(&localSourceID); err != nil {
		return 0, err
	}
	for _, statement := range []string{
		`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES (1, 'remote_work_fetch', 'Fetch', 'running', 'manual')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status) VALUES (1, 1, 'remote_work_fetch', 'running')`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return 0, err
		}
	}
	return createRemoteFetchManifest(ctx, tx, 1, 1, "", 41, 5, localSourceID, plan)
}
