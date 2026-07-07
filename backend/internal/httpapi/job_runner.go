package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"
)

type workflowJobRecord struct {
	ID          int64
	RunID       int64
	NodeRunID   int64
	WorkerType  string
	PayloadJSON string
}

func (s *Server) StartJobRunner(ctx context.Context) {
	s.jobRunnerMu.Lock()
	defer s.jobRunnerMu.Unlock()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.runNextQueuedWorkflowJob(ctx); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("run queued workflow job", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) runNextQueuedWorkflowJob(ctx context.Context) error {
	job, ok, err := s.claimNextQueuedWorkflowJob(ctx)
	if err != nil || !ok {
		return err
	}
	switch job.WorkerType {
	case "remote_work_fetch":
		return s.executeRemoteWorkFetchJob(ctx, job)
	default:
		message := "unsupported workflow job type: " + job.WorkerType
		if err := s.failClaimedWorkflowJob(ctx, job, message); err != nil {
			return err
		}
		return errors.New(message)
	}
}

func (s *Server) claimNextQueuedWorkflowJob(ctx context.Context) (workflowJobRecord, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workflowJobRecord{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	var job workflowJobRecord
	err = tx.QueryRowContext(ctx, `
		SELECT job.id, job.workflow_run_id, COALESCE(job.workflow_node_run_id, 0), job.worker_type, job.payload_json
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.status = 'queued'
			AND run.status = 'queued'
		ORDER BY job.created_at ASC, job.id ASC
		LIMIT 1
	`).Scan(&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowJobRecord{}, false, nil
		}
		return workflowJobRecord{}, false, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'running',
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND status = 'queued'
	`, job.ID)
	if err != nil {
		return workflowJobRecord{}, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return workflowJobRecord{}, false, err
	}
	if rows == 0 {
		return workflowJobRecord{}, false, tx.Commit()
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'running',
			started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ?
			AND status = 'queued'
	`, job.RunID); err != nil {
		return workflowJobRecord{}, false, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'running',
			started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ?
			AND status = 'queued'
	`, job.NodeRunID); err != nil {
		return workflowJobRecord{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return workflowJobRecord{}, false, err
	}
	return job, true, nil
}

func (s *Server) failClaimedWorkflowJob(ctx context.Context, job workflowJobRecord, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "workflow job failed"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'failed',
			error_message = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, message, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'failed',
			error_message = CASE WHEN error_message <> '' THEN error_message ELSE ? END,
			finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
			AND status IN ('queued', 'running')
	`, message, job.RunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'failed',
			summary_json = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(map[string]any{"error": message}), job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func decodeWorkflowJobPayload[T any](raw string, out *T) error {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	return json.Unmarshal([]byte(raw), out)
}
