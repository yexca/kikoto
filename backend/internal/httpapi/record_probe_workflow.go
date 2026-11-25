package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/record"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// The record media probe reads what a folder listing shows of the files a
// record scan found new or changed, for the whole library at once: the length
// of videos and audio files, and whether an audio file carries cover art. A
// folder's files are read when it opens; this run is for the files nobody
// opened yet, started by hand or by a startup or interval trigger. It gives
// the executor to other queued work between files, so a large library does
// not hold the queue.
const (
	recordProbeWorkflowCode      = "record_media_probe"
	recordProbeWorkerType        = "record_media_probe"
	recordProbeDisplayName       = "Read record media details"
	recordProbeDescription       = "Read the length of record videos and audio files, and whether audio files carry cover art."
	recordProbeSelectNodeID      = "select"
	recordProbeProbeNodeID       = "probe"
	recordProbeSelectNodeType    = "select_record_media"
	recordProbeProbeNodeType     = "probe_record_media"
	recordProbeSelectDisplayName = "Select pending files"
	recordProbeProbeDisplayName  = "Read media details"

	recordProbeProgressEvery = time.Second
	recordProbeYieldDelay    = 5 * time.Second
)

var recordProbeNodes = []map[string]string{
	{"id": recordProbeSelectNodeID, "type": recordProbeSelectNodeType, "displayName": recordProbeSelectDisplayName},
	{"id": recordProbeProbeNodeID, "type": recordProbeProbeNodeType, "displayName": recordProbeProbeDisplayName},
}

func recordProbeWorkflowSpec() systemWorkflowSpec {
	return systemWorkflowSpec{
		Code:        recordProbeWorkflowCode,
		Name:        recordProbeDisplayName,
		Description: recordProbeDescription,
		Nodes:       recordProbeNodes,
	}
}

// errRecordProbeYield stops a probe pass between files so queued work runs.
var errRecordProbeYield = errors.New("record media probe yields to other queued work")

type recordProbeQueuedResult struct {
	RunID    int64  `json:"runId"`
	JobID    int64  `json:"jobId"`
	Status   string `json:"status"`
	Existing bool   `json:"existing"`
}

// recordProbeCheckpoint carries a pass across the times it yields and resumes:
// its counts so far, and the files it timed out on, which it does not try
// again.
type recordProbeCheckpoint struct {
	Probed      int     `json:"probed"`
	Failed      int     `json:"failed"`
	TimedOut    int     `json:"timedOut"`
	TimedOutIDs []int64 `json:"timedOutIds,omitempty"`
}

func (c recordProbeCheckpoint) done() int { return c.Probed + c.Failed + c.TimedOut }

// adding returns the checkpoint with a resumed pass's own results added.
func (c recordProbeCheckpoint) adding(result record.ProbeResult) recordProbeCheckpoint {
	return recordProbeCheckpoint{
		Probed: c.Probed + result.Probed, Failed: c.Failed + result.Failed, TimedOut: c.TimedOut + result.TimedOut,
		TimedOutIDs: result.TimedOutIDs,
	}
}

// enqueueRecordProbe queues one probe run, or returns the run already queued
// or running: that run reads every file pending when it reaches it, including
// the files a later scan found.
func (s *Server) enqueueRecordProbe(ctx context.Context, trigger workflowRunTrigger) (recordProbeQueuedResult, error) {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return recordProbeQueuedResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	existing := recordProbeQueuedResult{Existing: true}
	err = tx.QueryRowContext(ctx, `
		SELECT run.id, run.status, COALESCE((
			SELECT job.id FROM workflow_job AS job WHERE job.workflow_run_id = run.id ORDER BY job.id DESC LIMIT 1
		), 0)
		FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
		ORDER BY run.id DESC LIMIT 1
	`, recordProbeWorkflowCode).Scan(&existing.RunID, &existing.Status, &existing.JobID)
	if err == nil {
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return recordProbeQueuedResult{}, err
	}
	spec := recordProbeWorkflowSpec()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.Name, spec.Description, map[string]any{"nodes": spec.Nodes})
	if err != nil {
		return recordProbeQueuedResult{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, recordProbeWorkflowCode, recordProbeDisplayName,
		"queued", trigger.Type, trigger.Reason, map[string]any{}, map[string]any{})
	if err != nil {
		return recordProbeQueuedResult{}, err
	}
	if trigger.ID > 0 {
		if err := workflow.SetRunTrigger(ctx, tx, runID, trigger.ID); err != nil {
			return recordProbeQueuedResult{}, err
		}
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: recordProbeSelectNodeID, NodeType: recordProbeSelectNodeType, DisplayName: recordProbeSelectDisplayName,
		Position: 1, Status: "queued",
	})
	if err != nil {
		return recordProbeQueuedResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: recordProbeProbeNodeID, NodeType: recordProbeProbeNodeType, DisplayName: recordProbeProbeDisplayName,
		Position: 2, Status: "queued",
	}); err != nil {
		return recordProbeQueuedResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: recordProbeWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "record:probe", Payload: map[string]any{},
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 2,
	})
	if err != nil {
		return recordProbeQueuedResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return recordProbeQueuedResult{}, err
	}
	return recordProbeQueuedResult{RunID: runID, JobID: jobID, Status: "queued"}, nil
}

