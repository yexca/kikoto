package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/storagepool"
	"github.com/yexca/kikoto/backend/migrations"
)

// The v0.6.1 tag contains numbered migrations through 034 and the 034
// baseline. Construct that released schema without depending on Git at test
// time, then boot it with the current packaged migration catalog.
func v061MigrationCatalog(t *testing.T) string {
	t.Helper()
	source := filepath.Join("..", "..", "migrations")
	target := t.TempDir()
	entries, err := os.ReadDir(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || len(name) < 8 || name[:3] > "034" || name[3] != '_' || !strings.HasSuffix(name, ".sql") {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(target, name), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(target, "baseline"), 0o700); err != nil {
		t.Fatal(err)
	}
	baseline, err := os.ReadFile(filepath.Join(source, "baseline", "034_v0.6.0.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "baseline", "034_v0.6.0.sql"), baseline, 0o600); err != nil {
		t.Fatal(err)
	}
	return target
}

func openRestartableMigrationDB(t *testing.T) (string, *sql.DB) {
	t.Helper()
	image, err := migratedTestDatabaseImage()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "library.db")
	if err := os.WriteFile(path, image, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return path, db
}

func reopenMigrationServer(t *testing.T, databasePath, dataRoot string) (*sql.DB, *Server) {
	t.Helper()
	db, err := storage.Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.MigrateFS(db, migrations.Files, buildinfo.Version); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	ctx := context.Background()
	if err := server.EnsureLocalSource(ctx); err != nil {
		t.Fatal(err)
	}
	if err := server.PrepareLibraryLayout(ctx); err != nil {
		t.Fatal(err)
	}
	if err := server.RecoverInterruptedWorkflows(ctx); err != nil {
		t.Fatal(err)
	}
	return db, server
}

func saveTestLibraryMigration(t *testing.T, db *sql.DB, plan layoutMigrationPlan, phase string) {
	t.Helper()
	encoded, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO library_layout_migration
		(id, status, phase, requested_json, plan_json, progress_total, progress_bytes_total)
		VALUES (1, 'running', ?, '{}', ?, ?, ?)`, phase, string(encoded), len(plan.Moves), plan.Bytes); err != nil {
		t.Fatal(err)
	}
}

func waitForTestLibraryMigration(t *testing.T, server *Server) int64 {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		status, err := server.loadLibraryMigrationStatus(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if status.Status == "failed" {
			t.Fatalf("library migration failed in %s: %+v", status.Phase, status)
		}
		if status.Status == "completed" {
			if server.layoutMigrationActive.Load() {
				t.Fatal("maintenance remains active after migration")
			}
			var scanRunID int64
			if err := server.db.QueryRow(`SELECT scan_run_id FROM library_layout_migration WHERE id = 1`).Scan(&scanRunID); err != nil {
				t.Fatal(err)
			}
			var scanStatus string
			if err := server.db.QueryRow(`SELECT status FROM workflow_run WHERE id = ?`, scanRunID).Scan(&scanStatus); err != nil || scanStatus != "succeeded" {
				t.Fatalf("migration scan %d = %q, %v", scanRunID, scanStatus, err)
			}
			return scanRunID
		}
		select {
		case <-ticker.C:
			if err := server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
}

func startTestLibraryMigration(t *testing.T, server *Server, requested libraryLayoutUpdate) int64 {
	t.Helper()
	plan, err := server.buildLibraryMigrationPlan(context.Background(), requested)
	if err != nil {
		t.Fatal(err)
	}
	requestBody, err := json.Marshal(layoutMigrationRequest{LibraryLayoutUpdate: requested, Hash: migrationPreview(plan).Hash})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.startLibraryMigration(response, databaseMaintenanceRequest(http.MethodPost, "/api/library/migration", string(requestBody)))
	if response.Code != http.StatusAccepted {
		t.Fatalf("start migration = %d: %s", response.Code, response.Body.String())
	}
	return waitForTestLibraryMigration(t, server)
}

func TestV061DatabaseBootsIntoPoolMigrationWithLegacyWorkflowReview(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"disk1", "RJ00000000"} {
		if err := os.MkdirAll(filepath.Join(root, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "RJ00000000", "track.mp3"), []byte("synthetic audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "v061.db")
	oldDB, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.MigrateFS(oldDB, os.DirFS(v061MigrationCatalog(t)), "v0.6.1"); err != nil {
		t.Fatal(err)
	}
	var oldVersion int
	if err := oldDB.QueryRow(`SELECT current_version FROM schema_state WHERE id = 1`).Scan(&oldVersion); err != nil || oldVersion != 34 {
		t.Fatalf("v0.6.1 fixture schema = %d, %v", oldVersion, err)
	}
	for _, statement := range []string{
		`INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Synthetic Work')`,
		`INSERT INTO workflow_definition (id, code, display_name, description, definition_json, scope, editable)
		 VALUES (9001, 'example_custom', 'Example Workflow', 'Synthetic', '{"schemaVersion":2,"nodes":[],"edges":[]}', 'user', 1)`,
		`INSERT INTO workflow_trigger (id, workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
		 VALUES (9002, 9001, 'schedule', 'Example Trigger', 1, '{"intervalMinutes":60}', '{}')`,
	} {
		if _, err := oldDB.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := storage.RecordSuccessfulStart(oldDB, "v0.6.1"); err != nil {
		t.Fatal(err)
	}
	if err := oldDB.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	called := false
	if err := storage.MigrateFSWithOptions(db, migrations.Files, buildinfo.Version, storage.MigrateOptions{
		BeforeUpgrade: func(from, to int) error {
			called = true
			if from != 34 || to <= from {
				return fmt.Errorf("unexpected upgrade boundary %d -> %d", from, to)
			}
			return storage.PreserveLegacyWorkflows(context.Background(), db, from)
		},
	}); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("startup skipped pre-upgrade workflow preservation")
	}
	server := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
	if err := server.EnsureLocalSource(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := server.PrepareLibraryLayout(context.Background()); err != nil {
		t.Fatal(err)
	}
	layout, err := server.libraryLayoutResponse(context.Background())
	if err != nil || layout.Mode != storagepool.ModeStandard || layout.OnboardingCompleted || !layout.HasLegacyWorkflows {
		t.Fatalf("upgraded library layout = %+v, %v", layout, err)
	}
	var snapshotStatus, triggers string
	if err := db.QueryRow(`SELECT review_status, triggers_json FROM legacy_workflow_snapshot WHERE original_id = 9001`).Scan(&snapshotStatus, &triggers); err != nil {
		t.Fatal(err)
	}
	if snapshotStatus != "pending" || !strings.Contains(triggers, `"id":9002`) {
		t.Fatalf("legacy workflow review = %q, %q", snapshotStatus, triggers)
	}
	startTestLibraryMigration(t, server, libraryLayoutUpdate{Mode: storagepool.ModePools, Pools: []string{"disk1"}, FetchPool: "disk1"})
	if contents, err := os.ReadFile(filepath.Join(root, "disk1", "RJ00000000", "track.mp3")); err != nil || string(contents) != "synthetic audio" {
		t.Fatalf("migrated v0.6.1 file = %q, %v", contents, err)
	}
	if _, err := os.Stat(filepath.Join(root, "RJ00000000")); !os.IsNotExist(err) {
		t.Fatalf("old work folder remains: %v", err)
	}
	var works int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000000'`).Scan(&works); err != nil || works != 1 {
		t.Fatalf("work identity after upgrade = %d, %v", works, err)
	}
}

func TestLibraryMigrationRoundTripFromEmptyRoot(t *testing.T) {
	for _, fixture := range []struct {
		name string
		work bool
	}{{"empty", false}, {"synthetic work", true}} {
		t.Run(fixture.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, "disk1"), 0o755); err != nil {
				t.Fatal(err)
			}
			if fixture.work {
				if err := os.Mkdir(filepath.Join(root, "RJ00000000"), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "RJ00000000", "track.mp3"), []byte("synthetic audio"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
			if err := server.EnsureLocalSource(context.Background()); err != nil {
				t.Fatal(err)
			}
			firstScan := startTestLibraryMigration(t, server, libraryLayoutUpdate{Mode: storagepool.ModePools, Pools: []string{"disk1"}, FetchPool: "disk1"})
			if fixture.work {
				if _, err := os.Stat(filepath.Join(root, "disk1", "RJ00000000", "track.mp3")); err != nil {
					t.Fatal(err)
				}
				if _, err := os.Stat(filepath.Join(root, "RJ00000000")); !os.IsNotExist(err) {
					t.Fatalf("standard folder remained after pool switch: %v", err)
				}
			}
			secondScan := startTestLibraryMigration(t, server, libraryLayoutUpdate{Mode: storagepool.ModeStandard})
			if firstScan == secondScan {
				t.Fatal("second switch reused the first local scan")
			}
			layout, err := server.loadLibraryLayout(context.Background())
			if err != nil || layout.Mode != storagepool.ModeStandard {
				t.Fatalf("round-trip layout = %+v, %v", layout, err)
			}
			if fixture.work {
				contents, err := os.ReadFile(filepath.Join(root, "RJ00000000", "track.mp3"))
				if err != nil || string(contents) != "synthetic audio" {
					t.Fatalf("round-trip work = %q, %v", contents, err)
				}
				if _, err := os.Stat(filepath.Join(root, "disk1", "RJ00000000")); !os.IsNotExist(err) {
					t.Fatalf("pool work remains after standard switch: %v", err)
				}
			}
		})
	}
}

