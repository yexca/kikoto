package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// seedQueuedCacheJobs inserts one queued media cache run per id. Each job
// allows three retries and resumes from a checkpoint.
func seedQueuedCacheJobs(t *testing.T, db *sql.DB, ids ...int64) {
	t.Helper()
	for _, id := range ids {
		for _, statement := range []struct {
			query string
			args  []any
		}{
			{`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (?, (SELECT id FROM workflow_definition WHERE code = 'media_cache'), 'media_cache', 'Cache', 'queued', 'manual')`, []any{id}},
			{`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (?, ?, 'cache', 'materialize_cache', 'Cache', 1, 'queued')`, []any{id, id}},
			{`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status, payload_json, checkpoint_json, recoverable, max_retries) VALUES (?, ?, ?, 'remote_media_cache', 'queued', '{"media_location_id":7}', '{"phase":"download"}', 1, 3)`, []any{id, id, id}},
		} {
			if _, err := db.Exec(statement.query, statement.args...); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func loadJobState(t *testing.T, db *sql.DB, jobID int64) (jobStatus, runStatus, lockedBy, errorMessage string, retryCount int) {
	t.Helper()
	if err := db.QueryRow(`
		SELECT job.status, run.status, job.locked_by, job.error_message, job.retry_count
		FROM workflow_job AS job INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.id = ?
	`, jobID).Scan(&jobStatus, &runStatus, &lockedBy, &errorMessage, &retryCount); err != nil {
		t.Fatal(err)
	}
	return
}

func TestUnfinishedJobIsSettledAndReleasesTheQueue(t *testing.T) {
	for _, test := range []struct {
		name      string
		runErr    error
		wantError string
	}{
		{name: "executor returned an error without recording it", runErr: errors.New("synthetic executor failure"), wantError: "synthetic executor failure"},
		{name: "executor returned success without recording it", runErr: nil, wantError: errWorkflowJobResultMissing.Error()},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{})
			ctx := context.Background()
			seedQueuedCacheJobs(t, db, 1, 2)
			job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "runner-a")
			if err != nil || !ok || job.ID != 1 {
				t.Fatalf("claim = %+v, %v, %v", job, ok, err)
			}

			_ = server.handleWorkflowJobResult(ctx, ctx, job, test.runErr)

			jobStatus, runStatus, lockedBy, errorMessage, _ := loadJobState(t, db, 1)
			if jobStatus != "failed" || runStatus != "failed" || lockedBy != "" || errorMessage != test.wantError {
				t.Fatalf("job=%s run=%s lock=%q error=%q, want failed/failed with %q", jobStatus, runStatus, lockedBy, errorMessage, test.wantError)
			}
			var events int
			if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = 1 AND event_type = 'job.result_missing'`).Scan(&events); err != nil {
				t.Fatal(err)
			}
			if events != 1 {
				t.Fatalf("job.result_missing events = %d, want 1", events)
			}
			next, ok, err := server.claimNextQueuedWorkflowJob(ctx, "runner-b")
			if err != nil || !ok || next.ID != 2 {
				t.Fatalf("next claim = %+v, %v, %v; want the queue released to job 2", next, ok, err)
			}
		})
	}
}

func TestRetryableErrorRequeuesJobItsExecutorLeftRunning(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	seedQueuedCacheJobs(t, db, 1)
	job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "runner-a")
	if err != nil || !ok {
		t.Fatalf("claim = %+v, %v, %v", job, ok, err)
	}

	if err := server.handleWorkflowJobResult(ctx, ctx, job, remoteDownloadError{StatusCode: 503, Retryable: true}); err != nil {
		t.Fatal(err)
	}

	jobStatus, runStatus, lockedBy, _, retryCount := loadJobState(t, db, 1)
	if jobStatus != "queued" || runStatus != "queued" || lockedBy != "" || retryCount != 1 {
		t.Fatalf("job=%s run=%s lock=%q retries=%d, want a queued automatic retry", jobStatus, runStatus, lockedBy, retryCount)
	}
}

func TestSettlementLeavesJobHeldByAnotherLease(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	seedQueuedCacheJobs(t, db, 1)
	job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "runner-a")
	if err != nil || !ok {
		t.Fatalf("claim = %+v, %v, %v", job, ok, err)
	}
	if _, err := db.Exec(`UPDATE workflow_job SET locked_by = 'runner-b' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}

	_ = server.handleWorkflowJobResult(ctx, ctx, job, errors.New("synthetic executor failure"))

	jobStatus, runStatus, lockedBy, _, _ := loadJobState(t, db, 1)
	if jobStatus != "running" || runStatus != "running" || lockedBy != "runner-b" {
		t.Fatalf("job=%s run=%s lock=%q, want the other lease untouched", jobStatus, runStatus, lockedBy)
	}
}
