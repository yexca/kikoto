package httpapi

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storagepool"
	"github.com/yexca/kikoto/backend/internal/testfixture"
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

func TestLocalScanPreservesCopiesOutsideItsScope(t *testing.T) {
	for _, mode := range []string{localScanModeFull, localScanModeIncremental} {
		for _, boundary := range []string{"offline pool", "scan depth"} {
			for _, found := range []bool{true, false} {
				name := mode + "/" + boundary + "/missing visible root"
				if found {
					name = mode + "/" + boundary + "/found visible root"
				}
				t.Run(name, func(t *testing.T) {
					dataRoot := t.TempDir()
					db := openMigratedTestDB(t)
					db.SetMaxOpenConns(1)
					server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
					code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
					visibleRoot, hiddenRoot := code, "Archive/Hidden/"+code
					if boundary == "offline pool" {
						visibleRoot, hiddenRoot = "disk1/"+code, "disk2/"+code
						if err := os.MkdirAll(filepath.Join(dataRoot, "disk1"), 0o755); err != nil {
							t.Fatal(err)
						}
						if _, err := db.Exec(`
							UPDATE app_setting SET value_json = '"pools"' WHERE key = 'library_mode';
							INSERT INTO app_setting (key, value_json) VALUES ('storage_pools', '[{"path":"disk1","id":"pool-disk1"},{"path":"disk2","id":"pool-disk2"}]');
						`); err != nil {
							t.Fatal(err)
						}
						if err := storagepool.WriteMarker(filepath.Join(dataRoot, "disk1"), "pool-disk1"); err != nil {
							t.Fatal(err)
						}
					} else if err := storagepool.WriteMarker(dataRoot, "library-test"); err != nil {
						t.Fatal(err)
					}
					presenceRoot := visibleRoot
					if found {
						presenceRoot = hiddenRoot
						// A nested media folder is indexed even when its files lie
						// deeper than the scan's work-root discovery depth.
						folder := filepath.Join(dataRoot, filepath.FromSlash(visibleRoot), "Disc")
						if err := os.MkdirAll(folder, 0o755); err != nil {
							t.Fatal(err)
						}
						if err := os.WriteFile(filepath.Join(folder, "track.mp3"), []byte("audio"), 0o644); err != nil {
							t.Fatal(err)
						}
					}
					hiddenPath := hiddenRoot + "/Disc/track.mp3"
					seeded := seedIndexedLocalScanWork(t, db, server, code, presenceRoot, hiddenPath)
					if _, err := db.Exec(`
						INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state, is_primary)
						VALUES (?, ?, ?, 'external', 'active', 1)
					`, seeded.workID, seeded.sourceID, hiddenRoot); err != nil {
						t.Fatal(err)
					}
					visiblePath := visibleRoot + "/Disc/track.mp3"
					if !found {
						if _, err := db.Exec(`
							INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, size_bytes, availability)
							VALUES (?, ?, 'local', ?, 5, 'available')
						`, seeded.mediaItemID, seeded.sourceID, visiblePath); err != nil {
							t.Fatal(err)
						}
					}
					if mode == localScanModeFull {
						executeLocalScanForTest(t, server)
					} else {
						executeIncrementalLocalScanForTest(t, server, visibleRoot)
					}
					assertLocalScanLocationAvailability(t, db, hiddenPath, "available")
					var state string
					if err := db.QueryRow("SELECT state FROM work_folder_location WHERE root_path = ?", hiddenRoot).Scan(&state); err != nil {
						t.Fatal(err)
					}
					if state != "active" {
						t.Fatalf("unobserved folder state = %q, want active", state)
					}
					if found {
						if err := server.ensureLocalMediaIndexed(context.Background(), seeded.workID); err != nil {
							t.Fatal(err)
						}
						assertLocalScanLocationAvailability(t, db, visiblePath, "available")
						assertLocalScanLocationAvailability(t, db, hiddenPath, "available")
					} else {
						assertLocalScanLocationAvailability(t, db, visiblePath, "missing")
					}
				})
			}
		}
	}
}

