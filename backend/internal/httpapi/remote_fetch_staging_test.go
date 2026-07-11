package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

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
