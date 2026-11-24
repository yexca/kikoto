package httpapi

import (
	"context"
	"errors"
	"log/slog"
)

// An executor that fails records the failure on its job and then returns its
// own error, and it writes progress, checkpoints, run events, and source
// health as it goes. When one of these writes fails, the executor carries on
// with what it was doing: the write is the last thing it does on its way out,
// or it records state that a later write replaces. The runner still settles a
// job its executor left running under its lease (settleUnfinishedWorkflowJob).
// The failed write is logged here with the job's context instead of being
// dropped, so a lost workflow state write is never silent;
// scripts/check-go-dropped-errors.go rejects a blank-assigned result of these
// writes.

// logWorkflowWriteError logs a failed write of a job's or run's result, such
// as its failure, its finish, or the folders it returns to the library.
func logWorkflowWriteError(ctx context.Context, write string, job workflowJobRecord, err error) {
	logStateWriteError(ctx, slog.LevelError, write, err, workflowJobLogAttrs(job)...)
}

// logWorkflowProgressWriteError logs a failed write of a job's progress, a
// checkpoint, or a run event. A later write replaces a lost one, and a resumed
// job repeats the steps since the last checkpoint it recorded.
func logWorkflowProgressWriteError(ctx context.Context, write string, job workflowJobRecord, err error) {
	logStateWriteError(ctx, slog.LevelWarn, write, err, workflowJobLogAttrs(job)...)
}

// failJobOrLog fails the claimed job and its run with message, for an
// executor that returns the failure itself.
func (s *Server) failJobOrLog(ctx context.Context, job workflowJobRecord, message string) {
	logWorkflowWriteError(ctx, "fail workflow job", job, s.failClaimedWorkflowJob(ctx, job, message))
}

// checkpointJobOrLog records the job's progress checkpoint.
func (s *Server) checkpointJobOrLog(ctx context.Context, job workflowJobRecord, phase string, detail any, current int, total int) {
	logWorkflowProgressWriteError(ctx, "checkpoint workflow job "+phase, job, s.updateWorkflowJobCheckpoint(ctx, job.ID, phase, detail, current, total))
}

// recordRunEventOrLog adds an event to the run's activity.
func (s *Server) recordRunEventOrLog(ctx context.Context, runID int64, level string, eventType string, message string, detail any) {
	err := s.recordWorkflowRunEvent(ctx, runID, level, eventType, message, detail)
	logWorkflowProgressWriteError(ctx, "record workflow run event "+eventType, workflowJobRecord{RunID: runID}, err)
}

// setSourceHealthOrLog records the health a source request just observed. A
// lost write leaves the earlier health until the next request records it.
func (s *Server) setSourceHealthOrLog(ctx context.Context, sourceID int64, status string) {
	logStateWriteError(ctx, slog.LevelWarn, "record source health", s.updateSourceHealth(ctx, sourceID, status), "source_id", sourceID, "status", status)
}

func workflowJobLogAttrs(job workflowJobRecord) []any {
	attrs := []any{"run_id", job.RunID, "job_id", job.ID}
	if job.WorkerType != "" {
		attrs = append(attrs, "worker_type", job.WorkerType)
	}
	return attrs
}

// logStateWriteError logs a state write that failed while its caller carried
// on. A write cut short by cancellation is not logged: a service stop leaves
// the job to startup recovery, and a cancelled run has no result left to
// record.
func logStateWriteError(ctx context.Context, level slog.Level, write string, err error, attrs ...any) {
	if err == nil || errors.Is(err, context.Canceled) {
		return
	}
	slog.Log(context.WithoutCancel(ctx), level, "state write failed", append([]any{"write", write, "error", err}, attrs...)...)
}
