package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// The source health check workflow probes every enabled remote source that
// supports health checks, with the same probe and recorded result as the
// manual check in source settings.
const (
	sourceHealthCheckWorkflowCode = "source_health_check"
	sourceHealthCheckDisplayName  = "Check source health"
	sourceHealthCheckDescription  = "Probe the endpoint of each enabled remote source and record whether it is healthy or unavailable."
	sourceHealthCheckWorkerType   = "source_health_check"

	sourceHealthCheckSelectNodeID      = "select"
	sourceHealthCheckCheckNodeID       = "check"
	sourceHealthCheckSelectNodeType    = "select_remote_source"
	sourceHealthCheckCheckNodeType     = "check_source_health"
	sourceHealthCheckSelectDisplayName = "Select remote sources"
	sourceHealthCheckCheckDisplayName  = "Check endpoints"
)

var sourceHealthCheckNodes = []map[string]string{
	{"id": sourceHealthCheckSelectNodeID, "type": sourceHealthCheckSelectNodeType, "displayName": sourceHealthCheckSelectDisplayName},
	{"id": sourceHealthCheckCheckNodeID, "type": sourceHealthCheckCheckNodeType, "displayName": sourceHealthCheckCheckDisplayName},
}

// The workflow has no options; its run request and trigger config are empty
// objects and reject unknown fields.
type sourceHealthCheckOptions struct{}

type sourceHealthCheckQueuedResult struct {
	RunID    int64  `json:"runId"`
	JobID    int64  `json:"jobId"`
	Status   string `json:"status"`
	Existing bool   `json:"existing"`
}

type sourceHealthCheckSourceResult struct {
	ID           int64  `json:"id"`
	DisplayName  string `json:"display_name"`
	HealthStatus string `json:"health_status"`
}

func normalizeSourceHealthCheckTriggerConfig(raw string) (sourceHealthCheckOptions, error) {
	var config sourceHealthCheckOptions
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	if err := decodeStrictJSON(raw, &config); err != nil {
		return config, fmt.Errorf("source health check trigger config is invalid")
	}
	return config, nil
}

func (s *Server) createSourceHealthCheckRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var request sourceHealthCheckOptions
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source health check request"})
		return
	}
	result, err := s.enqueueSourceHealthCheck(r.Context(), workflowRunTrigger{Type: "manual", Reason: "manual"})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// enqueueSourceHealthCheck queues one run, or returns the run that is already
// queued or running, since a second pass would probe the same sources.
func (s *Server) enqueueSourceHealthCheck(ctx context.Context, trigger workflowRunTrigger) (sourceHealthCheckQueuedResult, error) {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return sourceHealthCheckQueuedResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	existing := sourceHealthCheckQueuedResult{Existing: true}
	err = tx.QueryRowContext(ctx, `
		SELECT run.id, run.status, COALESCE((
			SELECT job.id FROM workflow_job AS job WHERE job.workflow_run_id = run.id ORDER BY job.id DESC LIMIT 1
		), 0)
		FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
		ORDER BY run.id DESC
		LIMIT 1
	`, sourceHealthCheckWorkflowCode).Scan(&existing.RunID, &existing.Status, &existing.JobID)
	if err == nil {
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return sourceHealthCheckQueuedResult{}, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, sourceHealthCheckWorkflowCode, sourceHealthCheckDisplayName,
		sourceHealthCheckDescription, map[string]any{"nodes": sourceHealthCheckNodes})
	if err != nil {
		return sourceHealthCheckQueuedResult{}, err
	}
	payload := sourceHealthCheckOptions{}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, sourceHealthCheckWorkflowCode, sourceHealthCheckDisplayName,
		"queued", trigger.Type, trigger.Reason, payload, map[string]any{})
	if err != nil {
		return sourceHealthCheckQueuedResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return sourceHealthCheckQueuedResult{}, err
		}
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: sourceHealthCheckSelectNodeID, NodeType: sourceHealthCheckSelectNodeType, DisplayName: sourceHealthCheckSelectDisplayName,
		Position: 1, Status: "queued", Input: payload,
	})
	if err != nil {
		return sourceHealthCheckQueuedResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: sourceHealthCheckCheckNodeID, NodeType: sourceHealthCheckCheckNodeType, DisplayName: sourceHealthCheckCheckDisplayName,
		Position: 2, Status: "queued",
	}); err != nil {
		return sourceHealthCheckQueuedResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: sourceHealthCheckWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "remote:source-health", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3,
	})
	if err != nil {
		return sourceHealthCheckQueuedResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return sourceHealthCheckQueuedResult{}, err
	}
	return sourceHealthCheckQueuedResult{RunID: runID, JobID: jobID, Status: "queued"}, nil
}