// Earlier releases indexed sidecar files and NAS metadata inside work folders.
// A scan that reads the work folder no longer offers them as files of the
// work, while the work's real files stay available.
func TestLocalScanMarksIgnoredEntriesInsideAReadWorkFolderMissing(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	if err := storagepool.WriteMarker(dataRoot, "library-test"); err != nil {
		t.Fatal(err)
	}
	code := testfixture.WorkCode(testfixture.PrefixRJ, 36)
	for _, rel := range []string{"track.mp3", "._track.mp3", "@eaDir/track.mp3/SYNOINDEX_MEDIA_INFO"} {
		path := filepath.Join(dataRoot, code, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sidecar, metadata := code+"/._track.mp3", code+"/@eaDir/track.mp3/SYNOINDEX_MEDIA_INFO"
	seeded := seedIndexedLocalScanWork(t, db, server, code, code, code+"/track.mp3")
	for _, path := range []string{sidecar, metadata} {
		if _, err := db.Exec(`
			INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, size_bytes, availability)
			VALUES (?, ?, 'local', ?, 5, 'available')
		`, seeded.mediaItemID, seeded.sourceID, path); err != nil {
			t.Fatal(err)
		}
	}
	executeLocalScanForTest(t, server)
	assertLocalScanLocationAvailability(t, db, sidecar, "missing")
	assertLocalScanLocationAvailability(t, db, metadata, "missing")
	assertLocalScanLocationAvailability(t, db, code+"/track.mp3", "available")
}

func assertLocalScanLocationAvailability(t *testing.T, db *sql.DB, path, want string) {
	t.Helper()
	var availability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE path = ?", path).Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != want {
		t.Fatalf("location %q availability = %q, want %q", path, availability, want)
	}
}

// NAS recycle bins, metadata folders, and folders the scan cannot read are
// unseen. A scan never discovers works in them and never marks their works
// missing.
func TestLocalScanLeavesIgnoredAndUnreadableFoldersUnseen(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 3})
	writeSyntheticTrack := func(rel string) {
		t.Helper()
		path := filepath.Join(dataRoot, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeSyntheticTrack("RJ00000032/track.mp3")
	recycled := seedIndexedLocalScanWork(t, db, server, "RJ00000033", "#recycle/RJ00000033", "#recycle/RJ00000033/track.mp3")
	writeSyntheticTrack("#recycle/RJ00000033/track.mp3")
	writeSyntheticTrack("@eaDir/RJ00000034/track.mp3")
	locked := seedIndexedLocalScanWork(t, db, server, "RJ00000035", "locked/RJ00000035", "locked/RJ00000035/track.mp3")
	permissionsEnforced := runtime.GOOS != "windows" && os.Geteuid() != 0
	if permissionsEnforced {
		writeSyntheticTrack("locked/RJ00000035/track.mp3")
		lockedPath := filepath.Join(dataRoot, "locked")
		if err := os.Chmod(lockedPath, 0); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(lockedPath, 0o755) })
	}

	runID, err := runQueuedLocalScan(t, server)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if got := localPresenceAvailability(t, db, recycled.workID, recycled.sourceID); got != "available" {
		t.Fatalf("work in a recycle bin = %q, want it left unchanged", got)
	}
	var discovered int
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code IN ('RJ00000032', 'RJ00000034')").Scan(&discovered); err != nil {
		t.Fatal(err)
	}
	if discovered != 1 {
		t.Fatalf("discovered %d works, want the real folder only and nothing from @eaDir", discovered)
	}
	if !permissionsEnforced {
		scope := localScanScope{mode: storagepool.ModeStandard, online: []string{""}, depth: 3}.withUnreadableFolders([]string{"locked"})
		if scope.contains("locked/RJ00000035") || !scope.contains("RJ00000032") {
			t.Fatal("a root below an unreadable folder must be unseen while other roots stay in scope")
		}
		return
	}
	if got := localPresenceAvailability(t, db, locked.workID, locked.sourceID); got != "available" {
		t.Fatalf("work below an unreadable folder = %q, want it left unchanged", got)
	}
	var summary string
	if err := db.QueryRow("SELECT summary_json FROM workflow_run WHERE id = ?", runID).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, `"unreadable_folders":["locked"]`) {
		t.Fatalf("run summary = %s, want the unreadable folder recorded", summary)
	}
}

