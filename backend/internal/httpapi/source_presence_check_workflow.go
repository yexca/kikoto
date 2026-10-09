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

// The source presence check workflow asks one remote source whether each
// selected library work exists there and records the answer as that work's
// source presence. It probes the source first, so an unreachable source never
// marks works missing, and it only records presence for existing works.
const (
	sourcePresenceCheckWorkflowCode = "source_presence_check"
	sourcePresenceCheckDisplayName  = "Check works on a source"
	sourcePresenceCheckDescription  = "Check whether library works exist on one remote source and record the result."
	sourcePresenceCheckWorkerType   = "source_presence_check"

	sourcePresenceCheckSelectNodeID = "select"
	sourcePresenceCheckHealthNodeID = "health"
	sourcePresenceCheckCheckNodeID  = "check"

	sourcePresenceLibraryLocal          = "local"
	sourcePresenceLibraryAll            = "all"
	sourcePresenceFilterAll             = "all"
	sourcePresenceFilterNoRemoteSource  = "no_remote_source"
	sourcePresenceCheckDefaultLimit     = 100
	sourcePresenceCheckMaxLimit         = 1000
	sourcePresenceCheckMaxFailureStreak = 5
)

var sourcePresenceCheckNodes = []map[string]string{
	{"id": sourcePresenceCheckSelectNodeID, "type": "select_works", "displayName": "Select works"},
	{"id": sourcePresenceCheckHealthNodeID, "type": "check_source_health", "displayName": "Check source health"},
	{"id": sourcePresenceCheckCheckNodeID, "type": "check_source_availability", "displayName": "Check works on source"},
}

// sourcePresenceCheckOptions is the run request, the trigger config, the run
// input, and the job payload.
type sourcePresenceCheckOptions struct {
	SourceID int64  `json:"sourceId"`
	Library  string `json:"library"`
	Filter   string `json:"filter"`
	Limit    int    `json:"limit"`
}

type sourcePresenceCheckQueuedResult struct {
	RunID    int64  `json:"runId"`
	JobID    int64  `json:"jobId"`
	Status   string `json:"status"`
	Existing bool   `json:"existing"`
}

type sourcePresenceCheckCheckpoint struct {
	Selected  bool    `json:"selected"`
	WorkIDs   []int64 `json:"workIds"`
	Next      int     `json:"next"`
	Available int     `json:"available"`
	Missing   int     `json:"missing"`
	Failed    int     `json:"failed"`
	Skipped   int     `json:"skipped"`
}

// sourcePresenceCheckInputError is a request or trigger config the caller can fix.
type sourcePresenceCheckInputError struct{ message string }

func (e sourcePresenceCheckInputError) Error() string { return e.message }

func normalizeSourcePresenceCheckOptions(options sourcePresenceCheckOptions) (sourcePresenceCheckOptions, error) {
	if options.SourceID <= 0 {
		return options, sourcePresenceCheckInputError{"sourceId is required"}
	}
	switch strings.TrimSpace(options.Library) {
	case "", sourcePresenceLibraryLocal:
		options.Library = sourcePresenceLibraryLocal
	case sourcePresenceLibraryAll:
		options.Library = sourcePresenceLibraryAll
	default:
		return options, sourcePresenceCheckInputError{"library must be local or all"}
	}
	switch strings.TrimSpace(options.Filter) {
	case sourcePresenceFilterAll:
		options.Filter = sourcePresenceFilterAll
	case "", sourcePresenceFilterNoRemoteSource:
		options.Filter = sourcePresenceFilterNoRemoteSource
	default:
		return options, sourcePresenceCheckInputError{"filter must be all or no_remote_source"}
	}
	if options.Limit == 0 {
		options.Limit = sourcePresenceCheckDefaultLimit
	}
	if options.Limit < 1 || options.Limit > sourcePresenceCheckMaxLimit {
		return options, sourcePresenceCheckInputError{fmt.Sprintf("limit must be between 1 and %d", sourcePresenceCheckMaxLimit)}
	}
	return options, nil
}

func normalizeSourcePresenceCheckTriggerConfig(raw string) (sourcePresenceCheckOptions, error) {
	var config sourcePresenceCheckOptions
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	if err := decodeStrictJSON(raw, &config); err != nil {
		return config, fmt.Errorf("source presence check trigger config is invalid")
	}
	return normalizeSourcePresenceCheckOptions(config)
}

