package httpapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func TestLibraryMigrationMovesWorkAndFetchTransactionTogether(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	code := "RJ00000000"
	if err := os.MkdirAll(filepath.Join(root, "disk1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, code), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, code, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	staged := filepath.Join(root, ".kikoto-staging", "11", "work")
	if err := os.MkdirAll(staged, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staged, "track.mp3"), []byte("staged"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
	if err := server.saveSettingValue(ctx, settingLibraryMode, storagepool.ModeStandard); err != nil {
		t.Fatal(err)
	}
	seed := seedIndexedLocalScanWork(t, db, server, code, code, code+"/track.mp3")
	for _, query := range []string{
		`INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state)
		 VALUES (1, 1, 'RJ00000000', 'managed_fetch', 'active')`,
		`INSERT INTO file_source (id, code, display_name, source_type, priority, enabled)
		 VALUES (55, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 10, 1)`,
		`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type)
		 VALUES (11, 'remote_work_fetch', 'Example Fetch', 'failed', 'manual')`,
		`INSERT INTO remote_fetch_manifest (workflow_run_id, work_id, remote_source_id, local_source_id,
		 edition_code, target_root, staging_root, backup_root, state, plan_json)
		 VALUES (11, 1, 55, 1, 'RJ00000000', 'RJ00000000',
		 '.kikoto-staging/11/work', '.kikoto-backup/11/work', 'staged',
		 '{"saveRoot":"RJ00000000","transactionPool":""}')`,
		`INSERT INTO workflow_candidate (workflow_run_id, candidate_type, status, payload_json)
		 VALUES (11, 'local_fetch_merge_cleanup', 'pending',
		 '{"archived_roots":[{"archive_path":".kikoto-trash/fetch/11/1-RJ00000000"}]}')`,
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	// These fixture IDs are deterministic in a freshly migrated database.
	if seed.workID != 1 || seed.sourceID != 1 {
		t.Fatalf("unexpected fixture ids: %+v", seed)
	}
	plan, err := server.buildLibraryMigrationPlan(ctx, libraryLayoutUpdate{Mode: storagepool.ModePools,
		Pools: []string{"disk1"}, FetchPool: "disk1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Moves) != 2 || plan.Bytes != int64(len("audio")+len("staged")) {
		t.Fatalf("migration preview = %+v", plan)
	}
	if _, err := server.registerStoragePools(ctx, plan.Current, plan.Requested.Pools); err != nil {
		t.Fatal(err)
	}
	for _, move := range plan.Moves {
		if err := server.stageLibraryMigrationMove(ctx, move); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.commitLibraryMigration(ctx, plan); err != nil {
		t.Fatal(err)
	}
	for _, move := range plan.Moves {
		if err := server.removeMigratedSource(move); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"disk1/RJ00000000/track.mp3", "disk1/.kikoto-staging/11/work/track.mp3"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(path))); err != nil {
			t.Fatalf("migrated %s: %v", path, err)
		}
	}
	for _, path := range []string{"RJ00000000", ".kikoto-staging/11"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(path))); !os.IsNotExist(err) {
			t.Fatalf("source %s remains: %v", path, err)
		}
	}
	for _, check := range []struct{ query, want string }{
		{`SELECT root_path FROM work_folder_location`, "disk1/RJ00000000"},
		{`SELECT source_url FROM work_source_presence WHERE presence_type = 'local'`, "disk1/RJ00000000"},
		{`SELECT path FROM media_file_location WHERE location_type = 'local'`, "disk1/RJ00000000/track.mp3"},
		{`SELECT staging_root FROM remote_fetch_manifest`, "disk1/.kikoto-staging/11/work"},
		{`SELECT backup_root FROM remote_fetch_manifest`, "disk1/.kikoto-backup/11/work"},
	} {
		var got string
		if err := db.QueryRow(check.query).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != check.want {
			t.Fatalf("%s = %q, want %q", check.query, got, check.want)
		}
	}
	var manifestJSON, candidateJSON string
	if err := db.QueryRow(`SELECT plan_json FROM remote_fetch_manifest`).Scan(&manifestJSON); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT payload_json FROM workflow_candidate`).Scan(&candidateJSON); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifestJSON, `"transactionPool":"disk1"`) || !strings.Contains(candidateJSON, `disk1/.kikoto-trash/fetch/11/`) {
		t.Fatalf("saved Fetch paths were not updated: %s %s", manifestJSON, candidateJSON)
	}
	if err := os.MkdirAll(filepath.Join(root, "disk2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := server.applyLibraryLayoutUpdate(ctx, libraryLayoutUpdate{Mode: storagepool.ModePools, Pools: []string{"disk1", "disk2"}, FetchPool: "disk1"}); err != nil {
		t.Fatal(err)
	}
	ordinaryCode := "RJ00000001"
	if err := os.MkdirAll(filepath.Join(root, "disk1", ordinaryCode), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "disk1", ordinaryCode, "track.mp3"), []byte("ordinary"), 0o644); err != nil {
		t.Fatal(err)
	}
	seedIndexedLocalScanWork(t, db, server, ordinaryCode, "disk1/"+ordinaryCode, "disk1/"+ordinaryCode+"/track.mp3")
	fetchPlan, err := server.buildLibraryMigrationPlan(ctx, libraryLayoutUpdate{Mode: storagepool.ModePools,
		Pools: []string{"disk1", "disk2"}, FetchPool: "disk2"})
	if err != nil {
		t.Fatal(err)
	}
	if len(fetchPlan.Moves) != 2 {
		t.Fatalf("Fetch-pool migration would move the wrong folders: %+v", fetchPlan.Moves)
	}
	for _, move := range fetchPlan.Moves {
		if err := server.stageLibraryMigrationMove(ctx, move); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.commitLibraryMigration(ctx, fetchPlan); err != nil {
		t.Fatal(err)
	}
	for _, move := range fetchPlan.Moves {
		if err := server.removeMigratedSource(move); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"disk2/RJ00000000/track.mp3", "disk2/.kikoto-staging/11/work/track.mp3", "disk1/RJ00000001/track.mp3"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(path))); err != nil {
			t.Fatalf("Fetch-pool switch lost %s: %v", path, err)
		}
	}
	if err := db.QueryRow(`SELECT plan_json FROM remote_fetch_manifest`).Scan(&manifestJSON); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(manifestJSON, `"transactionPool":"disk2"`) {
		t.Fatalf("Fetch plan retained old transaction pool: %s", manifestJSON)
	}
}

func TestRebaseLibraryRootWhenFetchPoolChanges(t *testing.T) {
	current := libraryLayout{Mode: storagepool.ModePools, Pools: []storagepool.Pool{{Path: "disk1", ID: "pool-one"}, {Path: "disk2", ID: "pool-two"}}, FetchPool: "disk1"}
	requested := libraryLayoutUpdate{Mode: storagepool.ModePools, Pools: []string{"disk1", "disk2"}, FetchPool: "disk2"}
	for _, test := range []struct {
		root  string
		fetch bool
		want  string
	}{
		{"disk1/RJ00000000", true, "disk2/RJ00000000"},
		{"disk1/RJ00000001", false, "disk1/RJ00000001"},
		{"disk2/RJ00000002", true, "disk2/RJ00000002"},
	} {
		got, err := rebaseLibraryRoot(current, requested, test.root, test.fetch)
		if err != nil || got != test.want {
			t.Fatalf("rebase %s (fetch=%v) = %q, %v; want %q", test.root, test.fetch, got, err, test.want)
		}
	}
}

func TestRewriteMigrationJSONOnlyChangesPathFields(t *testing.T) {
	raw := `{"workCode":"RJ00000000","saveRoot":"RJ00000000","archive_path":".kikoto-trash/fetch/11/work"}`
	got := rewriteMigrationJSON(raw, []layoutMigrationMove{
		{From: "RJ00000000", To: "disk1/RJ00000000"},
		{From: ".kikoto-trash/fetch/11", To: "disk1/.kikoto-trash/fetch/11"},
	}, storagepool.ModePools)
	if !strings.Contains(got, `"workCode":"RJ00000000"`) ||
		!strings.Contains(got, `"saveRoot":"disk1/RJ00000000"`) ||
		!strings.Contains(got, `"archive_path":"disk1/.kikoto-trash/fetch/11/work"`) {
		t.Fatalf("rewritten JSON = %s", got)
	}
}

func TestLibraryMigrationCleanupResumesAfterPartialSourceRemoval(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"original", "pool/original"} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(name)), 0o755); err != nil {
			t.Fatal(err)
		}
		for _, file := range []string{"first.txt", "second.txt"} {
			if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(name), file), []byte(file), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.Remove(filepath.Join(root, "original", "first.txt")); err != nil {
		t.Fatal(err)
	}
	server := &Server{cfg: config.Config{DataRoot: root}}
	if err := server.removeMigratedSource(layoutMigrationMove{From: "original", To: "pool/original"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "original")); !os.IsNotExist(err) {
		t.Fatalf("partial source still exists: %v", err)
	}
}

func TestLibraryMigrationCompletesAfterLocalScan(t *testing.T) {
	root := t.TempDir()
	code := "RJ00000000"
	unindexedCode := "RJ00000001"
	for _, name := range []string{"disk1", code, unindexedCode} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, code, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, unindexedCode, "track.mp3"), []byte("new audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.saveSettingValue(ctx, settingLibraryMode, storagepool.ModeStandard); err != nil {
		t.Fatal(err)
	}
	seedIndexedLocalScanWork(t, db, server, code, code, code+"/track.mp3")
	plan, err := server.buildLibraryMigrationPlan(ctx, libraryLayoutUpdate{Mode: storagepool.ModePools, Pools: []string{"disk1"}, FetchPool: "disk1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Moves) != 2 {
		t.Fatalf("unindexed visible work was omitted from migration: %+v", plan.Moves)
	}
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO library_layout_migration (id, status, phase, requested_json, plan_json, progress_total, progress_bytes_total)
		VALUES (1, 'running', 'prepare', '{}', ?, ?, ?)`, string(encoded), len(plan.Moves), plan.Bytes); err != nil {
		t.Fatal(err)
	}
	server.layoutMigrationActive.Store(true)
	result := make(chan error, 1)
	go func() { result <- server.runLibraryMigration(ctx, plan) }()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-result:
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(root, "disk1", code, "track.mp3")); err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(filepath.Join(root, "disk1", unindexedCode, "track.mp3")); err != nil {
				t.Fatal(err)
			}
			var discovered int
			if err := db.QueryRow(`SELECT COUNT(*) FROM work WHERE primary_code = ?`, unindexedCode).Scan(&discovered); err != nil || discovered != 1 {
				t.Fatalf("unindexed work was not discovered after migration: %d, %v", discovered, err)
			}
			status, err := server.loadLibraryMigrationStatus(ctx)
			if err != nil || status.Status != "completed" {
				t.Fatalf("status = %+v, %v", status, err)
			}
			return
		case <-ticker.C:
			if err := server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func TestLibraryMigrationRejectsOfflineCurrentPoolAndLinkedTarget(t *testing.T) {
	root := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: root})
	if err := os.MkdirAll(filepath.Join(root, "disk1"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "disk2"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES
		('library_mode', '"pools"'),
		('storage_pools', '[{"path":"disk1","id":"synthetic-pool"}]')
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`); err != nil {
		t.Fatal(err)
	}
	if _, err := server.buildLibraryMigrationPlan(context.Background(), libraryLayoutUpdate{Mode: storagepool.ModeStandard}); err == nil {
		t.Fatal("offline pool could be migrated")
	}
	if err := storagepool.WriteMarker(filepath.Join(root, "disk1"), "synthetic-pool"); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "disk1", "RJ00000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Example Work')`); err != nil {
		t.Fatal(err)
	}
	// A linked target or ancestor must never be a copy destination.
	link := filepath.Join(root, "RJ00000000")
	if err := os.Symlink(filepath.Join(root, "disk2"), link); err == nil {
		if err := rejectLinkedMigrationAncestors(root, "RJ00000000"); err == nil {
			t.Fatal("linked target accepted")
		}
	}
}