// Earlier releases recorded a Synology thumbnail folder that carries a work
// folder's name as a folder of the work. A scan that reaches it retires it,
// and it is never indexed in the meantime. A folder in a recycle bin, or in an
// offline pool, keeps its state.
func TestLocalScanRetiresFolderRecordsInMetadataDirectories(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 3})
	for _, pool := range []string{"disk1", "disk2"} {
		if err := os.MkdirAll(filepath.Join(dataRoot, pool), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := storagepool.WriteMarker(filepath.Join(dataRoot, "disk1"), "pool-disk1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE app_setting SET value_json = '"pools"' WHERE key = 'library_mode'`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('storage_pools', '[{"path":"disk1","id":"pool-disk1"},{"path":"disk2","id":"pool-disk2"}]')`); err != nil {
		t.Fatal(err)
	}
	code := testfixture.WorkCode(testfixture.PrefixRJ, 37)
	realRoot := "disk1/Circle/" + code
	thumbnails := "disk1/Circle/@eaDir/" + code
	recycled := "disk1/#recycle/" + code
	offlineThumbnails := "disk2/Circle/@eaDir/" + code
	for _, rel := range []string{realRoot + "/track.mp3", thumbnails + "/SYNOPHOTO_THUMB_M.jpg", recycled + "/track.mp3"} {
		path := filepath.Join(dataRoot, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	seeded := seedIndexedLocalScanWork(t, db, server, code, thumbnails, thumbnails+"/SYNOINDEX_MEDIA_INFO")
	if _, err := db.Exec(`UPDATE work_source_presence SET raw_json = '{}' WHERE work_id = ?`, seeded.workID); err != nil {
		t.Fatal(err)
	}
	for _, folder := range []struct {
		root    string
		primary int
	}{{thumbnails, 1}, {recycled, 0}, {offlineThumbnails, 0}} {
		if _, err := db.Exec(`
			INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state, is_primary)
			VALUES (?, ?, ?, 'external', 'active', ?)
		`, seeded.workID, seeded.sourceID, folder.root, folder.primary); err != nil {
			t.Fatal(err)
		}
	}

	// With nothing indexed, opening the work indexes its folders.
	if _, err := db.Exec("UPDATE media_file_location SET availability = 'missing' WHERE id = ?", seeded.locationID); err != nil {
		t.Fatal(err)
	}
	if err := server.ensureLocalMediaIndexed(context.Background(), seeded.workID); err != nil {
		t.Fatal(err)
	}
	var indexedThumbnails int
	if err := db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path = ?", thumbnails+"/SYNOPHOTO_THUMB_M.jpg").Scan(&indexedThumbnails); err != nil {
		t.Fatal(err)
	}
	if indexedThumbnails != 0 {
		t.Fatal("a folder in a metadata directory must never be indexed")
	}

	if _, err := db.Exec("UPDATE media_file_location SET availability = 'available' WHERE id = ?", seeded.locationID); err != nil {
		t.Fatal(err)
	}
	if _, err := runQueuedLocalScan(t, server); err != nil {
		t.Fatal(err)
	}
	folderState := func(root string) (state string, primary bool) {
		t.Helper()
		if err := db.QueryRow("SELECT state, is_primary FROM work_folder_location WHERE root_path = ?", root).Scan(&state, &primary); err != nil {
			t.Fatal(err)
		}
		return state, primary
	}
	for root, want := range map[string]string{thumbnails: "missing", recycled: "active", offlineThumbnails: "active", realRoot: "active"} {
		if got, _ := folderState(root); got != want {
			t.Errorf("folder %q state = %q, want %q", root, got, want)
		}
	}
	if _, primary := folderState(realRoot); !primary {
		t.Error("the folder the scan found must be the work's primary folder")
	}
	assertLocalScanLocationAvailability(t, db, thumbnails+"/SYNOINDEX_MEDIA_INFO", "missing")
	var presenceRoot, availability string
	if err := db.QueryRow(`
		SELECT source_url, availability FROM work_source_presence
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
	`, seeded.workID, seeded.sourceID).Scan(&presenceRoot, &availability); err != nil {
		t.Fatal(err)
	}
	if presenceRoot != realRoot || availability != "available" {
		t.Fatalf("presence = %q (%s), want %q available", presenceRoot, availability, realRoot)
	}
}
