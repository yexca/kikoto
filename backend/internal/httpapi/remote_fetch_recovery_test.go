package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func writeFetchTestFile(t *testing.T, root string, relative string, content string) {
	t.Helper()
	absolute := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(absolute, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fetchTestDirectoryFiles(t *testing.T, root string) []string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func execFetchTestStatements(t *testing.T, db *sql.DB, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
}

// newFetchPublishFixture prepares a Fetch that adds track.mp3 from cache to a
// target root that already holds earlier.mp3.
func newFetchPublishFixture(t *testing.T) (*Server, *sql.DB, remoteWorkSavePlan) {
	t.Helper()
	ctx := context.Background()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	root := "Library/" + code
	execFetchTestStatements(t, db,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru'), (2, 'example_local', 'Example Local', 'local_folder')`,
		fmt.Sprintf(`INSERT INTO work (id, primary_code, title) VALUES (1, '%s', 'Example Work')`, code),
		`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES (1, 'remote_work_fetch', 'Example Fetch', 'running', 'manual')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status) VALUES (1, 1, 'remote_work_fetch', 'running')`,
	)
	writeFetchTestFile(t, server.cfg.DataRoot, root+"/earlier.mp3", "earlier")
	cachePath := "remote/" + code + "/track.mp3"
	writeFetchTestFile(t, server.cfg.CacheRoot, cachePath, "track")
	size := int64(len("track"))
	plan := remoteWorkSavePlan{
		SourceID: 1, PrimaryCode: code, SaveRoot: root,
		Items: []remoteWorkSavePlanItem{{
			ItemKey: "remote:track.mp3", Path: "track.mp3", Kind: "audio", SizeBytes: &size,
			SourceKind: "remote", Action: "cache_hit", CachePath: cachePath,
			TargetPath: root + "/track.mp3", OriginalTargetPath: root + "/track.mp3",
			Resolution: "auto", RemoteSourceID: 1, SourcePath: "https://source.example.invalid/track.mp3",
		}},
	}
	plan.Summary = summarizeRemoteSavePlan(plan.Items)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := createRemoteFetchManifest(ctx, tx, 1, 1, "synthetic-request", 1, 1, 2, plan); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return server, db, plan
}

func TestStageAndPublishRetryAfterLostPublishedStateKeepsExistingFiles(t *testing.T) {
	ctx := context.Background()
	server, db, plan := newFetchPublishFixture(t)
	// Both publication renames succeed, then the state write fails.
	execFetchTestStatements(t, db, `
		CREATE TRIGGER fail_fetch_published BEFORE UPDATE OF state ON remote_fetch_manifest
		WHEN NEW.state = 'published'
		BEGIN SELECT RAISE(ABORT, 'database is locked'); END`)
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.stageAndPublishRemoteFetch(ctx, manifest, plan); err == nil {
		t.Fatal("first publication unexpectedly recorded its state")
	}
	execFetchTestStatements(t, db, `DROP TRIGGER fail_fetch_published`)

	manifest, err = server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	promoted, err := server.stageAndPublishRemoteFetch(ctx, manifest, plan)
	if err != nil || promoted != 1 {
		t.Fatalf("retry promoted=%d error=%v", promoted, err)
	}
	targetRoot := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.SaveRoot))
	if files := fetchTestDirectoryFiles(t, targetRoot); strings.Join(files, ",") != "earlier.mp3,track.mp3" {
		t.Fatalf("target files = %v", files)
	}
	manifest, err = server.loadRemoteFetchManifest(ctx, 1)
	if err != nil || manifest.State != "published" {
		t.Fatalf("manifest state=%q error=%v", manifest.State, err)
	}
	backupRoot := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(manifest.BackupRoot))
	if files := fetchTestDirectoryFiles(t, backupRoot); strings.Join(files, ",") != "earlier.mp3" {
		t.Fatalf("rollback backup = %v, want the previous root until completion", files)
	}
}

func TestPublishRemoteFetchRefusesToReplaceExistingBackup(t *testing.T) {
	ctx := context.Background()
	server, _, plan := newFetchPublishFixture(t)
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	writeFetchTestFile(t, server.cfg.DataRoot, manifest.BackupRoot+"/original.mp3", "original")

	if _, err := server.stageAndPublishRemoteFetch(ctx, manifest, plan); !errors.Is(err, errRemoteFetchBackupPending) {
		t.Fatalf("publish error = %v, want pending backup refusal", err)
	}
	backupRoot := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(manifest.BackupRoot))
	if files := fetchTestDirectoryFiles(t, backupRoot); strings.Join(files, ",") != "original.mp3" {
		t.Fatalf("backup files = %v", files)
	}
	targetRoot := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.SaveRoot))
	if files := fetchTestDirectoryFiles(t, targetRoot); strings.Join(files, ",") != "earlier.mp3" {
		t.Fatalf("target files = %v", files)
	}
}

