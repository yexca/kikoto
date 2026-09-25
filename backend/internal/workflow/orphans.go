package workflow

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// OrphanSweep describes one pass that settles work no executor holds.
//
// A running job is orphaned when its lease is not held by a live executor.
// The embedded runner is single-instance, so the process knows every lease it
// holds; liveness is read from that registry rather than inferred from
// heartbeat age, which a busy database can delay without the executor having
// stopped. Queued jobs are never touched: waiting is not being stuck.
type OrphanSweep struct {
	Reason string
	// LiveLeases returns the leases held by executors in this process. It is
	// called after the running jobs are read, so a claim that commits during
	// the sweep is either absent from that read or present in the snapshot,
	// provided the runner records a lease before claiming with it. Nil means
	// no lease is live, as at startup.
	LiveLeases func() map[string]bool
	// SettleIdleRuns also repairs queued or running runs that have no running
	// job and whose jobs have not changed for IdleRunGrace: a run left running
	// beside a queued job returns to the queue so the job can be claimed, and
	// a run with no queued or running job fails.
	SettleIdleRuns bool
	IdleRunGrace   time.Duration
	ViewerUserID   int64
	CanViewAll     bool
}

// OrphanSweepResult counts what one sweep changed. Active counts running jobs
// left alone because a live executor holds their lease.
type OrphanSweepResult struct {
	Requeued int64
	Failed   int64 `json:"failed"`
	Active   int64 `json:"active"`
}

// Changed reports the number of jobs and runs the sweep settled.
func (r OrphanSweepResult) Changed() int64 {
	return r.Requeued + r.Failed
}

// SettleOrphans requeues each orphaned recoverable job from its checkpoint,
// spending one resume, and fails an orphaned job that cannot resume. Every
// change is conditioned on the lease the sweep read, so a job that finished or
// was claimed again meanwhile is left as it is.
func (s *Store) SettleOrphans(ctx context.Context, sweep OrphanSweep) (OrphanSweepResult, error) {
	sweep.Reason = strings.TrimSpace(sweep.Reason)
	if sweep.Reason == "" {
		sweep.Reason = "executor no longer holds the lease"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return OrphanSweepResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	candidates, err := loadRunningLeases(ctx, tx, sweep)
	if err != nil {
		return OrphanSweepResult{}, err
	}
	live := map[string]bool{}
	if sweep.LiveLeases != nil {
		live = sweep.LiveLeases()
	}
	result := OrphanSweepResult{}
	for _, candidate := range candidates {
		if candidate.lease.LockedBy != "" && live[candidate.lease.LockedBy] {
			result.Active++
			continue
		}
		settlement := orphanSettlement(candidate.resumable, sweep.Reason)
		settled, err := settleLeaseTx(ctx, tx, candidate.lease, settlement)
		if err != nil {
			return OrphanSweepResult{}, err
		}
		switch {
		case !settled:
		case settlement.requeue:
			result.Requeued++
		default:
			result.Failed++
		}
	}
	if sweep.SettleIdleRuns {
		requeued, failed, err := settleIdleRuns(ctx, tx, sweep)
		if err != nil {
			return OrphanSweepResult{}, err
		}
		result.Requeued += requeued
		result.Failed += failed
	}
	if err := tx.Commit(); err != nil {
		return OrphanSweepResult{}, err
	}
	return result, nil
}

type runningLease struct {
	lease     JobLease
	resumable bool
}

func loadRunningLeases(ctx context.Context, tx *sql.Tx, sweep OrphanSweep) ([]runningLease, error) {
	conditions, args := appendRunVisibility([]string{"job.status = 'running'"}, nil, sweep.ViewerUserID, sweep.CanViewAll)
	rows, err := tx.QueryContext(ctx, `
		SELECT job.id, job.workflow_run_id, COALESCE(job.workflow_node_run_id, 0), job.locked_by,
			job.recoverable = 1 AND job.resume_count < job.max_retries
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE `+strings.Join(conditions, " AND ")+`
		ORDER BY job.id ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	leases := []runningLease{}
	for rows.Next() {
		var item runningLease
		if err := rows.Scan(&item.lease.JobID, &item.lease.RunID, &item.lease.NodeRunID, &item.lease.LockedBy, &item.resumable); err != nil {
			return nil, err
		}
		leases = append(leases, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return leases, rows.Close()
}

func orphanSettlement(resumable bool, reason string) leaseSettlement {
	if resumable {
		return leaseSettlement{
			requeue: true, spendResume: true, reason: reason,
			eventType: "job.orphan_requeued", message: "Job no executor was running returned to the queue from its checkpoint",
		}
	}
	return leaseSettlement{
		reason: reason, summary: map[string]any{"recovered_stale": true},
		eventType: "job.orphan_failed", message: "Job no executor was running was marked failed",
	}
}

type idleRun struct {
	id         int64
	status     string
	queuedJobs int
}

func settleIdleRuns(ctx context.Context, tx *sql.Tx, sweep OrphanSweep) (int64, int64, error) {
	cutoff := time.Now().UTC().Add(-sweep.IdleRunGrace).Format("2006-01-02 15:04:05")
	conditions, args := appendRunVisibility([]string{
		"run.status IN ('queued', 'running')",
		"NOT EXISTS (SELECT 1 FROM workflow_job AS active WHERE active.workflow_run_id = run.id AND active.status = 'running')",
		"COALESCE((SELECT MAX(changed.updated_at) FROM workflow_job AS changed WHERE changed.workflow_run_id = run.id), run.created_at) <= ?",
	}, []any{cutoff}, sweep.ViewerUserID, sweep.CanViewAll)
	rows, err := tx.QueryContext(ctx, `
		SELECT run.id, run.status,
			(SELECT COUNT(*) FROM workflow_job AS queued WHERE queued.workflow_run_id = run.id AND queued.status = 'queued')
		FROM workflow_run AS run
		WHERE `+strings.Join(conditions, " AND ")+`
		ORDER BY run.id ASC
	`, args...)
	if err != nil {
		return 0, 0, err
	}
	runs := []idleRun{}
	for rows.Next() {
		var run idleRun
		if err := rows.Scan(&run.id, &run.status, &run.queuedJobs); err != nil {
			_ = rows.Close()
			return 0, 0, err
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, 0, err
	}
	var requeued, failed int64
	for _, run := range runs {
		switch {
		case run.queuedJobs > 0 && run.status == "running":
			if err := requeueStrandedRun(ctx, tx, run, sweep.Reason); err != nil {
				return 0, 0, err
			}
			requeued++
		case run.queuedJobs == 0:
			if err := failIdleRun(ctx, tx, run, sweep.Reason); err != nil {
				return 0, 0, err
			}
			failed++
		}
	}
	return requeued, failed, nil
}

// requeueStrandedRun returns a run to the queue when its job is queued but
// the run still reads running, which would keep the job from being claimed.
func requeueStrandedRun(ctx context.Context, tx *sql.Tx, run idleRun, reason string) error {
	queries := []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = 'queued', error_message = '', finished_at = NULL WHERE workflow_run_id = ? AND status = 'running'`, []any{run.id}},
		{`UPDATE workflow_run SET status = 'queued', finished_at = NULL WHERE id = ? AND status = 'running'`, []any{run.id}},
	}
	for _, item := range queries {
		if _, err := tx.ExecContext(ctx, item.query, item.args...); err != nil {
			return err
		}
	}
	return InsertEvent(ctx, tx, run.id, EventSpec{
		Level: "warn", Type: "run.requeued_stranded", Message: "Run returned to the queue so its queued job can be claimed",
		Detail: map[string]any{"previous_status": run.status, "reason": reason},
	})
}

