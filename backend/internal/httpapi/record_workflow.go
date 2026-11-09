package httpapi

import (
	"context"
	"database/sql"
	"errors"

	"github.com/yexca/kikoto/backend/internal/record"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	recordScanWorkflowCode = "record_library_scan"
	recordScanWorkerType   = "record_library_scan"
	recordScanDisplayName  = "Scan record library"
)

type recordScanPayload struct {
	RequestedByUserID int64 `json:"requested_by_user_id"`
}

type recordScanQueuedResult struct {
	RunID    int64  `json:"runId"`
	JobID    int64  `json:"jobId"`
	Status   string `json:"status"`
	Existing bool   `json:"existing"`
}

func (s *Server) enqueueRecordScan(ctx context.Context, actorUserID int64) (recordScanQueuedResult, error) {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return recordScanQueuedResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	result := recordScanQueuedResult{Existing: true}
	err = tx.QueryRowContext(ctx, `
		SELECT run.id, run.status, COALESCE((
			SELECT job.id FROM workflow_job AS job
			WHERE job.workflow_run_id = run.id ORDER BY job.id DESC LIMIT 1
		), 0)
		FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
		ORDER BY run.id DESC LIMIT 1
	`, recordScanWorkflowCode).Scan(&result.RunID, &result.Status, &result.JobID)
	if err == nil {
		return result, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return recordScanQueuedResult{}, err
	}

	definitionID, err := workflow.EnsureDefinition(ctx, tx, recordScanWorkflowCode, recordScanDisplayName,
		"Index the independent local video and image library without changing audio works.",
		map[string]any{"nodes": []map[string]string{{"id": "scan", "type": recordScanWorkerType, "displayName": recordScanDisplayName}}})
	if err != nil {
		return recordScanQueuedResult{}, err
	}
	payload := recordScanPayload{RequestedByUserID: actorUserID}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, recordScanWorkflowCode, recordScanDisplayName,
		"queued", "manual", "record_library_scan", payload, map[string]any{})
	if err != nil {
		return recordScanQueuedResult{}, err
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "scan", NodeType: recordScanWorkerType, DisplayName: recordScanDisplayName,
		Position: 1, Status: "queued",
	})
	if err != nil {
		return recordScanQueuedResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: nodeID, WorkerType: recordScanWorkerType, Status: "queued",
		Priority: workflow.JobPriorityUserInitiated, ResourceKey: "record:scan", Payload: payload,
		Checkpoint: map[string]any{}, Recoverable: false, MaxRetries: 2, ProgressTotal: 1,
	})
	if err != nil {
		return recordScanQueuedResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE record_root SET last_scan_run_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=1`, runID); err != nil {
		return recordScanQueuedResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return recordScanQueuedResult{}, err
	}
	return recordScanQueuedResult{RunID: runID, JobID: jobID, Status: "queued"}, nil
}

func (s *Server) executeRecordScanJob(ctx context.Context, job workflowJobRecord) error {
	var payload recordScanPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, err := s.recordStore.Scan(ctx)
	if err != nil {
		if shutdownInterrupted(ctx) {
			return err
		}
		_ = s.failClaimedWorkflowJob(context.WithoutCancel(ctx), job, "record library scan failed")
		return err
	}
	return s.finishRecordScanJob(context.WithoutCancel(ctx), job, payload, result)
}

func (s *Server) finishRecordScanJob(ctx context.Context, job workflowJobRecord, _ recordScanPayload, result record.ScanResult) error {
	output := mustJSON(result)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, step := range []struct {
		query string
		args  []any
	}{
		{"UPDATE workflow_node_run SET status='succeeded', output_json=?, finished_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','running')", []any{output, job.NodeRunID}},
		{"UPDATE workflow_job SET status='succeeded', progress_current=progress_total, locked_by='', locked_at=NULL, heartbeat_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", []any{job.ID}},
		{"UPDATE workflow_run SET status='succeeded', summary_json=?, finished_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','running')", []any{output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}
