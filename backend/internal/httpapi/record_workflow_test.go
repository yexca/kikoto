package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// The Record scan is a system workflow from startup, so Workflows can filter
// by it before the first scan, and a scan runs under that same definition.
func TestRecordScanDefinitionExistsBeforeTheFirstScan(t *testing.T) {
	ctx := context.Background()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(ctx); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	var scope string
	if err := db.QueryRowContext(ctx, `SELECT id, scope FROM workflow_definition WHERE code = ?`, recordScanWorkflowCode).Scan(&definitionID, &scope); err != nil {
		t.Fatalf("record scan definition after startup: %v", err)
	}
	if scope != "system" {
		t.Fatalf("record scan definition scope = %q, want system", scope)
	}

	queued, err := server.enqueueRecordScan(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	var runDefinitionID int64
	if err := db.QueryRowContext(ctx, `SELECT workflow_definition_id FROM workflow_run WHERE id = ?`, queued.RunID).Scan(&runDefinitionID); err != nil {
		t.Fatal(err)
	}
	if runDefinitionID != definitionID {
		t.Fatalf("record scan run definition = %d, want %d", runDefinitionID, definitionID)
	}
}
