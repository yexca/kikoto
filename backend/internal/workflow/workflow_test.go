package workflow

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func openWorkflowTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "workflow.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestWorkflowRecordsPersistJobProgressAndEventDefaults(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := EnsureDefinition(ctx, tx, "example_workflow", "Example workflow", "Example description", map[string]any{"version": 1})
	if err != nil {
		t.Fatal(err)
	}
	runID, err := InsertRun(ctx, tx, definitionID, "example_workflow", "Example workflow run", "queued", "manual", "synthetic request", map[string]any{"requested_by_user_id": 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, err := InsertNodeRun(ctx, tx, runID, NodeRunSpec{
		NodeID: "example-node", NodeType: "example_type", DisplayName: "Example node", Position: 1, Status: "queued", Input: map[string]any{"code": "RJ00000000"},
	})
	if err != nil {
		t.Fatal(err)
	}
	jobID, err := InsertJob(ctx, tx, runID, JobSpec{
		NodeRunID: nodeID, WorkerType: "example_worker", Status: "queued", Priority: JobPriorityUserInitiated,
		ResourceKey: "  example:resource  ", Payload: map[string]any{"work_code": "RJ00000000"}, Checkpoint: map[string]any{"phase": "prepare"},
		Recoverable: true, ProgressCurrent: 2, ProgressTotal: 3, ProgressBytesCurrent: 100, ProgressBytesTotal: 250, ProgressBytesUnknownItems: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	store := NewStore(db)
	if err := store.RecordEvent(ctx, runID, "", "", "", nil); err != nil {
		t.Fatal(err)
	}
	detail, err := store.LoadRunDetail(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Status != "queued" || detail.NodeRunCount != 1 || detail.JobCount != 1 || detail.ProgressBytesCurrent != 100 || detail.ProgressBytesTotal != 250 || detail.ProgressBytesUnknownItems != 1 {
		t.Fatalf("run detail = %+v", detail.RunRecord)
	}
	if len(detail.NodeRuns) != 1 || detail.NodeRuns[0].ID != nodeID || detail.NodeRuns[0].FinishedAt != "" {
		t.Fatalf("node runs = %+v", detail.NodeRuns)
	}

	var resourceKey string
	var maxRetries int
	if err := db.QueryRowContext(ctx, "SELECT resource_key, max_retries FROM workflow_job WHERE id = ?", jobID).Scan(&resourceKey, &maxRetries); err != nil {
		t.Fatal(err)
	}
	if resourceKey != "example:resource" || maxRetries != 3 {
		t.Fatalf("job resource/retries = %q/%d", resourceKey, maxRetries)
	}
	events, err := store.ListEvents(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 4 || events[0].EventType != "run.recorded" || events[1].EventType != "node.recorded" || events[2].EventType != "job.recorded" || events[3].EventType != "workflow.event" || events[3].Message != "workflow.event" {
		t.Fatalf("events = %+v", events)
	}

	page, err := store.ListRuns(ctx, ListRunsOptions{Page: 0, PageSize: 101, Status: "queued", WorkflowCode: "example_workflow", Query: "synthetic"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Page != 1 || page.PageSize != 25 || page.Total != 1 || len(page.Runs) != 1 || page.Runs[0].ID != runID || page.ViewTotals.Running != 1 {
		t.Fatalf("run page = %+v", page)
	}
}

func TestRequeueExpiredJobsOnlyResumesEligibleLeases(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	store := NewStore(db)

	createRunningJob := func(code string, recoverable bool, maxRetries int) (int64, int64, int64) {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		definitionID, err := EnsureDefinition(ctx, tx, code, "Example recovery", "", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		runID, err := InsertRun(ctx, tx, definitionID, code, "Example recovery", "running", "manual", "restart", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		nodeID, err := InsertNodeRun(ctx, tx, runID, NodeRunSpec{NodeID: "recover", NodeType: "example_type", DisplayName: "Recover", Position: 1, Status: "running"})
		if err != nil {
			t.Fatal(err)
		}
		jobID, err := InsertJob(ctx, tx, runID, JobSpec{NodeRunID: nodeID, WorkerType: "example_worker", Status: "running", Recoverable: recoverable, MaxRetries: maxRetries, Checkpoint: map[string]any{"phase": "resume"}})
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return runID, nodeID, jobID
	}

	runID, _, eligibleJobID := createRunningJob("example_recoverable", true, 2)
	_, _, exhaustedJobID := createRunningJob("example_exhausted", true, 1)
	if _, err := db.ExecContext(ctx, `
		UPDATE workflow_job
		SET locked_by = 'synthetic-runner', locked_at = '2000-01-01 00:00:00', heartbeat_at = '2000-01-01 00:00:00'
		WHERE id IN (?, ?)
	`, eligibleJobID, exhaustedJobID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "UPDATE workflow_job SET resume_count = 1 WHERE id = ?", exhaustedJobID); err != nil {
		t.Fatal(err)
	}

	requeued, err := store.RequeueExpiredJobs(ctx, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if requeued != 1 {
		t.Fatalf("requeued = %d, want 1", requeued)
	}

	var runStatus, nodeStatus, jobStatus, lockedBy string
	var resumeCount int
	if err := db.QueryRowContext(ctx, `
		SELECT run.status, node.status, job.status, job.locked_by, job.resume_count
		FROM workflow_run AS run
		INNER JOIN workflow_node_run AS node ON node.workflow_run_id = run.id
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.id = ?
	`, runID).Scan(&runStatus, &nodeStatus, &jobStatus, &lockedBy, &resumeCount); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" || nodeStatus != "queued" || jobStatus != "queued" || lockedBy != "" || resumeCount != 1 {
		t.Fatalf("requeued state = run:%s node:%s job:%s lock:%q resumes:%d", runStatus, nodeStatus, jobStatus, lockedBy, resumeCount)
	}

	var exhaustedStatus string
	if err := db.QueryRowContext(ctx, "SELECT status FROM workflow_job WHERE id = ?", exhaustedJobID).Scan(&exhaustedStatus); err != nil {
		t.Fatal(err)
	}
	if exhaustedStatus != "running" {
		t.Fatalf("retry-exhausted job status = %q, want running", exhaustedStatus)
	}
	events, err := store.ListEvents(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if events[len(events)-1].EventType != "job.lease_expired" || events[len(events)-1].JobID == nil || *events[len(events)-1].JobID != eligibleJobID {
		t.Fatalf("lease event = %+v", events[len(events)-1])
	}
}