func (s *Server) executeRecordProbeJob(ctx context.Context, job workflowJobRecord) error {
	var checkpoint recordProbeCheckpoint
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		s.failJobOrLog(ctx, job, err.Error())
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		s.failJobOrLog(ctx, job, err.Error())
		return err
	}
	remaining, err := s.recordStore.PendingProbes(ctx, checkpoint.TimedOutIDs)
	if err != nil {
		s.failJobOrLog(ctx, job, err.Error())
		return err
	}
	if err := s.startRecordProbeNode(ctx, job, nodeIDs, checkpoint, remaining); err != nil {
		s.failJobOrLog(ctx, job, err.Error())
		return err
	}

	current := checkpoint
	lastProgress := time.Now()
	result, err := s.recordStore.ProbePending(ctx, record.ProbeOptions{
		Skip: checkpoint.TimedOutIDs,
		Between: func(pass record.ProbeResult) error {
			current = checkpoint.adding(pass)
			if s.asrShouldYield(ctx, job.ID) {
				return errRecordProbeYield
			}
			if time.Since(lastProgress) >= recordProbeProgressEvery {
				lastProgress = time.Now()
				if left, err := s.recordStore.PendingProbes(ctx, current.TimedOutIDs); err == nil {
					remaining = left
				}
				s.checkpointJobOrLog(ctx, job, "probing", current, current.done(), current.done()+remaining)
			}
			return nil
		},
	})
	current = checkpoint.adding(result)
	settleCtx := context.WithoutCancel(ctx)
	switch {
	case errors.Is(err, errRecordProbeYield):
		left, _ := s.recordStore.PendingProbes(ctx, current.TimedOutIDs)
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "yielded", current, current.done(), current.done()+left); err != nil {
			return err
		}
		return s.deferWorkflowJob(ctx, job, recordProbeYieldDelay, "Record media details yield to other queued work")
	case err != nil && ctx.Err() != nil:
		// A stop or cancel keeps what the pass finished, so a resumed job
		// continues from it. The files left are counted as the running pass
		// counts them, without those it timed out on.
		left, countErr := s.recordStore.PendingProbes(settleCtx, current.TimedOutIDs)
		if countErr != nil {
			left = result.Remaining
		}
		s.checkpointJobOrLog(settleCtx, job, "stopped", current, current.done(), current.done()+left)
		return err
	case errors.Is(err, record.ErrRootOffline):
		s.failJobOrLog(settleCtx, job, "the record library is not mounted")
		return err
	case err != nil:
		s.failJobOrLog(settleCtx, job, "record media probe failed")
		return err
	}
	return s.finishRecordProbeJob(settleCtx, job, nodeIDs[recordProbeProbeNodeID], current, result)
}

// startRecordProbeNode records the selection, starts the probe node, and sets
// the job's progress to the files done and the files left.
func (s *Server) startRecordProbeNode(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, checkpoint recordProbeCheckpoint, remaining int) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{mustJSON(map[string]any{"pending_files": remaining}), nodeIDs[recordProbeSelectNodeID]}},
		{`UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
			WHERE id = ? AND status = 'queued'`, []any{nodeIDs[recordProbeProbeNodeID]}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.updateWorkflowJobCheckpoint(ctx, job.ID, "probing", checkpoint, checkpoint.done(), checkpoint.done()+remaining)
}

func (s *Server) finishRecordProbeJob(ctx context.Context, job workflowJobRecord, probeNodeID int64, checkpoint recordProbeCheckpoint, result record.ProbeResult) error {
	status, message := "succeeded", ""
	if result.Unavailable {
		// Without ffprobe every file stays pending; the run says why.
		status, message = "failed", "ffprobe is unavailable"
	}
	summary := map[string]any{
		"probed": checkpoint.Probed, "failed": checkpoint.Failed, "timed_out": checkpoint.TimedOut,
		"remaining": result.Remaining, "unavailable": result.Unavailable,
	}
	output := mustJSON(summary)
	done := checkpoint.done()
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Guards keep a run that was cancelled while probing cancelled.
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, message, probeNodeID}},
		{`UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running'`, []any{status, done, done, message,
			mustJSON(map[string]any{"phase": "completed", "detail": checkpoint, "progressCurrent": done, "progressTotal": done}), job.ID}},
		{`UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: probeNodeID, JobID: job.ID, Level: eventLevelForWorkflowStatus(status),
		Type: "record_media_probe.completed", Message: "Record media details " + status, Detail: summary,
	}); err != nil {
		return err
	}
	var failures []string
	if message != "" {
		failures = []string{message}
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, status, failures); err != nil {
		return err
	}
	return tx.Commit()
}

// normalizeRecordTriggerConfig accepts the empty configuration, the only one
// a Record scan or media details trigger has.
func normalizeRecordTriggerConfig(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if err := decodeStrictJSON(raw, &struct{}{}); err != nil {
		return fmt.Errorf("record trigger config is invalid")
	}
	return nil
}

// executeRecordProbeSystemTrigger queues the whole-library media details run
// for an After or interval trigger. While Record is off the trigger queues
// nothing and says why.
func (s *Server) executeRecordProbeSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	if !s.recordLibraryEnabled(ctx) {
		s.execBestEffort(ctx, "record skipped record media details trigger",
			"UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
			"Record is turned off", trigger.ID)
		return "", nil, nil
	}
	result, err := s.enqueueRecordProbe(ctx, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return result.Status, nil, err
}

func (s *Server) retryRecordProbe(ctx context.Context) (int64, error) {
	result, err := s.enqueueRecordProbe(ctx, workflowRunTrigger{Type: "manual", Reason: "retry_run"})
	return result.RunID, err
}
