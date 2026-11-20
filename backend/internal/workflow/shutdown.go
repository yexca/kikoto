package workflow

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// JobLease identifies the claim a runner holds on a running job.
type JobLease struct {
	JobID     int64
	RunID     int64
	NodeRunID int64
	LockedBy  string
}

// ReleaseInterruptedJob settles a running job that a service stop interrupted.
// A recoverable job returns to the queue from its checkpoint without spending
// its resume budget, because a requested stop is not a job failure. A job that
// cannot resume from a checkpoint fails with the stop reason. It reports false
// when the lease no longer owns a running job, for example because the job
// finished or its run was cancelled before the release.
func (s *Store) ReleaseInterruptedJob(ctx context.Context, lease JobLease, reason string) (bool, error) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "interrupted by service stop"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var recoverable bool
	err = tx.QueryRowContext(ctx, `
		SELECT job.recoverable = 1 AND job.resume_count < job.max_retries
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.id = ? AND job.status = 'running' AND job.locked_by = ? AND run.status <> 'cancelled'
	`, lease.JobID, lease.LockedBy).Scan(&recoverable)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	settlement := leaseSettlement{
		requeue: recoverable, reason: reason, eventType: "job.interrupted_by_stop",
		message: "Job returned to the queue when the service stopped",
	}
	if !recoverable {
		settlement.summary = map[string]any{"interrupted_by_stop": true}
		settlement.message = "Job stopped with the service and cannot resume from a checkpoint"
	}
	settled, err := settleLeaseTx(ctx, tx, lease, settlement)
	if err != nil || !settled {
		return false, err
	}
	return true, tx.Commit()
}

// ReleaseDisconnectedJob returns a job that an API request ran inline to the
// queue when the request's client went away before the job finished, so the
// background worker runs it. A disconnect is not a failure: the job keeps its
// resume budget. A cancelled run keeps its cancellation.
func (s *Store) ReleaseDisconnectedJob(ctx context.Context, lease JobLease) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var active bool
	err = tx.QueryRowContext(ctx, `
		SELECT 1 FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.id = ? AND job.status = 'running' AND job.locked_by = ? AND run.status <> 'cancelled'
	`, lease.JobID, lease.LockedBy).Scan(&active)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	settled, err := settleLeaseTx(ctx, tx, lease, leaseSettlement{
		requeue: true, reason: "request ended before the job finished", eventType: "job.requeued_after_disconnect",
		message: "Job returned to the queue when its request ended before it finished",
	})
	if err != nil || !settled {
		return false, err
	}
	return true, tx.Commit()
}
