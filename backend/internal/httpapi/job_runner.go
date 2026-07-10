package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

type workflowJobRecord struct {
	ID             int64
	RunID          int64
	NodeRunID      int64
	WorkerType     string
	PayloadJSON    string
	CheckpointJSON string
	LockedBy       string
	ResumeCount    int
}

func (s *Server) StartJobRunner(ctx context.Context) {
	s.jobRunnerMu.Lock()
	defer s.jobRunnerMu.Unlock()

	runnerID := workflowJobRunnerID()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if _, err := workflow.NewStore(s.db).RequeueExpiredJobs(ctx, 30*time.Second); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("requeue expired workflow jobs", "error", err)
		}
		if err := s.runNextQueuedWorkflowJob(ctx, runnerID); err != nil && !errors.Is(err, context.Canceled) {
			slog.Error("run queued workflow job", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) runNextQueuedWorkflowJob(ctx context.Context, runnerID string) error {
	job, ok, err := s.claimNextQueuedWorkflowJob(ctx, runnerID)
	if err != nil || !ok {
		return err
	}
	jobCtx, stopHeartbeat := s.startWorkflowJobHeartbeat(ctx, job)
	defer stopHeartbeat()
	switch job.WorkerType {
	case "remote_work_fetch":
		return s.executeRemoteWorkFetchJob(jobCtx, job)
	case "remote_media_cache":
		return s.executeRemoteMediaCacheJob(jobCtx, job)
	case "remote_popular_collection":
		return s.executeRemotePopularCollectionJob(jobCtx, job)
	case "media_cache_limit_cleanup":
		return s.executeMediaCacheLimitCleanupJob(jobCtx, job)
	case "media_cache_cleanup":
		return s.executeMediaCacheCleanupJob(jobCtx, job)
	case "local_media_delete":
		return s.executeLocalMediaDeleteJob(jobCtx, job)
	case "local_location_cleanup":
		return s.executeLocalLocationCleanupJob(jobCtx, job)
	default:
		message := "unsupported workflow job type: " + job.WorkerType
		if err := s.failClaimedWorkflowJob(jobCtx, job, message); err != nil {
			return err
		}
		return errors.New(message)
	}
}

func (s *Server) leaseInlineWorkflowJob(ctx context.Context, job workflowJobRecord) (context.Context, context.CancelFunc, error) {
	runnerID := workflowJobRunnerID()
	result, err := s.db.ExecContext(ctx, `
		UPDATE workflow_job
		SET locked_by = ?, locked_at = CURRENT_TIMESTAMP, heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status = 'running'
	`, runnerID, job.ID)
	if err != nil {
		return ctx, func() {}, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return ctx, func() {}, err
	}
	if rows == 0 {
		return ctx, func() {}, errors.New("workflow job is no longer running")
	}
	job.LockedBy = runnerID
	jobCtx, stop := s.startWorkflowJobHeartbeat(ctx, job)
	return jobCtx, stop, nil
}

func (s *Server) claimNextQueuedWorkflowJob(ctx context.Context, runnerID string) (workflowJobRecord, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workflowJobRecord{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	var job workflowJobRecord
	err = tx.QueryRowContext(ctx, `
		SELECT job.id, job.workflow_run_id, COALESCE(job.workflow_node_run_id, 0), job.worker_type, job.payload_json,
			job.checkpoint_json, job.resume_count
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.status = 'queued'
			AND run.status = 'queued'
			AND (job.available_at IS NULL OR job.available_at <= CURRENT_TIMESTAMP)
		ORDER BY job.created_at ASC, job.id ASC
		LIMIT 1
	`).Scan(&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON, &job.CheckpointJSON, &job.ResumeCount)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowJobRecord{}, false, nil
		}
		return workflowJobRecord{}, false, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'running',
			locked_by = ?,
			locked_at = CURRENT_TIMESTAMP,
			heartbeat_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND status = 'queued'
	`, runnerID, job.ID)
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
	job.LockedBy = runnerID
	return job, true, nil
}

func (s *Server) updateWorkflowJobCheckpoint(ctx context.Context, jobID int64, phase string, detail any, current int, total int) error {
	checkpoint := mustJSON(map[string]any{
		"phase": strings.TrimSpace(phase), "detail": detail, "progressCurrent": current, "progressTotal": total,
		"updatedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_job
		SET checkpoint_json = ?, progress_current = ?, progress_total = ?,
			heartbeat_at = CASE WHEN status = 'running' THEN CURRENT_TIMESTAMP ELSE heartbeat_at END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, checkpoint, current, total, jobID)
	return err
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
			locked_by = '',
			locked_at = NULL,
			heartbeat_at = NULL,
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

func (s *Server) startWorkflowJobHeartbeat(ctx context.Context, job workflowJobRecord) (context.Context, context.CancelFunc) {
	jobCtx, cancel := context.WithCancel(ctx)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-jobCtx.Done():
				return
			case <-ticker.C:
				_, _ = s.db.ExecContext(context.Background(), `
					UPDATE workflow_job
					SET heartbeat_at = CURRENT_TIMESTAMP,
						updated_at = CURRENT_TIMESTAMP
					WHERE id = ?
						AND status = 'running'
						AND locked_by = ?
				`, job.ID, job.LockedBy)
			}
		}
	}()
	return jobCtx, cancel
}

func workflowJobRunnerID() string {
	hostname, _ := os.Hostname()
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		hostname = "unknown-host"
	}
	return hostname + ":" + time.Now().UTC().Format("20060102T150405.000000000")
}

func decodeWorkflowJobPayload[T any](raw string, out *T) error {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	return json.Unmarshal([]byte(raw), out)
}

func decodeWorkflowJobCheckpointDetail[T any](raw string, out *T) error {
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	var envelope struct {
		Detail json.RawMessage `json:"detail"`
	}
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		return err
	}
	if len(envelope.Detail) > 0 && string(envelope.Detail) != "null" {
		return json.Unmarshal(envelope.Detail, out)
	}
	return json.Unmarshal([]byte(raw), out)
}
