package httpapi

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func TestFullLocalScanRefreshesIndexedFilesAfterRestart(t *testing.T) {
	for _, scenario := range []string{"added and removed files", "all files removed", "same-size replacement", "completed empty folder", "duplicate primary folder", "duplicate additional folder"} {
		t.Run(scenario, func(t *testing.T) {
			db := openMigratedTestDB(t)
			dataRoot := t.TempDir()
			root := "RJ00000000"
			if strings.HasPrefix(scenario, "duplicate") {
				root = "A/RJ00000000"
			}
			writeFile := func(root, name, content string) {
				t.Helper()
				absolute := filepath.Join(dataRoot, filepath.FromSlash(root), name)
				if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(absolute, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "completed empty folder" {
				if err := os.MkdirAll(filepath.Join(dataRoot, root), 0o755); err != nil {
					t.Fatal(err)
				}
			} else {
				writeFile(root, "old.mp3", "audio")
			}
			if strings.HasPrefix(scenario, "duplicate") {
				writeFile("B/RJ00000000", "old.mp3", "other")
			}
			server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir(), LocalScanDepth: 3})
			executeLocalScanForTest(t, server)
			var workID int64
			if err := db.QueryRow("SELECT id FROM work WHERE primary_code = 'RJ00000000'").Scan(&workID); err != nil {
				t.Fatal(err)
			}
			if err := server.ensureLocalMediaIndexed(context.Background(), workID); err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(scenario, "duplicate") {
				if err := db.QueryRow("SELECT source_url FROM work_source_presence WHERE work_id = ? AND presence_type = 'local'", workID).Scan(&root); err != nil {
					t.Fatal(err)
				}
				if scenario == "duplicate additional folder" {
					if root == "A/RJ00000000" {
						root = "B/RJ00000000"
					} else {
						root = "A/RJ00000000"
					}
				}
			}
			if scenario == "same-size replacement" {
				if _, err := db.Exec("UPDATE media_file_location SET duration_seconds = 60"); err != nil {
					t.Fatal(err)
				}
				writeFile(root, "old.mp3", "newer")
				absolute := filepath.Join(dataRoot, root, "old.mp3")
				changedAt := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
				if err := os.Chtimes(absolute, changedAt, changedAt); err != nil {
					t.Fatal(err)
				}
			} else {
				if scenario != "completed empty folder" {
					if err := os.Remove(filepath.Join(dataRoot, filepath.FromSlash(root), "old.mp3")); err != nil {
						t.Fatal(err)
					}
				}
				if scenario != "all files removed" {
					writeFile(root, "new.mp3", "new audio")
				}
			}
			// The filesystem watcher observes none of these changes. A new server
			// executes the same complete scan path used by Startup.
			server = NewServer(db, server.cfg)
			executeLocalScanForTest(t, server)
			if err := server.ensureLocalMediaIndexed(context.Background(), workID); err != nil {
				t.Fatal(err)
			}
			if scenario == "same-size replacement" {
				info, err := os.Stat(filepath.Join(dataRoot, root, "old.mp3"))
				if err != nil {
					t.Fatal(err)
				}
				var version string
				var unknownDuration bool
				if err := db.QueryRow("SELECT file_version, duration_seconds IS NULL FROM media_file_location WHERE path = ?", root+"/old.mp3").Scan(&version, &unknownDuration); err != nil {
					t.Fatal(err)
				}
				if version != localfs.FileVersion(info) || !unknownDuration {
					t.Fatalf("replacement kept an earlier file observation: version=%q unknownDuration=%v", version, unknownDuration)
				}
			} else {
				if scenario != "all files removed" {
					assertLocalScanLocationAvailability(t, db, root+"/new.mp3", "available")
				}
				if scenario != "completed empty folder" {
					assertLocalScanLocationAvailability(t, db, root+"/old.mp3", "missing")
				}
				if strings.HasPrefix(scenario, "duplicate") {
					other := "A/RJ00000000"
					if root == other {
						other = "B/RJ00000000"
					}
					assertLocalScanLocationAvailability(t, db, other+"/old.mp3", "available")
				}
			}
		})
	}
}