func TestLibraryMigrationResumesAfterRestart(t *testing.T) {
	for _, phase := range []string{"copy", "cleanup", "scan"} {
		t.Run(phase, func(t *testing.T) {
			root := t.TempDir()
			for _, name := range []string{"disk1", "RJ00000000"} {
				if err := os.Mkdir(filepath.Join(root, name), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"first.mp3", "second.mp3"} {
				if err := os.WriteFile(filepath.Join(root, "RJ00000000", name), []byte(name), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			path, db := openRestartableMigrationDB(t)
			server := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
			if err := server.EnsureLocalSource(context.Background()); err != nil {
				t.Fatal(err)
			}
			plan, err := server.buildLibraryMigrationPlan(context.Background(), libraryLayoutUpdate{
				Mode: storagepool.ModePools, Pools: []string{"disk1"}, FetchPool: "disk1",
			})
			if err != nil || len(plan.Moves) != 1 {
				t.Fatalf("restart fixture plan = %+v, %v", plan, err)
			}
			saveTestLibraryMigration(t, db, plan, phase)
			if phase == "copy" {
				partial := filepath.Join(root, "disk1", "RJ00000000.kikoto-migration-partial")
				if err := os.Mkdir(partial, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(partial, "first.mp3"), []byte("incomplete"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := server.registerStoragePools(context.Background(), plan.Current, plan.Requested.Pools); err != nil {
					t.Fatal(err)
				}
				if err := server.stageLibraryMigrationMove(context.Background(), plan.Moves[0]); err != nil {
					t.Fatal(err)
				}
				if err := server.commitLibraryMigration(context.Background(), plan); err != nil {
					t.Fatal(err)
				}
				if phase == "cleanup" {
					if err := os.Remove(filepath.Join(root, "RJ00000000", "first.mp3")); err != nil {
						t.Fatal(err)
					}
				} else {
					if err := server.removeMigratedSource(plan.Moves[0]); err != nil {
						t.Fatal(err)
					}
					if err := server.setLibraryMigrationPhase(context.Background(), "scan", 1); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			_, restarted := reopenMigrationServer(t, path, root)
			if !restarted.layoutMigrationActive.Load() {
				t.Fatal("restart did not enter maintenance for interrupted migration")
			}
			result := make(chan struct{})
			go func() {
				restarted.ResumeLibraryMigration(context.Background())
				close(result)
			}()
			waitForTestLibraryMigration(t, restarted)
			select {
			case <-result:
			case <-time.After(2 * time.Second):
				t.Fatal("migration resume did not return")
			}
			for _, name := range []string{"first.mp3", "second.mp3"} {
				contents, err := os.ReadFile(filepath.Join(root, "disk1", "RJ00000000", name))
				if err != nil || string(contents) != name {
					t.Fatalf("resumed %s = %q, %v", name, contents, err)
				}
			}
			if _, err := os.Stat(filepath.Join(root, "RJ00000000")); !os.IsNotExist(err) {
				t.Fatalf("source still exists after recovery: %v", err)
			}
			if _, err := os.Stat(filepath.Join(root, "disk1", "RJ00000000.kikoto-migration-partial")); !os.IsNotExist(err) {
				t.Fatalf("incomplete copy remains after recovery: %v", err)
			}
		})
	}
}
