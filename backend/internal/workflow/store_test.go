package workflow

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestStoreLoadsWorkflowViews(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := EnsureDefinition(ctx, tx, "test_flow", "Test flow", "Test definition", map[string]any{"nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := InsertRun(ctx, tx, definitionID, "test_flow", "Test flow", "partial", "manual", "test", map[string]any{}, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := InsertNodeRun(ctx, tx, runID, NodeRunSpec{NodeID: "review", NodeType: "filter_candidates", DisplayName: "Review", Position: 1, Status: "partial"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workflow_candidate (workflow_run_id, workflow_node_run_id, candidate_type, external_key, status) VALUES (?, ?, 'test', 'candidate', 'pending')`, runID, nodeID); err != nil {
		t.Fatal(err)
	}
	if err := InsertEvent(ctx, tx, runID, EventSpec{Level: "info", Type: "test.created", Message: "Created"}); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled) VALUES (?, 'startup', 'Test trigger', 1)`, definitionID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	store := NewStore(db)
	page, err := store.ListRuns(ctx, ListRunsOptions{Page: 1, PageSize: 10, View: "review", Query: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Runs) != 1 || page.Runs[0].PendingCandidates != 1 {
		t.Fatalf("ListRuns() = %#v", page)
	}
	detail, err := store.LoadRunDetail(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.NodeRuns) != 1 || detail.NodeRuns[0].ID != nodeID {
		t.Fatalf("LoadRunDetail() = %#v", detail)
	}
	events, err := store.ListEvents(ctx, runID)
	if err != nil || len(events) != 3 || events[len(events)-1].EventType != "test.created" {
		t.Fatalf("ListEvents() = %#v, %v", events, err)
	}
	candidates, err := store.ListCandidates(ctx, runID)
	if err != nil || len(candidates) != 1 || candidates[0].ExternalKey != "candidate" {
		t.Fatalf("ListCandidates() = %#v, %v", candidates, err)
	}
	definitions, err := store.ListDefinitions(ctx)
	if err != nil {
		t.Fatalf("ListDefinitions() = %#v, %v", definitions, err)
	}
	foundDefinition := false
	for _, definition := range definitions {
		if definition.Code == "test_flow" && definition.TriggerCount == 1 {
			foundDefinition = true
		}
	}
	if !foundDefinition {
		t.Fatalf("ListDefinitions() omitted test_flow: %#v", definitions)
	}
	triggers, err := store.ListTriggers(ctx)
	if err != nil {
		t.Fatalf("ListTriggers() = %#v, %v", triggers, err)
	}
	foundTrigger := false
	for _, trigger := range triggers {
		if trigger.WorkflowCode == "test_flow" && trigger.DisplayName == "Test trigger" {
			foundTrigger = true
		}
	}
	if !foundTrigger {
		t.Fatalf("ListTriggers() omitted test trigger: %#v", triggers)
	}
}

func TestStoreMarksStaleRunGraphFailed(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	tx, _ := db.BeginTx(ctx, nil)
	definitionID, err := EnsureDefinition(ctx, tx, "stale_flow", "Stale flow", "Test stale recovery", map[string]any{"nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := InsertRun(ctx, tx, definitionID, "stale_flow", "Stale flow", "running", "startup", "test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := InsertNodeRun(ctx, tx, runID, NodeRunSpec{NodeID: "run", NodeType: "sync_metadata", DisplayName: "Run", Position: 1, Status: "running"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InsertJob(ctx, tx, runID, JobSpec{NodeRunID: nodeID, WorkerType: "test", Status: "queued"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	count, err := NewStore(db).MarkStaleRuns(ctx, "restart")
	if err != nil || count != 1 {
		t.Fatalf("MarkStaleRuns() = %d, %v", count, err)
	}
	var runStatus, nodeStatus, jobStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE id = ?", nodeID).Scan(&nodeStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_job WHERE workflow_run_id = ?", runID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || nodeStatus != "failed" || jobStatus != "failed" {
		t.Fatalf("statuses = run %s, node %s, job %s", runStatus, nodeStatus, jobStatus)
	}
	var eventCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'run.recovered_stale'", runID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("recovery events = %d, %v", eventCount, err)
	}
}

func openWorkflowTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "workflow.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
