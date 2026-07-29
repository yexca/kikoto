package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func TestLocalLibraryScanSynchronizesMetadataInOneRunWithoutAvailabilityChecks(t *testing.T) {
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

	result, err := server.runLocalScan(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.DetectedWorks != 1 || result.TargetWorks != 1 || result.SyncedWorks != 1 {
		t.Fatalf("local scan result = %#v", result)
	}

	var runCount, nodeCount, jobCount, snapshotCount, remotePresenceCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_run
		WHERE workflow_code IN ('local_library_scan', 'startup_library_refresh', 'metadata_sync')
	`).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ?", result.RunID).Scan(&nodeCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE workflow_run_id = ?", result.RunID).Scan(&jobCount); err != nil {
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
	if runCount != 1 || nodeCount != 5 || jobCount != 2 || snapshotCount != 1 || remotePresenceCount != 0 {
		t.Fatalf("merged run counts = runs %d nodes %d jobs %d snapshots %d remote presence %d", runCount, nodeCount, jobCount, snapshotCount, remotePresenceCount)
	}
}