func failIdleRun(ctx context.Context, tx *sql.Tx, run idleRun, reason string) error {
	summary, err := marshal(map[string]any{"error": reason, "recovered_stale": true})
	if err != nil {
		return err
	}
	queries := []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = 'failed', error_message = CASE WHEN error_message <> '' THEN error_message ELSE ? END, finished_at = CURRENT_TIMESTAMP WHERE workflow_run_id = ? AND status IN ('queued', 'running')`, []any{reason, run.id}},
		{`UPDATE workflow_run SET status = 'failed', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')`, []any{summary, run.id}},
	}
	for _, item := range queries {
		if _, err := tx.ExecContext(ctx, item.query, item.args...); err != nil {
			return err
		}
	}
	return InsertEvent(ctx, tx, run.id, EventSpec{
		Level: "warn", Type: "run.recovered_stale", Message: "Run with no remaining job was marked failed",
		Detail: map[string]any{"previous_status": run.status, "reason": reason},
	})
}

// leaseSettlement describes how settleLeaseTx releases a running job.
type leaseSettlement struct {
	requeue     bool
	spendResume bool
	reason      string
	summary     map[string]any
	eventType   string
	message     string
}

// settleLeaseTx releases a job still running under lease, either back to the
// queue from its checkpoint or as failed along with its run. It reports false
// without changing anything when the lease no longer owns a running job.
func settleLeaseTx(ctx context.Context, tx *sql.Tx, lease JobLease, settlement leaseSettlement) (bool, error) {
	var result sql.Result
	var err error
	if settlement.requeue {
		spent := 0
		if settlement.spendResume {
			spent = 1
		}
		result, err = tx.ExecContext(ctx, `
			UPDATE workflow_job
			SET status = 'queued', locked_by = '', locked_at = NULL, heartbeat_at = NULL, resume_count = resume_count + ?,
				available_at = CURRENT_TIMESTAMP, error_message = '', updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running' AND locked_by = ?
		`, spent, lease.JobID, lease.LockedBy)
	} else {
		result, err = tx.ExecContext(ctx, `
			UPDATE workflow_job
			SET status = 'failed', error_message = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL,
				updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running' AND locked_by = ?
		`, settlement.reason, lease.JobID, lease.LockedBy)
	}
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return false, err
	}
	if settlement.requeue {
		err = requeueLeaseRun(ctx, tx, lease)
	} else {
		err = failLeaseRun(ctx, tx, lease, settlement)
	}
	if err != nil {
		return false, err
	}
	return true, InsertEvent(ctx, tx, lease.RunID, EventSpec{
		NodeRunID: lease.NodeRunID, JobID: lease.JobID, Level: "warn", Type: settlement.eventType, Message: settlement.message,
		Detail: map[string]any{"reason": settlement.reason, "previous_lock": lease.LockedBy},
	})
}

func requeueLeaseRun(ctx context.Context, tx *sql.Tx, lease JobLease) error {
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = 'queued', error_message = '', finished_at = NULL WHERE workflow_run_id = ? AND status = 'running'`, lease.RunID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = 'queued', finished_at = NULL WHERE id = ? AND status IN ('queued', 'running')`, lease.RunID)
	return err
}

func failLeaseRun(ctx context.Context, tx *sql.Tx, lease JobLease, settlement leaseSettlement) error {
	summary := map[string]any{"error": settlement.reason}
	for key, value := range settlement.summary {
		summary[key] = value
	}
	summaryJSON, err := marshal(summary)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'failed', error_message = CASE WHEN error_message <> '' THEN error_message ELSE ? END, finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ? AND status IN ('queued', 'running')
	`, settlement.reason, lease.RunID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE workflow_run SET status = 'failed', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')`, summaryJSON, lease.RunID)
	return err
}
