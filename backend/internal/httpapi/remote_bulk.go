package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

func (s *Server) createRemoteBulkRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	var payload struct {
		Action   string   `json:"action"`
		SourceID int64    `json:"sourceId"`
		Codes    []string `json:"codes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	payload.Action = strings.TrimSpace(payload.Action)
	payload.Action = normalizeRemoteBulkAction(payload.Action)
	if payload.Action == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be track, fetch, or track_fetch"})
		return
	}
	if _, ok := s.requirePermissions(w, r, remoteBulkActionPermissions(payload.Action)...); !ok {
		return
	}
	codes := []string{}
	seen := map[string]bool{}
	for _, raw := range payload.Codes {
		code := strings.ToUpper(strings.TrimSpace(raw))
		if code == "" || seen[code] {
			continue
		}
		if refuseCustomWorkCode(w, code) {
			return
		}
		seen[code] = true
		codes = append(codes, code)
	}
	if payload.SourceID <= 0 || len(codes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sourceId and codes are required"})
		return
	}
	result, err := s.enqueueRemoteBulkWorkflow(r.Context(), actor.ID, payload.SourceID, payload.Action, codes)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type remoteBulkWorkflowResult struct {
	RunID     int64    `json:"runId"`
	JobID     int64    `json:"jobId"`
	SourceID  int64    `json:"sourceId"`
	Action    string   `json:"action"`
	Codes     []string `json:"codes"`
	Status    string   `json:"status"`
	Synced    int      `json:"synced"`
	Fetched   int      `json:"fetched"`
	Failed    int      `json:"failed"`
	Failures  []string `json:"failures"`
	ChildRuns []int64  `json:"childRuns"`
}

type remoteBulkActionJobPayload struct {
	UserID   int64    `json:"user_id"`
	SourceID int64    `json:"source_id"`
	Action   string   `json:"action"`
	Codes    []string `json:"codes"`
	// ExcludeExtensions leaves files with these extensions out of each Fetch.
	ExcludeExtensions []string `json:"exclude_extensions,omitempty"`
	// WatchTargets maps a code to the Availability Watch target the run acts
	// for, which then references the Track or Fetch run started for it.
	WatchTargets map[string]int64 `json:"watch_targets,omitempty"`
}

func normalizeRemoteBulkAction(action string) string {
	switch strings.TrimSpace(action) {
	case "track", "sync":
		return "track"
	case "fetch", "save":
		return "fetch"
	case "track_fetch", "sync_fetch", "sync_save":
		return "track_fetch"
	default:
		return ""
	}
}

// remoteBulkActionPermissions names the composite capability each part of a
// bulk action needs: tracking adds works to the shared Library, while Fetch
// downloads remote files and may refresh DLsite family metadata.
func remoteBulkActionPermissions(action string) []string {
	switch normalizeRemoteBulkAction(action) {
	case "track":
		return []string{"remote:track"}
	case "fetch":
		return []string{"remote:fetch", "metadata:sync"}
	default:
		return []string{"remote:track", "remote:fetch", "metadata:sync"}
	}
}

func (s *Server) enqueueRemoteBulkWorkflow(ctx context.Context, userID int64, sourceID int64, action string, codes []string) (remoteBulkWorkflowResult, error) {
	return s.enqueueRemoteBulkWorkflowWith(ctx, remoteBulkActionJobPayload{UserID: userID, SourceID: sourceID, Action: action, Codes: codes}, nil)
}

// enqueueRemoteBulkWorkflowWith queues a bulk run; beforeCommit, when given,
// runs in the same transaction once the run exists.
func (s *Server) enqueueRemoteBulkWorkflowWith(ctx context.Context, payload remoteBulkActionJobPayload, beforeCommit func(tx *sql.Tx, runID int64) error) (remoteBulkWorkflowResult, error) {
	payload.Action = normalizeRemoteBulkAction(payload.Action)
	if payload.Action == "" {
		return remoteBulkWorkflowResult{}, fmt.Errorf("invalid remote bulk action")
	}
	runID, jobID, err := s.startRemoteBulkWorkflow(ctx, payload, beforeCommit)
	if err != nil {
		return remoteBulkWorkflowResult{}, err
	}
	return remoteBulkWorkflowResult{RunID: runID, JobID: jobID, SourceID: payload.SourceID, Action: payload.Action, Codes: payload.Codes, Status: "queued", Failures: []string{}}, nil
}

func (s *Server) executeRemoteBulkActionJob(ctx context.Context, job workflowJobRecord) error {
	var payload remoteBulkActionJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	owner, err := s.accountStore.LoadByID(ctx, payload.UserID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Remote bulk requester is unavailable")
		return err
	}
	if missing := missingWorkflowGraphPermission(owner.Permissions, append([]string{"workflows:run"}, remoteBulkActionPermissions(payload.Action)...)); missing != "" {
		_ = s.failClaimedWorkflowJob(ctx, job, "Remote bulk permission is no longer available")
		return fmt.Errorf("remote bulk action requires permission %s", missing)
	}
	result := remoteBulkWorkflowResult{RunID: job.RunID, SourceID: payload.SourceID, Action: payload.Action, Codes: payload.Codes, Status: "succeeded", Failures: []string{}}
	for _, code := range payload.Codes {
		s.processRemoteBulkCode(ctx, job.RunID, payload, code, &result)
	}
	status := "succeeded"
	if result.Failed > 0 {
		status = "partial"
	}
	return s.finishRemoteBulkWorkflowJob(ctx, job, status, result, nil)
}

func (s *Server) startRemoteBulkWorkflow(ctx context.Context, payload remoteBulkActionJobPayload, beforeCommit func(tx *sql.Tx, runID int64) error) (int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_bulk_action", "Run remote bulk action", "Select multiple remote works and dispatch per-work track or fetch workflows.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_works"},
			{"id": "dispatch", "type": "dispatch_child_workflows"},
		},
	})
	if err != nil {
		return 0, 0, err
	}
	input := map[string]any{"source_id": payload.SourceID, "action": payload.Action, "codes": payload.Codes, workflowRunRequesterKey: payload.UserID}
	if len(payload.ExcludeExtensions) > 0 {
		input["exclude_extensions"] = payload.ExcludeExtensions
	}
	summary := map[string]any{"source_id": payload.SourceID, "action": payload.Action, "works": len(payload.Codes)}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_bulk_action", "Run remote bulk action", "queued", "manual", payload.Action, input, summary)
	if err != nil {
		return 0, 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_works", DisplayName: "Select remote works", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"works": len(payload.Codes)},
	}); err != nil {
		return 0, 0, err
	}
	dispatchNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "dispatch", NodeType: "dispatch_child_workflows", DisplayName: "Dispatch per-work workflows", Position: 2, Status: "queued",
		Input: map[string]any{"action": payload.Action}, Output: map[string]any{"expected_child_runs": len(payload.Codes)},
	})
	if err != nil {
		return 0, 0, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: dispatchNodeID, WorkerType: "remote_bulk_action", Status: "queued",
		Priority: workflow.JobPriorityUserInitiated, ResourceKey: "remote:bulk", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 2,
	})
	if err != nil {
		return 0, 0, err
	}
	if beforeCommit != nil {
		if err := beforeCommit(tx, runID); err != nil {
			return 0, 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return runID, jobID, nil
}

func (s *Server) processRemoteBulkCode(ctx context.Context, bulkRunID int64, payload remoteBulkActionJobPayload, code string, result *remoteBulkWorkflowResult) {
	action := payload.Action
	watchTargetID := payload.WatchTargets[code]
	fail := func(failedAction string, err error) {
		recordRemoteBulkFailure(result, code, err)
		if watchTargetID > 0 {
			s.recordAvailabilityWatchActionFailure(ctx, watchTargetID, failedAction, bulkRunID)
		}
	}
	if action == "track" || action == "track_fetch" {
		syncResult, err := s.runRemoteWorkSync(ctx, payload.SourceID, code, "remote_bulk_"+action)
		if err != nil {
			fail("track", err)
			return
		}
		result.Synced++
		result.ChildRuns = append(result.ChildRuns, syncResult.RunID)
		if watchTargetID > 0 {
			s.recordAvailabilityWatchRun(ctx, watchTargetID, "track", bulkRunID, syncResult.RunID)
		}
	}
	if action != "fetch" && action != "track_fetch" {
		return
	}
	paths := []string{}
	if len(payload.ExcludeExtensions) > 0 {
		filtered, err := s.remoteFetchPathsExcluding(ctx, payload.SourceID, code, payload.ExcludeExtensions)
		if err != nil {
			fail("fetch", err)
			return
		}
		paths = filtered
	}
	saveResult, err := s.enqueueRemoteWorkSave(withRemoteFetchOrigin(ctx, "remote_bulk_action"), payload.SourceID, code, paths, nil, "", "", nil, 0, payload.UserID, workflow.JobPriorityBackground, nil)
	if err != nil {
		fail("fetch", err)
		return
	}
	result.Fetched++
	result.ChildRuns = append(result.ChildRuns, saveResult.RunID)
	if watchTargetID > 0 {
		s.recordAvailabilityWatchRun(ctx, watchTargetID, "fetch", bulkRunID, saveResult.RunID)
	}
}

func recordRemoteBulkFailure(result *remoteBulkWorkflowResult, code string, err error) {
	result.Failed++
	result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, err.Error()))
}

func (s *Server) finishRemoteBulkWorkflow(ctx context.Context, runID int64, dispatchNodeID int64, status string, result remoteBulkWorkflowResult, runErr error) error {
	result.Status = status
	output := map[string]any{
		"action":     result.Action,
		"source_id":  result.SourceID,
		"codes":      result.Codes,
		"synced":     result.Synced,
		"fetched":    result.Fetched,
		"failed":     result.Failed,
		"failures":   result.Failures,
		"child_runs": result.ChildRuns,
	}
	errorMessage := ""
	if runErr != nil {
		errorMessage = runErr.Error()
		output["error"] = errorMessage
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(output), errorMessage, dispatchNodeID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(output), runID); err != nil {
		return err
	}
	return nil
}

func (s *Server) finishRemoteBulkWorkflowJob(ctx context.Context, job workflowJobRecord, status string, result remoteBulkWorkflowResult, runErr error) error {
	if err := s.finishRemoteBulkWorkflow(ctx, job.RunID, job.NodeRunID, status, result, runErr); err != nil {
		return err
	}
	message := strings.Join(result.Failures, "\n")
	_, err := s.db.ExecContext(ctx, `UPDATE workflow_job
		SET status = ?, progress_current = progress_total, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?`, status, message, job.ID)
	return err
}