// sourcePresenceCheckSource loads the source a run checks. It must be an
// enabled source whose type supports work lookups and that has an API endpoint.
func (s *Server) sourcePresenceCheckSource(ctx context.Context, sourceID int64) (remoteSourceForUse, error) {
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteSourceForUse{}, sourcePresenceCheckInputError{"source not found"}
	}
	if err != nil {
		return remoteSourceForUse{}, err
	}
	switch {
	case !source.Enabled:
		return remoteSourceForUse{}, sourcePresenceCheckInputError{"source is disabled"}
	case !isKikoeruSourceType(source.SourceType):
		return remoteSourceForUse{}, sourcePresenceCheckInputError{"source type does not support work checks"}
	case strings.TrimSpace(source.Endpoint.APIURL) == "":
		return remoteSourceForUse{}, sourcePresenceCheckInputError{"source API endpoint is not configured"}
	}
	return source, nil
}

func (s *Server) createSourcePresenceCheckRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var request sourcePresenceCheckOptions
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source presence check request"})
		return
	}
	result, err := s.enqueueSourcePresenceCheck(r.Context(), request, workflowRunTrigger{Type: "manual", Reason: "manual"})
	var inputErr sourcePresenceCheckInputError
	if errors.As(err, &inputErr) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": inputErr.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// enqueueSourcePresenceCheck queues one run, or returns the run that is
