package integration_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

func TestStoreLoadsWorkflowViews(t *testing.T) {
	db := openMigratedTestDB(t, "workflow-views.db")
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "test_flow", "Test flow", "Test definition", map[string]any{"nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "test_flow", "Test flow", "partial", "manual", "test", map[string]any{}, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "review", NodeType: "filter_candidates", DisplayName: "Review", Position: 1, Status: "partial"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workflow_candidate (workflow_run_id, workflow_node_run_id, candidate_type, external_key, status) VALUES (?, ?, 'test', 'candidate', 'pending')`, runID, nodeID); err != nil {
		t.Fatal(err)
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{Level: "info", Type: "test.created", Message: "Created"}); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled) VALUES (?, 'startup', 'Test trigger', 1)`, definitionID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	store := workflow.NewStore(db)
	page, err := store.ListRuns(ctx, workflow.ListRunsOptions{Page: 1, PageSize: 10, View: "review", Query: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Runs) != 1 || page.Runs[0].PendingCandidates != 1 {
		t.Fatalf("ListRuns() = %#v", page)
	}
	if page.ViewTotals.Review != 1 || page.ViewTotals.Completed != 0 || page.ViewTotals.Running != 0 || page.ViewTotals.Failed != 0 {
		t.Fatalf("ListRuns().ViewTotals = %#v", page.ViewTotals)
	}
	if _, err := db.ExecContext(ctx, "UPDATE workflow_candidate SET status = 'resolved' WHERE workflow_run_id = ?", runID); err != nil {
		t.Fatal(err)
	}
	resolvedPage, err := store.ListRuns(ctx, workflow.ListRunsOptions{Page: 1, PageSize: 10, View: "review", Query: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if resolvedPage.Total != 0 || resolvedPage.ViewTotals.Review != 0 || resolvedPage.ViewTotals.Completed != 1 {
		t.Fatalf("resolved ListRuns() = %#v", resolvedPage)
	}
	completedPage, err := store.ListRuns(ctx, workflow.ListRunsOptions{Page: 1, PageSize: 10, View: "completed", Query: "test"})
	if err != nil || completedPage.Total != 1 || len(completedPage.Runs) != 1 || completedPage.Runs[0].Status != "partial" || completedPage.Runs[0].ReviewedAt != "" {
		t.Fatalf("completed ListRuns() = %#v, %v", completedPage, err)
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
	incrementalEvents, err := store.ListEventsAfter(ctx, runID, events[len(events)-2].ID)
	if err != nil || len(incrementalEvents) != 1 || incrementalEvents[0].ID != events[len(events)-1].ID {
		t.Fatalf("ListEventsAfter() = %#v, %v", incrementalEvents, err)
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

func TestStoreRequeuesStrandedRunBesideQueuedJob(t *testing.T) {
	db := openMigratedTestDB(t, "workflow-stale.db")
	ctx := context.Background()
	tx, _ := db.BeginTx(ctx, nil)
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "stale_flow", "Stale flow", "Test stale recovery", map[string]any{"nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "stale_flow", "Stale flow", "running", "startup", "test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "run", NodeType: "sync_metadata", DisplayName: "Run", Position: 1, Status: "running"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: "test", Status: "queued"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	result, err := workflow.NewStore(db).SettleOrphans(ctx, workflow.OrphanSweep{Reason: "restart", SettleIdleRuns: true, CanViewAll: true})
	if err != nil || result != (workflow.OrphanSweepResult{Requeued: 1}) {
		t.Fatalf("SettleOrphans() = %+v, %v", result, err)
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
	if runStatus != "queued" || nodeStatus != "queued" || jobStatus != "queued" {
		t.Fatalf("statuses = run %s, node %s, job %s", runStatus, nodeStatus, jobStatus)
	}
	var eventCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'run.requeued_stranded'", runID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("recovery events = %d, %v", eventCount, err)
	}
}

func TestStoreFailsRunWithNoRemainingJob(t *testing.T) {
	db := openMigratedTestDB(t, "workflow-idle.db")
	ctx := context.Background()
	tx, _ := db.BeginTx(ctx, nil)
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "idle_flow", "Idle flow", "Test idle run recovery", map[string]any{"nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "idle_flow", "Idle flow", "running", "startup", "test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "run", NodeType: "sync_metadata", DisplayName: "Run", Position: 1, Status: "running"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: "test", Status: "succeeded"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	store := workflow.NewStore(db)
	graced, err := store.SettleOrphans(ctx, workflow.OrphanSweep{Reason: "manual recovery", SettleIdleRuns: true, IdleRunGrace: time.Hour, CanViewAll: true})
	if err != nil || graced != (workflow.OrphanSweepResult{}) {
		t.Fatalf("SettleOrphans() within grace = %+v, %v", graced, err)
	}
	result, err := store.SettleOrphans(ctx, workflow.OrphanSweep{Reason: "restart", SettleIdleRuns: true, CanViewAll: true})
	if err != nil || result != (workflow.OrphanSweepResult{Failed: 1}) {
		t.Fatalf("SettleOrphans() = %+v, %v", result, err)
	}
	var runStatus, nodeStatus string
	if err := db.QueryRow("SELECT run.status, node.status FROM workflow_run AS run INNER JOIN workflow_node_run AS node ON node.workflow_run_id = run.id WHERE run.id = ?", runID).Scan(&runStatus, &nodeStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || nodeStatus != "failed" {
		t.Fatalf("statuses = run %s, node %s", runStatus, nodeStatus)
	}
	var eventCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'run.recovered_stale'", runID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("recovery events = %d, %v", eventCount, err)
	}
}

func TestStoreRequeuesRecoverableRunFromCheckpoint(t *testing.T) {
	db := openMigratedTestDB(t, "workflow-checkpoint.db")
	ctx := context.Background()
	tx, _ := db.BeginTx(ctx, nil)
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "recoverable_flow", "Recoverable flow", "Test checkpoint recovery", map[string]any{"nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "recoverable_flow", "Recoverable flow", "running", "startup", "test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "run", NodeType: "materialize_cache", DisplayName: "Run", Position: 1, Status: "running"})
	if err != nil {
		t.Fatal(err)
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: nodeID, WorkerType: "test", Status: "running", Recoverable: true, MaxRetries: 3,
		Checkpoint: map[string]any{"phase": "download", "index": 7},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	result, err := workflow.NewStore(db).SettleOrphans(ctx, workflow.OrphanSweep{Reason: "restart", SettleIdleRuns: true, CanViewAll: true})
	if err != nil || result != (workflow.OrphanSweepResult{Requeued: 1}) {
		t.Fatalf("SettleOrphans() = %+v, %v", result, err)
	}
	var runStatus, nodeStatus, jobStatus, checkpoint string
	var resumeCount int
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE id = ?", nodeID).Scan(&nodeStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status, checkpoint_json, resume_count FROM workflow_job WHERE id = ?", jobID).Scan(&jobStatus, &checkpoint, &resumeCount); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" || nodeStatus != "queued" || jobStatus != "queued" || resumeCount != 1 {
		t.Fatalf("statuses = run %s, node %s, job %s, resumes %d", runStatus, nodeStatus, jobStatus, resumeCount)
	}
	if !strings.Contains(checkpoint, `"phase":"download"`) {
		t.Fatalf("checkpoint was not preserved: %s", checkpoint)
	}
	var eventCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'job.orphan_requeued'", runID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatalf("requeue events = %d, %v", eventCount, err)
	}
}

func TestStoreRequeuesOrphanedRecoverableLease(t *testing.T) {
	db := openMigratedTestDB(t, "workflow-lease.db")
	ctx := context.Background()
	tx, _ := db.BeginTx(ctx, nil)
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "lease_flow", "Lease flow", "Test lease recovery", map[string]any{"nodes": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "lease_flow", "Lease flow", "running", "manual", "test", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "run", NodeType: "execute", DisplayName: "Run", Position: 1, Status: "running"})
	if err != nil {
		t.Fatal(err)
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: "test", Status: "running", Recoverable: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`UPDATE workflow_job SET locked_by = 'released-runner', locked_at = '2000-01-01 00:00:00', heartbeat_at = '2000-01-01 00:00:00' WHERE id = ?`, jobID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	result, err := workflow.NewStore(db).SettleOrphans(ctx, workflow.OrphanSweep{
		LiveLeases: func() map[string]bool { return map[string]bool{"live-runner": true} }, CanViewAll: true,
	})
	if err != nil || result != (workflow.OrphanSweepResult{Requeued: 1}) {
		t.Fatalf("SettleOrphans() = %+v, %v", result, err)
	}
	var status, lock string
	var resumes int
	if err := db.QueryRow(`SELECT status, locked_by, resume_count FROM workflow_job WHERE id = ?`, jobID).Scan(&status, &lock, &resumes); err != nil {
		t.Fatal(err)
	}
	if status != "queued" || lock != "" || resumes != 1 {
		t.Fatalf("job status=%s lock=%q resumes=%d", status, lock, resumes)
	}
}
