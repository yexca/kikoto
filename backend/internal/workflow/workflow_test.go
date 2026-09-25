package workflow

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

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

func TestSettleOrphansLeavesLiveAndQueuedJobsAlone(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	store := NewStore(db)

	createJob := func(code, status string, recoverable bool, maxRetries int) (int64, int64) {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		definitionID, err := EnsureDefinition(ctx, tx, code, "Example recovery", "", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		runID, err := InsertRun(ctx, tx, definitionID, code, "Example recovery", status, "manual", "restart", nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		nodeID, err := InsertNodeRun(ctx, tx, runID, NodeRunSpec{NodeID: "recover", NodeType: "example_type", DisplayName: "Recover", Position: 1, Status: status})
		if err != nil {
			t.Fatal(err)
		}
		jobID, err := InsertJob(ctx, tx, runID, JobSpec{NodeRunID: nodeID, WorkerType: "example_worker", Status: status, Recoverable: recoverable, MaxRetries: maxRetries, Checkpoint: map[string]any{"phase": "resume"}})
		if err != nil {
			t.Fatal(err)
		}
		// Every running job carries a lease whose heartbeat is long past.
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_job
			SET locked_by = CASE WHEN status = 'running' THEN ? ELSE '' END,
				locked_at = '2000-01-01 00:00:00', heartbeat_at = '2000-01-01 00:00:00'
			WHERE id = ?
		`, code+"-lease", jobID); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		return runID, jobID
	}

	liveRunID, liveJobID := createJob("example_live", "running", true, 2)
	orphanRunID, orphanJobID := createJob("example_orphan", "running", true, 2)
	exhaustedRunID, exhaustedJobID := createJob("example_exhausted", "running", true, 1)
	queuedRunID, queuedJobID := createJob("example_queued", "queued", false, 1)
	if _, err := db.ExecContext(ctx, "UPDATE workflow_job SET resume_count = 1 WHERE id = ?", exhaustedJobID); err != nil {
		t.Fatal(err)
	}

	result, err := store.SettleOrphans(ctx, OrphanSweep{
		Reason:     "synthetic sweep",
		LiveLeases: func() map[string]bool { return map[string]bool{"example_live-lease": true} },
		CanViewAll: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result != (OrphanSweepResult{Requeued: 1, Failed: 1, Active: 1}) {
		t.Fatalf("sweep result = %+v", result)
	}

	for _, want := range []struct {
		name          string
		runID, jobID  int64
		run, job, key string
		resumes       int
	}{
		{name: "live lease", runID: liveRunID, jobID: liveJobID, run: "running", job: "running", key: "example_live-lease"},
		{name: "orphan with resume budget", runID: orphanRunID, jobID: orphanJobID, run: "queued", job: "queued", resumes: 1},
		{name: "orphan without resume budget", runID: exhaustedRunID, jobID: exhaustedJobID, run: "failed", job: "failed", resumes: 1},
		{name: "queued job", runID: queuedRunID, jobID: queuedJobID, run: "queued", job: "queued"},
	} {
		var runStatus, jobStatus, lockedBy string
		var resumeCount int
		if err := db.QueryRowContext(ctx, `
			SELECT run.status, job.status, job.locked_by, job.resume_count
			FROM workflow_run AS run INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
			WHERE job.id = ?
		`, want.jobID).Scan(&runStatus, &jobStatus, &lockedBy, &resumeCount); err != nil {
			t.Fatal(err)
		}
		if runStatus != want.run || jobStatus != want.job || lockedBy != want.key || resumeCount != want.resumes {
			t.Fatalf("%s: run=%s job=%s lock=%q resumes=%d, want run=%s job=%s lock=%q resumes=%d",
				want.name, runStatus, jobStatus, lockedBy, resumeCount, want.run, want.job, want.key, want.resumes)
		}
	}
	events, err := store.ListEvents(ctx, orphanRunID)
	if err != nil {
		t.Fatal(err)
	}
	if last := events[len(events)-1]; last.EventType != "job.orphan_requeued" || last.JobID == nil || *last.JobID != orphanJobID {
		t.Fatalf("orphan event = %+v", last)
	}
}
