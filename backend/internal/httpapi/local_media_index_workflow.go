package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// The local media index workflow walks the file tree of local work folders
// that local library scans have already discovered, so opening a work does
// not have to index a large folder on the request path.
const (
	localMediaIndexWorkflowCode = "local_media_index"
	localMediaIndexDisplayName  = "Refresh local work files"
	localMediaIndexDescription  = "Index the media files inside discovered local work folders."
	localMediaIndexWorkerType   = "local_media_index"

	// Incremental indexes only folders whose file tree was never scanned;
	// full re-indexes every available local work folder.
	localMediaIndexModeIncremental = "incremental"
	localMediaIndexModeFull        = "full"

	localMediaIndexFailureLimit      = 50
	localMediaIndexCheckpointEvery   = time.Second
	localMediaIndexSelectNodeID      = "select"
	localMediaIndexIndexNodeID       = "index"
	localMediaIndexSelectNodeType    = "select_local_works"
	localMediaIndexIndexNodeType     = "index_local_media"
	localMediaIndexSelectDisplayName = "Select local works"
	localMediaIndexIndexDisplayName  = "Index work files"
)

var localMediaIndexNodes = []map[string]string{
	{"id": localMediaIndexSelectNodeID, "type": localMediaIndexSelectNodeType, "displayName": localMediaIndexSelectDisplayName},
	{"id": localMediaIndexIndexNodeID, "type": localMediaIndexIndexNodeType, "displayName": localMediaIndexIndexDisplayName},
}

type localMediaIndexPayload struct {
	Mode string `json:"mode"`
}

type localMediaIndexRunRequest struct {
	Mode string `json:"mode"`
}

type localMediaIndexTriggerConfig struct {
	Mode string `json:"mode"`
}

type localMediaIndexQueuedResult struct {
	RunID    int64  `json:"runId"`
	JobID    int64  `json:"jobId"`
	Status   string `json:"status"`
	Mode     string `json:"mode"`
	Existing bool   `json:"existing"`
}

type localMediaIndexTarget struct {
	WorkID       int64
	FileSourceID int64
	RelPath      string
	PrimaryCode  string
}

// normalizeLocalMediaIndexMode defaults an empty mode to incremental.
func normalizeLocalMediaIndexMode(mode string) (string, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	switch mode {
	case "":
		return localMediaIndexModeIncremental, nil
	case localMediaIndexModeIncremental, localMediaIndexModeFull:
		return mode, nil
	default:
		return "", fmt.Errorf("local media index mode must be incremental or full")
	}
}

func normalizeLocalMediaIndexTriggerConfig(raw string) (localMediaIndexTriggerConfig, error) {
	var config localMediaIndexTriggerConfig
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	if err := decodeStrictJSON(raw, &config); err != nil {
		return config, fmt.Errorf("local media index trigger config is invalid")
	}
	mode, err := normalizeLocalMediaIndexMode(config.Mode)
	if err != nil {
		return config, err
	}
	config.Mode = mode
	return config, nil
}

func (s *Server) createLocalMediaIndexRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	var request localMediaIndexRunRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid local media index request"})
		return
	}
	mode, err := normalizeLocalMediaIndexMode(request.Mode)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.enqueueLocalMediaIndex(r.Context(), workflowRunTrigger{Type: "manual", Reason: "manual"}, mode)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// enqueueLocalMediaIndex queues one run, or returns the run that is already
// queued or running, since two concurrent passes would index the same folders.
func (s *Server) enqueueLocalMediaIndex(ctx context.Context, trigger workflowRunTrigger, mode string) (localMediaIndexQueuedResult, error) {
	mode, err := normalizeLocalMediaIndexMode(mode)
	if err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	existing := localMediaIndexQueuedResult{Existing: true}
	var existingInput string
	err = tx.QueryRowContext(ctx, `
		SELECT run.id, run.status, run.input_json, COALESCE((
			SELECT job.id FROM workflow_job AS job WHERE job.workflow_run_id = run.id ORDER BY job.id DESC LIMIT 1
		), 0)
		FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
		ORDER BY run.id DESC
		LIMIT 1
	`, localMediaIndexWorkflowCode).Scan(&existing.RunID, &existing.Status, &existingInput, &existing.JobID)
	if err == nil {
		var payload localMediaIndexPayload
		_ = json.Unmarshal([]byte(existingInput), &payload)
		existing.Mode = payload.Mode
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return localMediaIndexQueuedResult{}, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, localMediaIndexWorkflowCode, localMediaIndexDisplayName,
		localMediaIndexDescription, map[string]any{"nodes": localMediaIndexNodes})
	if err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	payload := localMediaIndexPayload{Mode: mode}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, localMediaIndexWorkflowCode, localMediaIndexDisplayName,
		"queued", trigger.Type, trigger.Reason, payload, map[string]any{})
	if err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return localMediaIndexQueuedResult{}, err
		}
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: localMediaIndexSelectNodeID, NodeType: localMediaIndexSelectNodeType, DisplayName: localMediaIndexSelectDisplayName,
		Position: 1, Status: "queued", Input: payload,
	})
	if err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: localMediaIndexIndexNodeID, NodeType: localMediaIndexIndexNodeType, DisplayName: localMediaIndexIndexDisplayName,
		Position: 2, Status: "queued",
	}); err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: localMediaIndexWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "local:media-index", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3,
	})
	if err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return localMediaIndexQueuedResult{}, err
	}
	return localMediaIndexQueuedResult{RunID: runID, JobID: jobID, Status: "queued", Mode: mode}, nil
}