func TestFullLocalScanRefreshCoalescesWithAnIndexWithoutWritingToAnOfflinePool(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	root := "disk1/RJ00000000"
	absolute := filepath.Join(dataRoot, filepath.FromSlash(root))
	if err := os.MkdirAll(absolute, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(absolute, "old.mp3"), []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	if err := server.saveSettingValue(ctx, settingLibraryMode, storagepool.ModePools); err != nil {
		t.Fatal(err)
	}
	if err := server.saveSettingValue(ctx, settingStoragePools, []storagepool.Pool{{Path: "disk1", ID: "synthetic-pool"}}); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dataRoot, "disk1", storagepool.MarkerName)
	if err := storagepool.WriteMarker(filepath.Dir(marker), "synthetic-pool"); err != nil {
		t.Fatal(err)
	}
	executeLocalScanForTest(t, server)
	var workID, sourceID int64
	if err := db.QueryRow("SELECT work_id, file_source_id FROM work_source_presence WHERE presence_type = 'local'").Scan(&workID, &sourceID); err != nil {
		t.Fatal(err)
	}
	if err := server.ensureLocalMediaIndexed(ctx, workID); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(absolute, "old.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(absolute, "new.mp3"), []byte("new audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	scope, err := server.localScanScope(ctx, dataRoot, 2)
	if err != nil {
		t.Fatal(err)
	}
	// Keep an ordinary lazy index waiting for the shared write slot. The scan
	// joins that call, then the pool disappears before either may publish.
	server.localMediaWriteSlot <- struct{}{}
	leader := make(chan error, 1)
	go func() { leader <- server.indexLocalMediaForWork(ctx, workID, sourceID, root) }()
	indexKey := fmt.Sprintf("%d:%d:%s", workID, sourceID, root)
	wait := func(guarded bool) {
		t.Helper()
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			server.localMediaIndexMu.Lock()
			call := server.localMediaIndexes[indexKey]
			ready := call != nil && (!guarded || len(call.guards) > 0)
			server.localMediaIndexMu.Unlock()
			if ready {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-ticker.C:
			}
		}
	}
	wait(false)
	follower := make(chan error, 1)
	go func() {
		_, _, _, err := server.refreshIndexedLocalScanFolder(ctx, sourceID, localfs.WorkFolder{Code: "RJ00000000", RelPath: root, AbsPath: absolute}, scope)
		follower <- err
	}()
	wait(true)
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	<-server.localMediaWriteSlot
	for _, result := range []<-chan error{leader, follower} {
		select {
		case err := <-result:
			if err == nil {
				t.Fatal("indexing succeeded after its pool went offline")
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	assertLocalScanLocationAvailability(t, db, root+"/old.mp3", "available")
	var added int
	if err := db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path = ?", root+"/new.mp3").Scan(&added); err != nil {
		t.Fatal(err)
	}
	if added != 0 {
		t.Fatalf("offline pool gained %d indexed files", added)
	}
}

func TestFullLocalScanKeepsUnchangedIndexedMediaUntouched(t *testing.T) {
	dataRoot := t.TempDir()
	root := "RJ00000000"
	if err := os.MkdirAll(filepath.Join(dataRoot, root), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, root, "track.mp3"), []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	executeLocalScanForTest(t, server)
	var workID int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code = ?", root).Scan(&workID); err != nil {
		t.Fatal(err)
	}
	if err := server.ensureLocalMediaIndexed(context.Background(), workID); err != nil {
		t.Fatal(err)
	}
	const earlier = "2000-01-01 00:00:00"
	for _, statement := range []string{
		"UPDATE work SET updated_at = ?",
		"UPDATE work_source_presence SET updated_at = ?",
		"UPDATE work_folder_location SET updated_at = ?",
		"UPDATE media_file_location SET last_checked_at = ?",
	} {
		if _, err := db.Exec(statement, earlier); err != nil {
			t.Fatal(err)
		}
	}
	var before string
	if err := db.QueryRow("SELECT raw_json FROM work_source_presence WHERE presence_type = 'local'").Scan(&before); err != nil {
		t.Fatal(err)
	}
	executeLocalScanForTest(t, server)
	if err := server.ensureLocalMediaIndexed(context.Background(), workID); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := db.QueryRow("SELECT raw_json FROM work_source_presence WHERE presence_type = 'local'").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("unchanged index metadata changed: before=%s after=%s", before, after)
	}
	var rewritten int
	if err := db.QueryRow(`SELECT
		(SELECT COUNT(*) FROM work WHERE updated_at <> ?)
		+ (SELECT COUNT(*) FROM work_source_presence WHERE updated_at <> ?)
		+ (SELECT COUNT(*) FROM work_folder_location WHERE updated_at <> ?)
		+ (SELECT COUNT(*) FROM media_file_location WHERE last_checked_at <> ?)
	`, earlier, earlier, earlier, earlier).Scan(&rewritten); err != nil {
		t.Fatal(err)
	}
	if rewritten != 0 {
		t.Fatalf("unchanged scan rewrote %d rows", rewritten)
	}
}

