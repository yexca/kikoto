package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// An operation an API request runs inline returns to the queue when the
// request ends before it records a result, as when its client disconnects, so
// the background worker runs it; the job keeps its resume budget.
func TestInlineJobReturnsToTheQueueWhenItsRequestEnds(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	execFetchTestStatements(t, db,
		`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES (1, 'media_cache_limit_cleanup', 'Cache limit cleanup', 'queued', 'manual')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (1, 1, 'cleanup', 'cleanup_cache', 'Clean up cache', 1, 'queued')`,
		`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status, recoverable, max_retries) VALUES (1, 1, 1, 'media_cache_limit_cleanup', 'queued', 1, 3)`,
	)
	requestCtx, endRequest := context.WithCancel(context.Background())
	_, stop, err := server.leaseInlineWorkflowJob(requestCtx, workflowJobRecord{ID: 1, RunID: 1, NodeRunID: 1})
	if err != nil {
		t.Fatal(err)
	}
	endRequest()
	stop()

	var jobStatus, runStatus string
	var resumes int
	if err := db.QueryRow(`SELECT job.status, job.resume_count, run.status FROM workflow_job AS job INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id WHERE job.id = 1`).Scan(&jobStatus, &resumes, &runStatus); err != nil {
		t.Fatal(err)
	}
	if jobStatus != "queued" || runStatus != "queued" || resumes != 0 {
		t.Fatalf("job %s (resumes %d), run %s; want both queued without a spent resume", jobStatus, resumes, runStatus)
	}
	var events int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = 1 AND event_type = 'job.requeued_after_disconnect'`).Scan(&events); err != nil || events != 1 {
		t.Fatalf("requeue events = %d, %v", events, err)
	}
}