func (s *Server) executeSourceHealthCheckJob(ctx context.Context, job workflowJobRecord) error {
	var payload sourceHealthCheckOptions
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "selecting", map[string]any{}, 0, 0)
	targets, err := s.selectSourceHealthCheckTargets(ctx)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if err := s.completeSourceHealthCheckSelection(ctx, job, nodeIDs, len(targets)); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}

	results := make([]sourceHealthCheckSourceResult, 0, len(targets))
	failures := []string{}
	healthy := 0
	for index, source := range targets {
		probe, err := s.checkAndRecordRemoteSourceHealth(ctx, source)
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		if probe.Err != nil {
			// The upstream error can name the endpoint, so it stays in the server log.
			slog.Warn("scheduled source health check failed", "source_id", source.ID, "run_id", job.RunID, "error", probe.Err)
			failures = append(failures, source.DisplayName+": unavailable")
		} else {
			healthy++
		}
		results = append(results, sourceHealthCheckSourceResult{ID: source.ID, DisplayName: source.DisplayName, HealthStatus: probe.Status})
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "checking", map[string]any{
			"healthy_sources": healthy, "unavailable_sources": len(results) - healthy,
		}, index+1, len(targets))
	}
	status := "succeeded"
	if healthy < len(results) {
		status = "partial"
	}
	summary := map[string]any{
		"checked_sources": len(results), "healthy_sources": healthy, "unavailable_sources": len(results) - healthy,
		"sources": results,
	}
	return s.finishSourceHealthCheckJob(context.WithoutCancel(ctx), job, nodeIDs[sourceHealthCheckCheckNodeID], status, len(targets), summary, failures)
}

// selectSourceHealthCheckTargets returns the enabled remote sources that
// support a health check and have an API endpoint, the same conditions the
// manual check requires.
func (s *Server) selectSourceHealthCheckTargets(ctx context.Context) ([]remoteSourceForUse, error) {
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	targets := make([]remoteSourceForUse, 0, len(sources))
	for _, source := range sources {
		if !source.Enabled || !isKikoeruSourceType(source.SourceType) || strings.TrimSpace(source.Endpoint.APIURL) == "" {
			continue
		}
		targets = append(targets, source)
	}
	return targets, nil
}

func (s *Server) completeSourceHealthCheckSelection(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, selected int) error {
	output := mustJSON(map[string]any{"selected_sources": selected})
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, output, nodeIDs[sourceHealthCheckSelectNodeID]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ? AND status = 'queued'
	`, nodeIDs[sourceHealthCheckCheckNodeID]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET progress_current = 0, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`, selected, job.ID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) finishSourceHealthCheckJob(ctx context.Context, job workflowJobRecord, checkNodeID int64, status string, checked int, summary map[string]any, failures []string) error {
	output := mustJSON(summary)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Guards keep a run that was cancelled while checking cancelled.
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, checkNodeID}},
		{`UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running'`, []any{status, checked, checked, strings.Join(failures, "\n"),
			mustJSON(map[string]any{"phase": "completed", "detail": summary, "progressCurrent": checked, "progressTotal": checked}), job.ID}},
		{`UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: checkNodeID, JobID: job.ID, Level: eventLevelForWorkflowStatus(status),
		Type: "source_health_check.completed", Message: "Source health check " + status, Detail: summary,
	}); err != nil {
		return err
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, status, failures); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) executeSourceHealthCheckSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	if _, err := normalizeSourceHealthCheckTriggerConfig(trigger.ConfigJSON); err != nil {
		return "", nil, err
	}
	result, err := s.enqueueSourceHealthCheck(ctx, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return result.Status, nil, err
}

func (s *Server) retrySourceHealthCheck(ctx context.Context) (int64, error) {
	result, err := s.enqueueSourceHealthCheck(ctx, workflowRunTrigger{Type: "manual", Reason: "retry_run"})
	return result.RunID, err
}
