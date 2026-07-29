package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func TestLocalLibraryScanQueuesIndependentRunsAndSynchronizesMetadataWithoutAvailabilityChecks(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	code := "RJ02000011"
	writeDemoScanFile(t, dataRoot, code, "track.mp3", "audio")
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	server.dlsiteClient = &fakeDemoScanDLsiteClient{
		products: map[string]dlsite.Product{
			code: demoScanProduct(code, "Scanned work", "general", nil, nil, nil),
		},
		errors: map[string]error{},
	}

	first, err := server.enqueueLocalScan(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.enqueueLocalScan(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "queued" || second.Status != "queued" || first.RunID == second.RunID {
		t.Fatalf("queued local scan results = %#v / %#v", first, second)
	}
	var snapshotCountBefore int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&snapshotCountBefore); err != nil {
		t.Fatal(err)
	}
	if snapshotCountBefore != 0 {
		t.Fatalf("metadata snapshots before worker execution = %d", snapshotCountBefore)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "local-scan-test")
	if err != nil || !ok {
		t.Fatalf("claim local scan job = %#v, %t, %v", job, ok, err)
	}
	if job.RunID != first.RunID || job.WorkerType != "local_library_scan" {
		t.Fatalf("claimed local scan job = %#v", job)
	}
	if err := server.executeLocalScanJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	var runCount, nodeCount, jobCount, snapshotCount, remotePresenceCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_run
		WHERE workflow_code IN ('local_library_scan', 'startup_library_refresh', 'metadata_sync')
	`).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ?", first.RunID).Scan(&nodeCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE workflow_run_id = ?", first.RunID).Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM metadata_snapshot AS snapshot
		INNER JOIN work ON work.id = snapshot.work_id
		WHERE work.primary_code = ?
	`, code).Scan(&snapshotCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE work.primary_code = ? AND presence.presence_type = ?
	`, code, sourcePresenceTypeRemoteSource).Scan(&remotePresenceCount); err != nil {
		t.Fatal(err)
	}
	var firstStatus, secondStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", first.RunID).Scan(&firstStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", second.RunID).Scan(&secondStatus); err != nil {
		t.Fatal(err)
	}
	if runCount != 2 || nodeCount != 5 || jobCount != 1 || snapshotCount != 1 || remotePresenceCount != 0 || firstStatus != "succeeded" || secondStatus != "queued" {
		t.Fatalf("merged run counts = runs %d nodes %d jobs %d snapshots %d remote presence %d", runCount, nodeCount, jobCount, snapshotCount, remotePresenceCount)
	}
}

func TestDLsiteMetadataSyncQueuesIndependentRuns(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})

	first, err := server.enqueueDLsiteMetadataSync(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.enqueueDLsiteMetadataSync(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "queued" || second.Status != "queued" || first.RunID == second.RunID {
		t.Fatalf("queued metadata results = %#v / %#v", first, second)
	}
	var queuedRuns, queuedJobs int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'metadata_sync' AND status = 'queued'").Scan(&queuedRuns); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE worker_type = 'metadata_sync' AND status = 'queued'").Scan(&queuedJobs); err != nil {
		t.Fatal(err)
	}
	if queuedRuns != 2 || queuedJobs != 2 {
		t.Fatalf("queued metadata runs/jobs = %d/%d", queuedRuns, queuedJobs)
	}
}