// seedPublishedFetch records a Fetch whose files are published but whose
// registration was interrupted. withRemoteStream selects whether the
// remote_stream row survived; without it, the local location written before
// the interruption is the only remaining link to the media item.
func seedPublishedFetch(t *testing.T, server *Server, db *sql.DB, index int, withRemoteStream bool) remoteWorkSavePlan {
	t.Helper()
	ctx := context.Background()
	id := int64(index + 1)
	code := testfixture.WorkCode(testfixture.PrefixRJ, index)
	root := "Library/" + code
	targetPath := root + "/track.mp3"
	execFetchTestStatements(t, db,
		fmt.Sprintf(`INSERT INTO work (id, primary_code, title) VALUES (%d, '%s', 'Example Work')`, id, code),
		fmt.Sprintf(`INSERT INTO media_item (id, work_id, kind, title) VALUES (%d, %d, 'audio', 'Track')`, id, id),
		fmt.Sprintf(`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, finished_at) VALUES (%d, 'remote_work_fetch', 'Example Fetch', 'failed', 'manual', CURRENT_TIMESTAMP)`, id),
		fmt.Sprintf(`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status) VALUES (%d, %d, 'remote_work_fetch', 'failed')`, id, id),
	)
	if withRemoteStream {
		execFetchTestStatements(t, db, fmt.Sprintf(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (%d, 1, 'remote_stream', 'track.mp3', 'available')`, id))
	} else {
		execFetchTestStatements(t, db, fmt.Sprintf(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (%d, 2, 'local', '%s', 'available')`, id, targetPath))
	}
	writeFetchTestFile(t, server.cfg.DataRoot, targetPath, "track")
	size := int64(len("track"))
	plan := remoteWorkSavePlan{
		SourceID: 1, PrimaryCode: code, SaveRoot: root,
		Items: []remoteWorkSavePlanItem{{
			ItemKey: "remote:track.mp3", Path: "track.mp3", Kind: "audio", SizeBytes: &size,
			SourceKind: "remote", Action: "cache_hit", CachePath: "remote/" + code + "/track.mp3",
			TargetPath: targetPath, OriginalTargetPath: targetPath, Resolution: "auto", RemoteSourceID: 1,
		}},
	}
	plan.Summary = summarizeRemoteSavePlan(plan.Items)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	manifestID, err := createRemoteFetchManifest(ctx, tx, id, id, "synthetic-request", id, 1, 2, plan)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`UPDATE remote_fetch_manifest SET state = 'published' WHERE id = ?`, manifestID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return plan
}

func newFetchRecoveryServer(t *testing.T) (*Server, *sql.DB) {
	t.Helper()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	execFetchTestStatements(t, db, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru'), (2, 'example_local', 'Example Local', 'local_folder')`)
	return server, db
}

func TestRecoverInterruptedWorkflowsCompletesPublishedFetch(t *testing.T) {
	for _, scenario := range []struct {
		name             string
		withRemoteStream bool
	}{
		{name: "remote stream retained", withRemoteStream: true},
		{name: "remote stream already retired", withRemoteStream: false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server, db := newFetchRecoveryServer(t)
			plan := seedPublishedFetch(t, server, db, 0, scenario.withRemoteStream)
			if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
				t.Fatal(err)
			}
			var manifestState, runStatus string
			if err := db.QueryRow(`SELECT manifest.state, run.status FROM remote_fetch_manifest AS manifest INNER JOIN workflow_run AS run ON run.id = manifest.workflow_run_id WHERE run.id = 1`).Scan(&manifestState, &runStatus); err != nil {
				t.Fatal(err)
			}
			if manifestState != "completed" || runStatus != "succeeded" {
				t.Fatalf("manifest=%q run=%q", manifestState, runStatus)
			}
			var localLocations, remoteStreams int
			if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND file_source_id = 2 AND location_type = 'local' AND path = ? AND availability = 'available'`, plan.Items[0].TargetPath).Scan(&localLocations); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND location_type = 'remote_stream'`).Scan(&remoteStreams); err != nil {
				t.Fatal(err)
			}
			if localLocations != 1 || remoteStreams != 0 {
				t.Fatalf("local locations=%d remote streams=%d", localLocations, remoteStreams)
			}
		})
	}
}

func TestRecoverInterruptedWorkflowsContinuesPastUnrecoverableFetch(t *testing.T) {
	server, db := newFetchRecoveryServer(t)
	seedPublishedFetch(t, server, db, 0, true)
	seedPublishedFetch(t, server, db, 1, true)
	// The first Fetch lost its published target; recovery cannot register it.
	if err := os.RemoveAll(filepath.Join(server.cfg.DataRoot, "Library", testfixture.WorkCode(testfixture.PrefixRJ, 0))); err != nil {
		t.Fatal(err)
	}

	if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatalf("startup recovery stopped at one Fetch: %v", err)
	}
	states := map[int64]string{}
	rows, err := db.Query(`SELECT workflow_run_id, state FROM remote_fetch_manifest`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var runID int64
		var state string
		if err := rows.Scan(&runID, &state); err != nil {
			t.Fatal(err)
		}
		states[runID] = state
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if states[1] != "published" || states[2] != "completed" {
		t.Fatalf("manifest states = %v", states)
	}
	var message string
	if err := db.QueryRow(`SELECT message FROM workflow_event WHERE workflow_run_id = 1 AND event_type = 'fetch.recovery_failed'`).Scan(&message); err != nil {
		t.Fatalf("recovery failure event: %v", err)
	}
	if strings.Contains(message, server.cfg.DataRoot) {
		t.Fatalf("recovery event exposes a local path: %q", message)
	}
}