// already queued or running for the same source.
func (s *Server) enqueueSourcePresenceCheck(ctx context.Context, request sourcePresenceCheckOptions, trigger workflowRunTrigger) (sourcePresenceCheckQueuedResult, error) {
	options, err := normalizeSourcePresenceCheckOptions(request)
	if err != nil {
		return sourcePresenceCheckQueuedResult{}, err
	}
	if _, err := s.sourcePresenceCheckSource(ctx, options.SourceID); err != nil {
		return sourcePresenceCheckQueuedResult{}, err
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return sourcePresenceCheckQueuedResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	existing := sourcePresenceCheckQueuedResult{Existing: true}
	err = tx.QueryRowContext(ctx, `
		SELECT run.id, run.status, COALESCE((
			SELECT job.id FROM workflow_job AS job WHERE job.workflow_run_id = run.id ORDER BY job.id DESC LIMIT 1
		), 0)
		FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
			AND json_extract(run.input_json, '$.sourceId') = ?
		ORDER BY run.id DESC
		LIMIT 1
	`, sourcePresenceCheckWorkflowCode, options.SourceID).Scan(&existing.RunID, &existing.Status, &existing.JobID)
	if err == nil {
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return sourcePresenceCheckQueuedResult{}, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, sourcePresenceCheckWorkflowCode, sourcePresenceCheckDisplayName,
		sourcePresenceCheckDescription, map[string]any{"nodes": sourcePresenceCheckNodes})
	if err != nil {
		return sourcePresenceCheckQueuedResult{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, sourcePresenceCheckWorkflowCode, sourcePresenceCheckDisplayName,
		"queued", trigger.Type, trigger.Reason, options, map[string]any{})
	if err != nil {
		return sourcePresenceCheckQueuedResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return sourcePresenceCheckQueuedResult{}, err
		}
	}
	var selectNodeID int64
	for index, node := range sourcePresenceCheckNodes {
		spec := workflow.NodeRunSpec{
			NodeID: node["id"], NodeType: node["type"], DisplayName: node["displayName"], Position: index + 1, Status: "queued",
		}
		if index == 0 {
			spec.Input = options
		}
		nodeRunID, err := workflow.InsertNodeRun(ctx, tx, runID, spec)
		if err != nil {
			return sourcePresenceCheckQueuedResult{}, err
		}
		if index == 0 {
			selectNodeID = nodeRunID
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: sourcePresenceCheckWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "remote:availability", Payload: options,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3,
	})
	if err != nil {
		return sourcePresenceCheckQueuedResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return sourcePresenceCheckQueuedResult{}, err
	}
	return sourcePresenceCheckQueuedResult{RunID: runID, JobID: jobID, Status: "queued"}, nil
}

func (s *Server) executeSourcePresenceCheckJob(ctx context.Context, job workflowJobRecord) error {
	var options sourcePresenceCheckOptions
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &options); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint := sourcePresenceCheckCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	source, err := s.sourcePresenceCheckSource(ctx, options.SourceID)
	var inputErr sourcePresenceCheckInputError
	if errors.As(err, &inputErr) {
		// The source changed after the run was queued; retrying cannot help.
		return s.finishSourcePresenceCheckJob(context.WithoutCancel(ctx), job, nodeIDs, sourcePresenceCheckSelectNodeID, "failed",
			checkpoint, map[string]any{"source_id": options.SourceID}, inputErr.Error())
	}
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	summary := func() map[string]any {
		return map[string]any{
			"source_id": source.ID, "source_display_name": source.DisplayName,
			"library": options.Library, "filter": options.Filter, "limit": options.Limit,
			"selected_works": len(checkpoint.WorkIDs), "checked_works": checkpoint.Next - checkpoint.Skipped,
			"available_works": checkpoint.Available, "missing_works": checkpoint.Missing,
			"failed_works": checkpoint.Failed, "skipped_works": checkpoint.Skipped,
			"unchecked_works": len(checkpoint.WorkIDs) - checkpoint.Next,
		}
	}

	if !checkpoint.Selected {
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "selecting", checkpoint, 0, 0)
		workIDs, err := s.selectSourcePresenceCheckWorks(ctx, options)
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		checkpoint = sourcePresenceCheckCheckpoint{Selected: true, WorkIDs: workIDs}
		if err := s.advanceSourcePresenceCheckNode(ctx, job, nodeIDs[sourcePresenceCheckSelectNodeID], nodeIDs[sourcePresenceCheckHealthNodeID],
			map[string]any{"selected_works": len(workIDs)}, len(workIDs)); err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "health", checkpoint, 0, len(workIDs)); err != nil {
			return err
		}
	}

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
		slog.Warn("source presence check skipped an unavailable source", "source_id", source.ID, "run_id", job.RunID, "error", probe.Err)
		return s.finishSourcePresenceCheckJob(context.WithoutCancel(ctx), job, nodeIDs, sourcePresenceCheckHealthNodeID, "failed",
			checkpoint, summary(), source.DisplayName+": unavailable")
	}
	if err := s.advanceSourcePresenceCheckNode(ctx, job, nodeIDs[sourcePresenceCheckHealthNodeID], nodeIDs[sourcePresenceCheckCheckNodeID],
		map[string]any{"health_status": probe.Status}, len(checkpoint.WorkIDs)); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}

	failureStreak := 0
	for checkpoint.Next < len(checkpoint.WorkIDs) {
		if err := ctx.Err(); err != nil {
			return err
		}
		workID := checkpoint.WorkIDs[checkpoint.Next]
		var code string
		err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code)
		switch {
		case errors.Is(err, sql.ErrNoRows) || (err == nil && strings.TrimSpace(code) == ""):
			checkpoint.Skipped++
		case err != nil:
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		default:
			result, err := s.checkOneWorkSourceAvailability(ctx, source, code, sourcePresenceCheckWorkflowCode)
			if ctxErr := ctx.Err(); ctxErr != nil {
				// An interrupted request is not an answer about the work.
				return ctxErr
			}
			if err == nil {
				err = s.recordSourceAvailabilityObservation(ctx, code, []sourceAvailabilitySummary{result})
			}
			if err != nil {
				_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
				return err
			}
			switch result.Status {
			case "available":
				checkpoint.Available++
				failureStreak = 0
			case "not_found":
				checkpoint.Missing++
				failureStreak = 0
			default:
				checkpoint.Failed++
				failureStreak++
			}
		}
		checkpoint.Next++
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "checking", checkpoint, checkpoint.Next, len(checkpoint.WorkIDs)); err != nil {
			return err
		}
		if failureStreak >= sourcePresenceCheckMaxFailureStreak {
			// The source stopped answering; leave the rest for a later run.
			break
		}
	}
	status := "succeeded"
	failure := ""
	if checkpoint.Failed > 0 {
		status = "partial"
		failure = fmt.Sprintf("%s: %d work checks failed", source.DisplayName, checkpoint.Failed)
	}
	return s.finishSourcePresenceCheckJob(context.WithoutCancel(ctx), job, nodeIDs, sourcePresenceCheckCheckNodeID, status,
		checkpoint, summary(), failure)
}

