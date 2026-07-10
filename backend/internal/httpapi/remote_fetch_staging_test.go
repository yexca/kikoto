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
		Items: []remoteWorkSavePlanItem{{Path: "track.mp3", Kind: "audio", SizeBytes: &size, SourceKind: "remote", Action: "cache_hit", CachePath: "remote/RJ01234567/track.mp3", TargetPath: "remote/RJ01234567/track.mp3"}},
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
