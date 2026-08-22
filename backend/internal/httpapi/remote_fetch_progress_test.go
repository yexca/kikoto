package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRemoteFetchByteProgressPersistsKnownAndUnknownTransfers(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	statements := []string{
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'running', 'manual')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (1, 1, 'cache', 'materialize_cache', 'Cache selected files', 1, 'running')`,
		`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status) VALUES (1, 1, 1, 'remote_work_fetch', 'running')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	knownBytes := int64(2 << 20)
	staleBytes := int64(1 << 19)
	known := remoteWorkSavePlanItem{ItemKey: "remote:known.mp3", Action: "cache_download", SizeBytes: &knownBytes}
	unknown := remoteWorkSavePlanItem{ItemKey: "remote:unknown.mp3", Action: "cache_download"}
	stale := remoteWorkSavePlanItem{ItemKey: "remote:stale.mp3", Action: "cache_hit", SizeBytes: &staleBytes}
	progress, err := newRemoteFetchByteProgress(context.Background(), server, 1, 1, []remoteWorkSavePlanItem{known, unknown, stale})
	if err != nil {
		t.Fatal(err)
	}
	if err := progress.begin(0, known); err != nil {
		t.Fatal(err)
	}
	progress.report(0, known, 1<<20)
	if err := progress.complete(1, known, knownBytes); err != nil {
		t.Fatal(err)
	}
	if err := progress.begin(1, unknown); err != nil {
		t.Fatal(err)
	}
	progress.lastPersistedAt = progress.lastPersistedAt.Add(-remoteFetchProgressInterval)
	progress.report(1, unknown, 1<<20)
	assertFetchByteProgress(t, db, 3<<20, knownBytes, 1)
	if err := progress.complete(2, unknown, 1<<20); err != nil {
		t.Fatal(err)
	}
	assertFetchByteProgress(t, db, 3<<20, 3<<20, 0)
	stale.Action = "cache_download"
	if err := progress.includeDownload(stale); err != nil {
		t.Fatal(err)
	}
	if err := progress.begin(2, stale); err != nil {
		t.Fatal(err)
	}
	if err := progress.complete(3, stale, staleBytes); err != nil {
		t.Fatal(err)
	}
	assertFetchByteProgress(t, db, (3<<20)+staleBytes, (3<<20)+staleBytes, 0)

	run, err := server.workflowStore.LoadRun(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if run.ProgressBytesCurrent != (3<<20)+staleBytes || run.ProgressBytesTotal != (3<<20)+staleBytes || run.ProgressBytesUnknownItems != 0 {
		t.Fatalf("run progress = %d/%d unknown=%d", run.ProgressBytesCurrent, run.ProgressBytesTotal, run.ProgressBytesUnknownItems)
	}
	var outputJSON string
	if err := db.QueryRow(`SELECT output_json FROM workflow_node_run WHERE id = 1`).Scan(&outputJSON); err != nil {
		t.Fatal(err)
	}
	var output map[string]any
	if err := json.Unmarshal([]byte(outputJSON), &output); err != nil {
		t.Fatal(err)
	}
	if output["bytes_current"] != float64((3<<20)+staleBytes) || output["bytes_total"] != float64((3<<20)+staleBytes) || output["bytes_unknown_items"] != float64(0) {
		t.Fatalf("node output = %v", output)
	}
}

func assertFetchByteProgress(t *testing.T, db *sql.DB, current int64, total int64, unknown int) {
	t.Helper()
	var gotCurrent, gotTotal int64
	var gotUnknown int
	if err := db.QueryRow(`
		SELECT progress_bytes_current, progress_bytes_total, progress_bytes_unknown_items
		FROM workflow_job WHERE id = 1
	`).Scan(&gotCurrent, &gotTotal, &gotUnknown); err != nil {
		t.Fatal(err)
	}
	if gotCurrent != current || gotTotal != total || gotUnknown != unknown {
		t.Fatalf("job progress = %d/%d unknown=%d, want %d/%d unknown=%d", gotCurrent, gotTotal, gotUnknown, current, total, unknown)
	}
}