// selectSourcePresenceCheckWorks returns at most options.Limit work ids. Works
// the source has never been asked about come first, then the ones checked
// longest ago, so repeated runs cover the whole selection.
func (s *Server) selectSourcePresenceCheckWorks(ctx context.Context, options sourcePresenceCheckOptions) ([]int64, error) {
	query := `
		SELECT work.id
		FROM work
		LEFT JOIN work_source_presence AS checked
			ON checked.work_id = work.id AND checked.file_source_id = ? AND checked.presence_type = ?
		WHERE work.primary_code <> ''
	`
	args := []any{options.SourceID, sourcePresenceTypeRemoteSource}
	if options.Library == sourcePresenceLibraryLocal {
		query += `
			AND EXISTS (
				SELECT 1 FROM work_source_presence AS local_presence
				WHERE local_presence.work_id = work.id
					AND local_presence.presence_type = 'local'
					AND local_presence.availability = 'available'
			)
		`
	}
	if options.Filter == sourcePresenceFilterNoRemoteSource {
		query += `
			AND NOT EXISTS (
				SELECT 1 FROM work_source_presence AS remote_presence
				WHERE remote_presence.work_id = work.id
					AND remote_presence.presence_type IN (?, 'tracked')
					AND remote_presence.availability = 'available'
			)
			AND NOT EXISTS (
				SELECT 1
				FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = work.id
					AND location.location_type = 'remote_stream'
					AND location.availability = 'available'
			)
		`
		args = append(args, sourcePresenceTypeRemoteSource)
	}
	query += `
		ORDER BY checked.last_checked_at IS NOT NULL, checked.last_checked_at, work.id
		LIMIT ?
	`
	args = append(args, options.Limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	workIDs := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		workIDs = append(workIDs, id)
	}
	return workIDs, rows.Err()
}

// advanceSourcePresenceCheckNode completes one node and starts the next.
func (s *Server) advanceSourcePresenceCheckNode(ctx context.Context, job workflowJobRecord, doneNodeID, nextNodeID int64, output map[string]any, total int) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', output_json = ?,
			started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, mustJSON(output), doneNodeID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ? AND status = 'queued'
	`, nextNodeID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`, total, job.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// finishSourcePresenceCheckJob records the run outcome on the node that ended
// it; later nodes of a failed run are skipped.
func (s *Server) finishSourcePresenceCheckJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, endNodeID, status string,
	checkpoint sourcePresenceCheckCheckpoint, summary map[string]any, failure string) error {
	output := mustJSON(summary)
	failures := []string{}
	if failure != "" {
		failures = append(failures, failure)
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	ended := false
	// Guards keep a run that was cancelled while checking cancelled.
	for _, node := range sourcePresenceCheckNodes {
		nodeID := nodeIDs[node["id"]]
		switch {
		case node["id"] == endNodeID:
			ended = true
			if _, err := tx.ExecContext(ctx, `
				UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?,
					started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
				WHERE id = ? AND status IN ('queued', 'running')
			`, status, output, failure, nodeID); err != nil {
				return err
			}
		case ended:
			if _, err := tx.ExecContext(ctx, `
				UPDATE workflow_node_run SET status = 'skipped', finished_at = CURRENT_TIMESTAMP
				WHERE id = ? AND status IN ('queued', 'running')
			`, nodeID); err != nil {
				return err
			}
		}
	}
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running'`, []any{status, checkpoint.Next, len(checkpoint.WorkIDs), failure,
			mustJSON(map[string]any{"phase": "completed", "detail": checkpoint, "progressCurrent": checkpoint.Next, "progressTotal": len(checkpoint.WorkIDs)}), job.ID}},
		{`UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: nodeIDs[endNodeID], JobID: job.ID, Level: eventLevelForWorkflowStatus(status),
		Type: "source_presence_check.completed", Message: "Source presence check " + status, Detail: summary,
	}); err != nil {
		return err
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, status, failures); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) executeSourcePresenceCheckSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	config, err := normalizeSourcePresenceCheckTriggerConfig(trigger.ConfigJSON)
	if err != nil {
		return "", nil, err
	}
	result, err := s.enqueueSourcePresenceCheck(ctx, config, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return result.Status, nil, err
}

func (s *Server) retrySourcePresenceCheck(ctx context.Context, runID int64) (int64, error) {
	var inputJSON string
	if err := s.db.QueryRowContext(ctx, "SELECT input_json FROM workflow_run WHERE id = ?", runID).Scan(&inputJSON); err != nil {
		return 0, err
	}
	var options sourcePresenceCheckOptions
	_ = json.Unmarshal([]byte(inputJSON), &options)
	result, err := s.enqueueSourcePresenceCheck(ctx, options, workflowRunTrigger{Type: "manual", Reason: "retry_run"})
	return result.RunID, err
}