func TestFullLocalScanSkipsAnIndexedTreeWithAnUnreadableDescendant(t *testing.T) {
	ctx := context.Background()
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	for _, code := range []string{"RJ00000000", "RJ00000001"} {
		root := filepath.Join(dataRoot, code, "Disc")
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, "old.mp3"), []byte("audio"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	executeLocalScanForTest(t, server)
	for _, code := range []string{"RJ00000000", "RJ00000001"} {
		var workID int64
		if err := db.QueryRow("SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil {
			t.Fatal(err)
		}
		if err := server.ensureLocalMediaIndexed(ctx, workID); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(dataRoot, code, "Disc", "old.mp3")); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataRoot, code, "new.mp3"), []byte("new audio"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := server.enqueueLocalScan(ctx, "manual", "manual"); err != nil {
		t.Fatal(err)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "local-scan-unreadable-tree-test")
	if err != nil || !ok {
		t.Fatalf("claim scan: ok=%v err=%v", ok, err)
	}
	payload, err := server.prepareLocalScanPayload(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	folders, summary, err := localfs.DiscoverFolders(dataRoot, localfs.Options{ScanDepth: payload.ScanDepth})
	if err != nil {
		t.Fatal(err)
	}
	// Carry the discovery result's unreadable boundary explicitly so the same
	// state transition is exercised on hosts that do not enforce POSIX modes.
	summary.UnreadableFolders = []string{"RJ00000000/Disc"}
	scope, err := server.localScanScope(ctx, dataRoot, payload.ScanDepth)
	if err != nil {
		t.Fatal(err)
	}
	scope = scope.withUnreadableFolders(summary.UnreadableFolders)
	nodes, err := workflowNodeIDsByNodeID(ctx, db, job.RunID)
	if err != nil {
		t.Fatal(err)
	}
	result, runSummary, err := server.persistLocalScanResults(ctx, job, payload, scope, folders, summary, nodes)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "partial" || len(result.Failures) != 1 {
		t.Fatalf("unreadable tree result = %+v", result)
	}
	if err := server.finishQueuedLocalScanJob(ctx, job, nodes["sync"], result, runSummary); err != nil {
		t.Fatal(err)
	}
	assertLocalScanLocationAvailability(t, db, "RJ00000000/Disc/old.mp3", "available")
	assertLocalScanLocationAvailability(t, db, "RJ00000001/Disc/old.mp3", "missing")
	assertLocalScanLocationAvailability(t, db, "RJ00000001/new.mp3", "available")
	var inaccessibleNewFiles int
	if err := db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path = 'RJ00000000/new.mp3'").Scan(&inaccessibleNewFiles); err != nil {
		t.Fatal(err)
	}
	if inaccessibleNewFiles != 0 {
		t.Fatal("a tree with an unreadable descendant was reconciled")
	}
}

// Discovery reads folders only down to the scan depth, while the refresh of an
// indexed work reads its whole tree. A folder deeper inside one work that
// cannot be read skips that work, and the rest of the scan, including marking
// works that are gone missing, still completes.
func TestFullLocalScanSkipsAWorkWhoseTreeCannotBeReadBelowTheScanDepth(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("folder permissions are not enforced for this user")
	}
	ctx := context.Background()
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	writeTrack := func(rel string) {
		t.Helper()
		path := filepath.Join(dataRoot, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("audio"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeTrack("RJ00000001/track.mp3")
	writeTrack("RJ00000001/a/b/c/d/e/locked/deep.mp3")
	writeTrack("RJ00000002/track.mp3")
	executeLocalScanForTest(t, server)
	for _, code := range []string{"RJ00000001", "RJ00000002"} {
		var workID int64
		if err := db.QueryRow("SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil {
			t.Fatal(err)
		}
		if err := server.ensureLocalMediaIndexed(ctx, workID); err != nil {
			t.Fatal(err)
		}
	}
	writeTrack("RJ00000001/new.mp3")
	if err := os.RemoveAll(filepath.Join(dataRoot, "RJ00000002")); err != nil {
		t.Fatal(err)
	}
	locked := filepath.Join(dataRoot, "RJ00000001", "a", "b", "c", "d", "e", "locked")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	runID, err := runQueuedLocalScan(t, server)
	if err != nil {
		t.Fatalf("scan with an unreadable folder inside one work: %v", err)
	}
	var status, summary string
	if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", runID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "partial" || !strings.Contains(summary, `"unreadable_folders":["RJ00000001"]`) {
		t.Fatalf("run status = %q, summary = %s; want partial with the skipped work folder", status, summary)
	}
	assertLocalScanLocationAvailability(t, db, "RJ00000001/track.mp3", "available")
	assertLocalScanLocationAvailability(t, db, "RJ00000001/a/b/c/d/e/locked/deep.mp3", "available")
	var added int
	if err := db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path = 'RJ00000001/new.mp3'").Scan(&added); err != nil {
		t.Fatal(err)
	}
	if added != 0 {
		t.Fatal("a work whose tree could not be read was reconciled")
	}
	assertLocalScanLocationAvailability(t, db, "RJ00000002/track.mp3", "missing")
}

// A pool that goes offline after discovery leaves its works as they were and
// is reported offline, while the other pool's works are still reconciled.
func TestFullLocalScanSkipsAPoolThatGoesOfflineDuringTheScan(t *testing.T) {
	ctx := context.Background()
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	if err := server.saveSettingValue(ctx, settingLibraryMode, storagepool.ModePools); err != nil {
		t.Fatal(err)
	}
	if err := server.saveSettingValue(ctx, settingStoragePools, []storagepool.Pool{{Path: "disk1", ID: "synthetic-pool-1"}, {Path: "disk2", ID: "synthetic-pool-2"}}); err != nil {
		t.Fatal(err)
	}
	for pool, id := range map[string]string{"disk1": "synthetic-pool-1", "disk2": "synthetic-pool-2"} {
		if err := os.MkdirAll(filepath.Join(dataRoot, pool), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := storagepool.WriteMarker(filepath.Join(dataRoot, pool), id); err != nil {
			t.Fatal(err)
		}
	}
	writeTrack := func(rel string) {
		t.Helper()
		path := filepath.Join(dataRoot, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("audio"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeTrack("disk1/RJ00000001/track.mp3")
	writeTrack("disk1/RJ00000003/track.mp3")
	writeTrack("disk2/RJ00000002/track.mp3")
	executeLocalScanForTest(t, server)
	for _, code := range []string{"RJ00000001", "RJ00000002", "RJ00000003"} {
		var workID int64
		if err := db.QueryRow("SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil {
			t.Fatal(err)
		}
		if err := server.ensureLocalMediaIndexed(ctx, workID); err != nil {
			t.Fatal(err)
		}
	}
	writeTrack("disk1/RJ00000001/new.mp3")
	writeTrack("disk2/RJ00000002/new.mp3")
	if err := os.RemoveAll(filepath.Join(dataRoot, "disk1", "RJ00000003")); err != nil {
		t.Fatal(err)
	}

	if _, err := server.enqueueLocalScan(ctx, "manual", "manual"); err != nil {
		t.Fatal(err)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "local-scan-pool-offline-test")
	if err != nil || !ok {
		t.Fatalf("claim scan: ok=%v err=%v", ok, err)
	}
	payload, err := server.prepareLocalScanPayload(ctx, job)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := server.localScanScope(ctx, dataRoot, payload.ScanDepth)
	if err != nil {
		t.Fatal(err)
	}
	folders, summary, err := localfs.DiscoverFolders(dataRoot, localfs.Options{ScanDepth: scope.walkDepth(), SubRoots: scope.subRoots()})
	if err != nil {
		t.Fatal(err)
	}
	folders = scope.filterFolders(folders)
	nodes, err := workflowNodeIDsByNodeID(ctx, db, job.RunID)
	if err != nil {
		t.Fatal(err)
	}
	// The second pool disappears after discovery found its work.
	if err := os.Remove(filepath.Join(dataRoot, "disk2", storagepool.MarkerName)); err != nil {
		t.Fatal(err)
	}
	result, runSummary, err := server.persistLocalScanResults(ctx, job, payload, scope, folders, summary, nodes)
	if err != nil {
		t.Fatalf("scan with a pool going offline: %v", err)
	}
	if result.Status != "partial" || len(result.Failures) != 1 || !strings.Contains(result.Failures[0], "disk2") {
		t.Fatalf("result = %+v, want partial with the offline pool", result)
	}
	if _, ok := runSummary["offline_pools"]; !ok {
		t.Fatalf("run summary = %v, want the offline pool recorded", runSummary)
	}
	assertLocalScanLocationAvailability(t, db, "disk2/RJ00000002/track.mp3", "available")
	assertLocalScanLocationAvailability(t, db, "disk1/RJ00000001/new.mp3", "available")
	assertLocalScanLocationAvailability(t, db, "disk1/RJ00000003/track.mp3", "missing")
	var offlineAdded int
	if err := db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path = 'disk2/RJ00000002/new.mp3'").Scan(&offlineAdded); err != nil {
		t.Fatal(err)
	}
	if offlineAdded != 0 {
		t.Fatal("a work in a pool that went offline was reconciled")
	}
}