func (s *Server) executeLocalMediaIndexJob(ctx context.Context, job workflowJobRecord) error {
	var payload localMediaIndexPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	mode, err := normalizeLocalMediaIndexMode(payload.Mode)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "selecting", map[string]any{"mode": mode}, 0, 0)
	targets, err := s.selectLocalMediaIndexTargets(ctx, mode)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if err := s.completeLocalMediaIndexSelection(ctx, job, nodeIDs, mode, len(targets)); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}

	indexed := 0
	failures := []string{}
	failed := 0
	lastCheckpoint := time.Now()
	for index, target := range targets {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.indexLocalMediaForWork(ctx, target.WorkID, target.FileSourceID, target.RelPath); err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return ctxErr
			}
			failed++
			if len(failures) < localMediaIndexFailureLimit {
				failures = append(failures, target.PrimaryCode+": "+err.Error())
			}
		} else {
			indexed++
		}
		if time.Since(lastCheckpoint) >= localMediaIndexCheckpointEvery {
			lastCheckpoint = time.Now()
			_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "indexing", map[string]any{
				"mode": mode, "indexed_works": indexed, "failed_works": failed,
			}, index+1, len(targets))
		}
	}
	status := "succeeded"
	if failed > 0 {
		status = "partial"
		if indexed == 0 {
			status = "failed"
		}
	}
	summary := map[string]any{
		"mode": mode, "selected_works": len(targets), "indexed_works": indexed, "failed_works": failed, "failures": failures,
	}
	return s.finishLocalMediaIndexJob(context.WithoutCancel(ctx), job, nodeIDs[localMediaIndexIndexNodeID], status, len(targets), summary, failures)
}

// selectLocalMediaIndexTargets reads every target before indexing starts, so
// no cursor holds a pooled connection while folders are walked and written.
func (s *Server) selectLocalMediaIndexTargets(ctx context.Context, mode string) ([]localMediaIndexTarget, error) {
	unscannedOnly := 0
	if mode == localMediaIndexModeIncremental {
		unscannedOnly = 1
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT presence.work_id, presence.file_source_id, presence.source_url, work.primary_code
		FROM work_source_presence AS presence
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		INNER JOIN work ON work.id = presence.work_id
		WHERE presence.presence_type = 'local'
			AND presence.availability = 'available'
			AND source.source_type = 'local_folder'
			AND TRIM(presence.source_url) <> ''
			AND (? = 0 OR COALESCE(json_extract(presence.raw_json, '$.file_tree_scanned'), 0) = 0)
		ORDER BY source.priority ASC, work.primary_code ASC, presence.work_id ASC
	`, unscannedOnly)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	targets := []localMediaIndexTarget{}
	for rows.Next() {
		var target localMediaIndexTarget
		if err := rows.Scan(&target.WorkID, &target.FileSourceID, &target.RelPath, &target.PrimaryCode); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func (s *Server) completeLocalMediaIndexSelection(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, mode string, selected int) error {
	output := mustJSON(map[string]any{"mode": mode, "selected_works": selected})
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, output, nodeIDs[localMediaIndexSelectNodeID]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ? AND status = 'queued'
	`, nodeIDs[localMediaIndexIndexNodeID]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET progress_current = 0, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`, selected, job.ID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) finishLocalMediaIndexJob(ctx context.Context, job workflowJobRecord, indexNodeID int64, status string, selected int, summary map[string]any, failures []string) error {
	output := mustJSON(summary)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Guards keep a run that was cancelled while indexing cancelled.
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, indexNodeID}},
		{`UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running'`, []any{status, selected, selected, strings.Join(failures, "\n"),
			mustJSON(map[string]any{"phase": "completed", "detail": summary, "progressCurrent": selected, "progressTotal": selected}), job.ID}},
		{`UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: indexNodeID, JobID: job.ID, Level: eventLevelForWorkflowStatus(status),
		Type: "local_media_index.completed", Message: "Local work file refresh " + status, Detail: summary,
	}); err != nil {
		return err
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, status, failures); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) executeLocalMediaIndexSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	config, err := normalizeLocalMediaIndexTriggerConfig(trigger.ConfigJSON)
	if err != nil {
		return "", nil, err
	}
	result, err := s.enqueueLocalMediaIndex(ctx, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID}, config.Mode)
	return result.Status, nil, err
}

func (s *Server) retryLocalMediaIndex(ctx context.Context, runID int64) (int64, error) {
	var inputJSON string
	if err := s.db.QueryRowContext(ctx, "SELECT input_json FROM workflow_run WHERE id = ?", runID).Scan(&inputJSON); err != nil {
		return 0, err
	}
	var payload localMediaIndexPayload
	_ = json.Unmarshal([]byte(inputJSON), &payload)
	result, err := s.enqueueLocalMediaIndex(ctx, workflowRunTrigger{Type: "manual", Reason: "retry_run"}, payload.Mode)
	return result.RunID, err
}
