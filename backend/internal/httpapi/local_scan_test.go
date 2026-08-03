package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

func TestDetectedMediaUpsertsReuseExistingRowsWithoutReturningClauses(t *testing.T) {
	db := openMigratedTestDB(t)
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	folder := localfs.WorkFolder{Code: "TEST-WORK-LOCAL-001", Title: "Detected work", RelPath: "TEST-WORK-LOCAL-001"}
	workID, err := upsertDetectedWork(context.Background(), tx, folder)
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2}).upsertLocalFileSource(context.Background(), tx, 2)
	if err != nil {
		t.Fatal(err)
	}
	file := localfs.LocalFile{RelPath: "TEST-WORK-LOCAL-001/track.mp3", WorkRelPath: "track.mp3", Title: "Track", SizeBytes: 100}
	firstItemID, err := upsertDetectedMediaItem(context.Background(), tx, workID, folder, file, "audio", 1)
	if err != nil {
		t.Fatal(err)
	}
	firstLocationID, err := upsertDetectedLocation(context.Background(), tx, firstItemID, sourceID, file)
	if err != nil {
		t.Fatal(err)
	}
	file.Title = "Renamed track"
	file.SizeBytes = 200
	secondItemID, err := upsertDetectedMediaItem(context.Background(), tx, workID, folder, file, "audio", 1)
	if err != nil {
		t.Fatal(err)
	}
	secondLocationID, err := upsertDetectedLocation(context.Background(), tx, secondItemID, sourceID, file)
	if err != nil {
		t.Fatal(err)
	}
	if firstItemID != secondItemID || firstLocationID != secondLocationID {
		t.Fatalf("upsert ids changed: item %d/%d, location %d/%d", firstItemID, secondItemID, firstLocationID, secondLocationID)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	var title string
	var itemSize, locationSize int64
	if err := db.QueryRow("SELECT title, size_bytes FROM media_item WHERE id = ?", firstItemID).Scan(&title, &itemSize); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT size_bytes FROM media_file_location WHERE id = ?", firstLocationID).Scan(&locationSize); err != nil {
		t.Fatal(err)
	}
	if title != "Renamed track" || itemSize != 200 || locationSize != 200 {
		t.Fatalf("updated media = title %q, item size %d, location size %d", title, itemSize, locationSize)
	}
}

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
	// A transaction must use its own connection for every query. Restricting
	// the pool to one connection turns accidental pool re-entry into a
	// deterministic regression instead of a production-only lock cycle.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	executionCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.executeLocalScanJob(executionCtx, job); err != nil {
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
