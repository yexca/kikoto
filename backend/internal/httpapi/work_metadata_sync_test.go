package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metasync"
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

func TestUnavailableRequestedProductCompletesWithoutReviewCandidate(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	result, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ09999993', 'Unavailable')`)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := result.LastInsertId()
	run, err := server.enqueueWorkMetadataSync(context.Background(), workID)
	if err != nil {
		t.Fatal(err)
	}
	var nodeRunID int64
	if err := db.QueryRow(`SELECT workflow_node_run_id FROM workflow_job WHERE id = ?`, run.JobID).Scan(&nodeRunID); err != nil {
		t.Fatal(err)
	}
	job := workflowJobRecord{ID: run.JobID, RunID: run.RunID, NodeRunID: nodeRunID}
	payload := workMetadataSyncPayload{WorkID: workID, PrimaryCode: "RJ09999993", FamilyCode: "RJ09999993"}
	family := metasync.DLsiteFamilySyncResult{
		RequestedCode: "RJ09999993", CanonicalCode: "RJ09999993", Codes: []string{"RJ09999993"},
		Failures: []string{"RJ09999993: dlsite product not found"}, RequestedUnavailable: true,
	}
	if err := server.finishUnavailableWorkMetadataSyncJob(context.Background(), job, payload, family, "dlsite product not found"); err != nil {
		t.Fatal(err)
	}
	var runStatus, jobStatus, nodeStatus string
	if err := db.QueryRow(`SELECT status FROM workflow_run WHERE id = ?`, run.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status FROM workflow_job WHERE id = ?`, run.JobID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status FROM workflow_node_run WHERE id = ?`, nodeRunID).Scan(&nodeStatus); err != nil {
		t.Fatal(err)
	}
	var candidateCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_candidate WHERE workflow_run_id = ?`, run.RunID).Scan(&candidateCount); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" || jobStatus != "succeeded" || nodeStatus != "succeeded" || candidateCount != 0 {
		t.Fatalf("unavailable state = run %q job %q node %q candidates %d", runStatus, jobStatus, nodeStatus, candidateCount)
	}
}

func TestUnavailableProviderStateSkipsDetailRefresh(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	result, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ09999994', 'Unavailable')`)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := result.LastInsertId()
	if _, err := db.Exec(`INSERT OR IGNORE INTO metadata_provider (code, display_name) VALUES ('dlsite', 'DLsite')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_metadata_provider_state (work_id, provider_id, status, message)
		SELECT ?, id, 'not_found', 'missing' FROM metadata_provider WHERE code = 'dlsite'`, workID); err != nil {
		t.Fatal(err)
	}

	run, err := server.enqueueWorkMetadataSync(context.Background(), workID)
	if err != nil {
		t.Fatal(err)
	}
	if run.RunID != 0 || run.JobID != 0 || run.Status != "unavailable" {
		t.Fatalf("result = %+v, want unavailable without queued workflow", run)
	}
}
