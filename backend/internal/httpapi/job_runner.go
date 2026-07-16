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

	"github.com/yexca/kikoto/backend/internal/dlsite"
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
	RetryCount     int
	MaxRetries     int
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
	var runErr error
	switch job.WorkerType {
	case "remote_work_fetch":
		runErr = s.executeRemoteWorkFetchJob(jobCtx, job)
	case "remote_media_cache":
		runErr = s.executeRemoteMediaCacheJob(jobCtx, job)
	case "remote_popular_collection":
		runErr = s.executeRemotePopularCollectionJob(jobCtx, job)
	case "dlsite_popular_collection":
		runErr = s.executeDLsitePopularCollectionJob(jobCtx, job)
	case "metadata_family_sync":
		runErr = s.executeWorkMetadataSyncJob(jobCtx, job)
	case "media_cache_limit_cleanup":
		runErr = s.executeMediaCacheLimitCleanupJob(jobCtx, job)
	case "media_cache_cleanup":
		runErr = s.executeMediaCacheCleanupJob(jobCtx, job)
	case "local_media_delete":
		runErr = s.executeLocalMediaDeleteJob(jobCtx, job)
	case "local_location_cleanup":
		runErr = s.executeLocalLocationCleanupJob(jobCtx, job)
	case "media_location_cleanup":
		runErr = s.executeMediaLocationCleanupJob(jobCtx, job)
	case "cache_orphan_cleanup":
		runErr = s.executeCacheOrphanCleanupJob(jobCtx, job)
	case "custom_workflow":
		runErr = s.executeCustomWorkflowJob(jobCtx, job)
	default:
		message := "unsupported workflow job type: " + job.WorkerType
		if err := s.failClaimedWorkflowJob(jobCtx, job, message); err != nil {
			return err
		}
		return errors.New(message)
	}
	if runErr != nil && isRetryableWorkflowError(runErr) && job.RetryCount < job.MaxRetries {
		delay := time.Duration(job.RetryCount+1) * 30 * time.Second
		if err := s.requeueFailedWorkflowJob(jobCtx, job, delay, "Automatic retry after a transient source failure"); err != nil {
			return err
		}
		return nil
	}
	return runErr
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
	var candidateID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT job.id
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.status = 'queued'
			AND run.status = 'queued'
			AND (job.available_at IS NULL OR job.available_at <= CURRENT_TIMESTAMP)
		ORDER BY job.created_at ASC, job.id ASC
		LIMIT 1
	`).Scan(&candidateID)
	if errors.Is(err, sql.ErrNoRows) {
		return workflowJobRecord{}, false, nil
	}
	if err != nil {
		return workflowJobRecord{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workflowJobRecord{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	var job workflowJobRecord
	err = tx.QueryRowContext(ctx, `
		SELECT job.id, job.workflow_run_id, COALESCE(job.workflow_node_run_id, 0), job.worker_type, job.payload_json,
			job.checkpoint_json, job.resume_count, job.retry_count, job.max_retries
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.status = 'queued'
			AND run.status = 'queued'
			AND job.id = ?
			AND (job.available_at IS NULL OR job.available_at <= CURRENT_TIMESTAMP)
		`, candidateID).Scan(&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON, &job.CheckpointJSON, &job.ResumeCount, &job.RetryCount, &job.MaxRetries)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowJobRecord{}, false, tx.Commit()
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

func isRetryableWorkflowError(runErr error) bool {
	var downloadErr remoteDownloadError
	return (errors.As(runErr, &downloadErr) && downloadErr.Retryable) || dlsite.IsRetryableHTTPError(runErr)
}

func (s *Server) requeueFailedWorkflowJob(ctx context.Context, job workflowJobRecord, delay time.Duration, reason string) error {
	availableAt := time.Now().UTC().Add(delay).Format("2006-01-02 15:04:05")
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'queued', retry_count = retry_count + 1, available_at = ?, error_message = '',
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status = 'failed'
	`, availableAt, job.ID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return err
	}
	nodeStatuses := []string{"failed", "running", "queued"}
	if job.WorkerType == "custom_workflow" {
		nodeStatuses = append(nodeStatuses, "skipped")
	}
	statusPlaceholders := strings.TrimRight(strings.Repeat("?,", len(nodeStatuses)), ",")
	nodeArgs := []any{job.RunID}
	for _, status := range nodeStatuses {
		nodeArgs = append(nodeArgs, status)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'queued', error_message = '', finished_at = NULL
		WHERE workflow_run_id = ? AND status IN (`+statusPlaceholders+`)
	`, nodeArgs...); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run SET status = 'queued', finished_at = NULL,
			summary_json = json_set(COALESCE(NULLIF(summary_json, ''), '{}'), '$.retry_reason', ?, '$.retry_at', ?)
		WHERE id = ?
	`, reason, availableAt, job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: "warn", Type: "job.retry_scheduled",
		Message: reason, Detail: map[string]any{"available_at": availableAt, "retry_count": job.RetryCount + 1},
	}); err != nil {
		return err
	}
	return tx.Commit()
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
