package httpapi

import (
	"context"
	"errors"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestServerShutdownWaitsForBackgroundWorkAndRefusesNewWork(t *testing.T) {
	server := NewServer(nil, config.Config{})
	cause := make(chan error, 1)
	release := make(chan struct{})
	server.Go(func(ctx context.Context) {
		<-ctx.Done()
		cause <- context.Cause(ctx)
		<-release
	})

	expired, cancel := context.WithCancel(context.Background())
	cancel()
	if err := server.Shutdown(expired); !errors.Is(err, context.Canceled) {
		t.Fatalf("Shutdown with running work = %v, want the caller deadline error", err)
	}
	if err := <-cause; !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("background cancellation cause = %v, want ErrShuttingDown", err)
	}
	if server.Go(func(context.Context) { t.Error("background work started after shutdown began") }) {
		t.Fatal("Go accepted work after shutdown began")
	}
	close(release)
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown after work finished = %v", err)
	}
}

func TestShutdownInterruptedJobSettlesWithoutSpendingResumeBudget(t *testing.T) {
	stopped, stop := context.WithCancelCause(context.Background())
	stop(ErrShuttingDown)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	for _, test := range []struct {
		name        string
		recoverable int
		lifetime    context.Context
		wantJob     string
		wantRun     string
		wantError   string
	}{
		{name: "recoverable job returns to the queue", recoverable: 1, lifetime: stopped, wantJob: "queued", wantRun: "queued"},
		{name: "job without a checkpoint fails with the stop reason", recoverable: 0, lifetime: stopped, wantJob: "failed", wantRun: "failed", wantError: "interrupted by service stop"},
		{name: "cancellation without a service stop does not hold the queue", recoverable: 1, lifetime: cancelled, wantJob: "failed", wantRun: "failed", wantError: "context canceled"},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{})
			ctx := context.Background()
			statements := []string{
				`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'media_cache'), 'media_cache', 'Cache', 'queued', 'manual')`,
				`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (1, 1, 'cache', 'materialize_cache', 'Cache', 1, 'queued')`,
				`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status, payload_json, checkpoint_json, recoverable, max_retries) VALUES (1, 1, 1, 'remote_media_cache', 'queued', '{"media_location_id":7}', '{"phase":"download","index":1}', ?, 3)`,
			}
			for index, statement := range statements {
				args := []any{}
				if index == len(statements)-1 {
					args = append(args, test.recoverable)
				}
				if _, err := db.Exec(statement, args...); err != nil {
					t.Fatal(err)
				}
			}
			job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "stopping-runner")
			if err != nil || !ok {
				t.Fatalf("claim = %+v, %v, %v", job, ok, err)
			}
			jobCtx, cancelJob := context.WithCancel(test.lifetime)
			defer cancelJob()

			_ = server.handleWorkflowJobResult(test.lifetime, jobCtx, job, context.Canceled)

			var jobStatus, runStatus, jobError string
			var resumeCount int
			if err := db.QueryRow(`SELECT job.status, job.error_message, job.resume_count, run.status FROM workflow_job AS job INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id WHERE job.id = 1`).Scan(&jobStatus, &jobError, &resumeCount, &runStatus); err != nil {
				t.Fatal(err)
			}
			if jobStatus != test.wantJob || runStatus != test.wantRun || jobError != test.wantError || resumeCount != 0 {
				t.Fatalf("job=%s (%q, resumes %d) run=%s, want job=%s (%q, resumes 0) run=%s", jobStatus, jobError, resumeCount, runStatus, test.wantJob, test.wantError, test.wantRun)
			}
			if test.wantJob != "queued" {
				return
			}
			if err := server.RecoverInterruptedWorkflows(ctx); err != nil {
				t.Fatal(err)
			}
			resumed, ok, err := server.claimNextQueuedWorkflowJob(ctx, "next-runner")
			if err != nil || !ok {
				t.Fatalf("reclaim = %+v, %v, %v", resumed, ok, err)
			}
			if resumed.ResumeCount != 0 || resumed.CheckpointJSON != `{"phase":"download","index":1}` {
				t.Fatalf("resumed job = %+v, want its checkpoint without a spent resume", resumed)
			}
		})
	}
}
