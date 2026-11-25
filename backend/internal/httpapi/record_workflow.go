package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"time"

	"github.com/yexca/kikoto/backend/internal/record"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	recordScanWorkflowCode = "record_library_scan"
	recordScanWorkerType   = "record_library_scan"
	recordScanDisplayName  = "Scan record library"
	recordScanDescription  = "Find the folders and files of the independent record library without changing audio works."
)

// recordScanWorkflowSpec is registered at startup with the other system
// workflows, so Workflows can filter by it before the first Record scan.
func recordScanWorkflowSpec() systemWorkflowSpec {
	return systemWorkflowSpec{
		Code:        recordScanWorkflowCode,
		Name:        recordScanDisplayName,
		Description: recordScanDescription,
		Nodes:       []map[string]string{{"id": "scan", "type": recordScanWorkerType, "displayName": recordScanDisplayName}},
	}
}

type recordScanPayload struct {
	RequestedByUserID int64 `json:"requested_by_user_id"`
}

type recordScanQueuedResult struct {
	RunID    int64  `json:"runId"`
	JobID    int64  `json:"jobId"`
	Status   string `json:"status"`
	Existing bool   `json:"existing"`
}

func (s *Server) enqueueRecordScan(ctx context.Context, actorUserID int64, trigger workflowRunTrigger) (recordScanQueuedResult, error) {
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

	spec := recordScanWorkflowSpec()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.Name, spec.Description, map[string]any{"nodes": spec.Nodes})
	if err != nil {
		return recordScanQueuedResult{}, err
	}
	payload := recordScanPayload{RequestedByUserID: actorUserID}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, recordScanWorkflowCode, recordScanDisplayName,
		"queued", trigger.Type, trigger.Reason, payload, map[string]any{})
	if err != nil {
		return recordScanQueuedResult{}, err
	}
	if trigger.ID > 0 {
		if err := workflow.SetRunTrigger(ctx, tx, runID, trigger.ID); err != nil {
			return recordScanQueuedResult{}, err
		}
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
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "record:scan", Payload: payload,
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

// recordScanProgressEvery spaces the walk's progress writes.
const recordScanProgressEvery = time.Second

func (s *Server) executeRecordScanJob(ctx context.Context, job workflowJobRecord) error {
	var payload recordScanPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		s.failJobOrLog(ctx, job, err.Error())
		return err
	}
	var lastProgress time.Time
	result, err := s.runRecordScan(ctx, func(folders, assets int) {
		if time.Since(lastProgress) < recordScanProgressEvery {
			return
		}
		lastProgress = time.Now()
		// The walk does not know how many files it will find, so the total
		// stays unknown while it runs.
		s.checkpointJobOrLog(ctx, job, "walking", map[string]any{"folders": folders, "assets": assets}, assets, 0)
	})
	if err != nil {
		if shutdownInterrupted(ctx) {
			return err
		}
		s.failJobOrLog(context.WithoutCancel(ctx), job, "record library scan failed")
		return err
	}
	return s.finishRecordScanJob(context.WithoutCancel(ctx), job, payload, result)
}

// runRecordScan scans the record root and, when the walk was complete, removes
// the cached thumbnails of assets it no longer finds as videos, images, or
// audio files with cover art. A
// partial walk leaves thumbnails alone, as it leaves the rows it could not see.
func (s *Server) runRecordScan(ctx context.Context, progress record.ScanProgress) (record.ScanResult, error) {
	result, err := s.recordStore.ScanReporting(ctx, progress)
	if err != nil || !result.MissingMarked {
		return result, err
	}
	removed, err := s.pruneRecordThumbnails(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return record.ScanResult{}, ctx.Err()
		}
		slog.Warn("record thumbnail cleanup failed", "error", err)
	}
	result.ThumbnailsRemoved = removed
	return result, nil
}

// finishRecordScanJob records the scan as finished, on its triggers too. The
// files it left pending are read when their folder opens, by a media details
// run started by hand or on an interval, or by the media details After
// trigger when the scan found files new or changed.
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
		{"UPDATE workflow_job SET status='succeeded', progress_current=?, progress_total=?, locked_by='', locked_at=NULL, heartbeat_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", []any{result.Assets, result.Assets, job.ID}},
		{"UPDATE workflow_run SET status='succeeded', summary_json=?, finished_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('queued','running')", []any{output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, "succeeded", nil); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.dispatchRecordScanAfterTriggers(ctx, job.RunID, result.NewPendingProbes)
	return nil
}

// executeRecordScanSystemTrigger queues a Record scan for a startup or
// interval trigger. While Record is off, or its library is not mounted, the
// trigger queues nothing and says why.
func (s *Server) executeRecordScanSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	reason := ""
	if !s.recordLibraryEnabled(ctx) {
		reason = "Record is turned off"
	} else if root, err := s.recordStore.EnsureRoot(ctx); err != nil {
		return "", nil, err
	} else if root.State != "online" && root.State != record.RootStateMarkerMissing {
		reason = "The record library is not mounted"
	}
	if reason != "" {
		s.execBestEffort(ctx, "record skipped record scan trigger",
			"UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", reason, trigger.ID)
		return "", nil, nil
	}
	result, err := s.enqueueRecordScan(ctx, 0, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return result.Status, nil, err
}
