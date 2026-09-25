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
	if recoverable {
		err = requeueInterruptedJob(ctx, tx, lease, reason)
	} else {
		err = failInterruptedJob(ctx, tx, lease, reason)
	}
	if err != nil {
		return false, err
	}
	return true, tx.Commit()
}

func requeueInterruptedJob(ctx context.Context, tx *sql.Tx, lease JobLease, reason string) error {
	queries := []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_job SET status = 'queued', locked_by = '', locked_at = NULL, heartbeat_at = NULL, available_at = CURRENT_TIMESTAMP, error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, []any{lease.JobID}},
		{`UPDATE workflow_node_run SET status = 'queued', error_message = '', finished_at = NULL WHERE workflow_run_id = ? AND status = 'running'`, []any{lease.RunID}},
		{`UPDATE workflow_run SET status = 'queued', finished_at = NULL WHERE id = ? AND status = 'running'`, []any{lease.RunID}},
	}
	for _, item := range queries {
		if _, err := tx.ExecContext(ctx, item.query, item.args...); err != nil {
			return err
		}
	}
	return InsertEvent(ctx, tx, lease.RunID, EventSpec{
		NodeRunID: lease.NodeRunID, JobID: lease.JobID, Level: "warn", Type: "job.interrupted_by_stop",
		Message: "Job returned to the queue when the service stopped", Detail: map[string]any{"reason": reason},
	})
}

func failInterruptedJob(ctx context.Context, tx *sql.Tx, lease JobLease, reason string) error {
	summary, err := marshal(map[string]any{"error": reason, "interrupted_by_stop": true})
	if err != nil {
		return err
	}
	queries := []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_job SET status = 'failed', error_message = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, []any{reason, lease.JobID}},
		{`UPDATE workflow_node_run SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE workflow_run_id = ? AND status = 'running'`, []any{reason, lease.RunID}},
		{`UPDATE workflow_run SET status = 'failed', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`, []any{summary, lease.RunID}},
	}
	for _, item := range queries {
		if _, err := tx.ExecContext(ctx, item.query, item.args...); err != nil {
			return err
		}
	}
	return InsertEvent(ctx, tx, lease.RunID, EventSpec{
		NodeRunID: lease.NodeRunID, JobID: lease.JobID, Level: "warn", Type: "job.interrupted_by_stop",
		Message: "Job stopped with the service and cannot resume from a checkpoint", Detail: map[string]any{"reason": reason},
	})
}
