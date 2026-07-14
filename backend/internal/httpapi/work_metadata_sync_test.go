package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestWorkMetadataSyncQueuesOneRecoverableRunPerFamily(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	originResult, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ09999991', 'Origin')`)
	if err != nil {
		t.Fatal(err)
	}
	originID, _ := originResult.LastInsertId()
	translationResult, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ09999992', 'Translation')`)
	if err != nil {
		t.Fatal(err)
	}
	translationID, _ := translationResult.LastInsertId()
	logicalResult, err := db.Exec(`INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ09999991')`, originID)
	if err != nil {
		t.Fatal(err)
	}
	logicalID, _ := logicalResult.LastInsertId()
	if _, err := db.Exec(`INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical)
		VALUES (?, ?, 'RJ09999991', 'RJ09999991', 1), (?, ?, 'RJ09999992', 'RJ09999991', 0)`, originID, logicalID, translationID, logicalID); err != nil {
		t.Fatal(err)
	}

	first, err := server.enqueueWorkMetadataSync(context.Background(), originID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.enqueueWorkMetadataSync(context.Background(), translationID)
	if err != nil {
		t.Fatal(err)
	}
	if first.RunID != second.RunID || !second.Deduplicated {
		t.Fatalf("family runs = first %#v second %#v, want one deduplicated run", first, second)
	}
	var code, status, workerType string
	var recoverable int
	if err := db.QueryRow(`SELECT run.workflow_code, run.status, job.worker_type, job.recoverable
		FROM workflow_run AS run INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id WHERE run.id = ?`, first.RunID).
		Scan(&code, &status, &workerType, &recoverable); err != nil {
		t.Fatal(err)
	}
	if code != "metadata_family_sync" || status != "queued" || workerType != "metadata_family_sync" || recoverable != 1 {
		t.Fatalf("queued workflow = code %q status %q worker %q recoverable %d", code, status, workerType, recoverable)
	}
}
