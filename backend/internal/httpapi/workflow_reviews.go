package httpapi

// Candidate review, Fetch archive review, and local cleanup flows.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

func (s *Server) updateWorkflowCandidate(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow candidate id"})
		return
	}
	payload, err := decodeWorkflowCandidateUpdate(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if !requireWorkflowCandidateManagement(w, r, tx, actor, id) {
		return
	}
	var runID int64
	var nodeRunID sql.NullInt64
	var candidateType string
	var externalKey string
	if err := tx.QueryRowContext(r.Context(), `
		SELECT workflow_run_id, workflow_node_run_id, candidate_type, external_key
		FROM workflow_candidate
		WHERE id = ?
	`, id).Scan(&runID, &nodeRunID, &candidateType, &externalKey); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow candidate not found"})
			return
		}
		writeError(w, err)
		return
	}
	if candidateType == remoteOriginBlockedCandidateType {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "update the remote source outbound policy, then retry the workflow run"})
		return
	}
	if err := updateWorkflowCandidateReview(r.Context(), tx, id, payload, runID, nodeRunID, candidateType, externalKey); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	candidates, err := s.loadWorkflowCandidates(r.Context(), runID)
	if err != nil {
		writeError(w, err)
		return
	}
	s.remoteAddressRedactorFor(r.Context()).candidates(candidates)
	for _, candidate := range candidates {
		if candidate.ID == id {
			writeJSON(w, http.StatusOK, candidate)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func decodeWorkflowCandidateUpdate(r *http.Request) (workflowCandidateUpdatePayload, error) {
	var payload workflowCandidateUpdatePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return workflowCandidateUpdatePayload{}, errors.New("invalid JSON body")
	}
	payload.Status = strings.TrimSpace(payload.Status)
	payload.DecisionJSON = strings.TrimSpace(payload.DecisionJSON)
	if payload.DecisionJSON == "" {
		payload.DecisionJSON = "{}"
	}
	if !allowedCandidateReviewStatus(payload.Status) {
		return workflowCandidateUpdatePayload{}, errors.New("unsupported candidate status")
	}
	if !json.Valid([]byte(payload.DecisionJSON)) {
		return workflowCandidateUpdatePayload{}, errors.New("decision JSON is invalid")
	}
	return payload, nil
}

func updateWorkflowCandidateReview(ctx context.Context, tx *sql.Tx, candidateID int64, payload workflowCandidateUpdatePayload, runID int64, nodeRunID sql.NullInt64, candidateType, externalKey string) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_candidate
		SET status = ?, decision_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, payload.Status, payload.DecisionJSON, candidateID); err != nil {
		return err
	}
	return workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		NodeRunID: nullableInt64Value(nodeRunID), Level: "info", Type: "candidate.reviewed",
		Message: "Candidate " + payload.Status,
		Detail:  map[string]any{"candidate_id": candidateID, "candidate_type": candidateType, "external_key": externalKey, "status": payload.Status},
	})
}

func (s *Server) cleanupLocalWorkflowCandidate(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow candidate id"})
		return
	}
	var payload localCandidateCleanupPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	payload.Action = strings.TrimSpace(payload.Action)
	if payload.Action == "" {
		payload.Action = "mark_unavailable"
	}
	if payload.Action != "mark_unavailable" && payload.Action != "delete_files" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be mark_unavailable or delete_files"})
		return
	}
	if !requireWorkflowCandidateManagement(w, r, s.db, actor, id) {
		return
	}
	result, err := s.runLocalCandidateCleanup(r.Context(), id, payload.Action, payload.LocationIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type archivedFetchRoot struct {
	FolderID     int64  `json:"folder_id"`
	OriginalPath string `json:"original_path"`
	ArchivePath  string `json:"archive_path"`
}

type archivedFetchReviewRequest struct {
	Action  string `json:"action"`
	Confirm string `json:"confirm"`
}

func (s *Server) reviewArchivedFetchRoots(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow candidate id"})
		return
	}
	request, err := decodeArchivedFetchReviewRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !requireWorkflowCandidateManagement(w, r, s.db, actor, id) {
		return
	}
	candidate, err := s.loadWorkflowCandidateForCleanup(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	if candidate.Type != "local_fetch_merge_cleanup" || !candidateNeedsResolution(candidate.Status) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "candidate is not an unresolved Fetch archive review"})
		return
	}
	archivedRoots, err := archivedFetchRootsFromCandidate(candidate.PayloadJSON)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "candidate has no archived roots"})
		return
	}
	if request.Action == "delete_archived" {
		if err := s.deleteArchivedFetchRoots(archivedRoots); err != nil {
			var pathErr *archivedFetchRootPathError
			if errors.As(err, &pathErr) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeError(w, err)
			return
		}
	}
	if err := s.resolveArchivedFetchReview(r.Context(), id, candidate.RunID, request.Action, archivedRoots); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"candidateId": id, "status": "resolved", "action": request.Action})
}

func decodeArchivedFetchReviewRequest(r *http.Request) (archivedFetchReviewRequest, error) {
	var request archivedFetchReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		return request, errors.New("invalid JSON body")
	}
	request.Action = strings.TrimSpace(request.Action)
	if request.Action != "keep_archived" && request.Action != "delete_archived" {
		return request, errors.New("action must be keep_archived or delete_archived")
	}
	if request.Action == "delete_archived" && request.Confirm != "DELETE" {
		return request, errors.New("permanent deletion requires DELETE confirmation")
	}
	return request, nil
}

func archivedFetchRootsFromCandidate(raw string) ([]archivedFetchRoot, error) {
	var payload struct {
		ArchivedRoots []archivedFetchRoot `json:"archived_roots"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil || len(payload.ArchivedRoots) == 0 {
		return nil, errors.New("candidate has no archived roots")
	}
	return payload.ArchivedRoots, nil
}

type archivedFetchRootPathError struct{}

func (err *archivedFetchRootPathError) Error() string {
	return "archived root is outside the Fetch trash area"
}

func (s *Server) deleteArchivedFetchRoots(roots []archivedFetchRoot) error {
	for _, root := range roots {
		archive := filepath.ToSlash(strings.Trim(root.ArchivePath, "/"))
		if !fetchTrashArchiveAllowed(archive) {
			return &archivedFetchRootPathError{}
		}
		if _, err := safeDataPath(s.cfg.DataRoot, archive); err != nil {
			return err
		}
		if _, err := removeDestructiveTree(s.cfg.DataRoot, archive); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) resolveArchivedFetchReview(ctx context.Context, candidateID, runID int64, action string, roots []archivedFetchRoot) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, root := range roots {
		if action == "delete_archived" {
			if _, err := tx.ExecContext(ctx, "DELETE FROM work_folder_location WHERE id = ? AND state = 'pending_cleanup' AND cleanup_run_id = ?", root.FolderID, runID); err != nil {
				return err
			}
		} else if _, err := tx.ExecContext(ctx, "UPDATE work_folder_location SET state = 'ignored', cleanup_run_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'pending_cleanup' AND cleanup_run_id = ?", root.FolderID, runID); err != nil {
			return err
		}
	}
	decision := map[string]any{"action": action, "archived_roots": len(roots)}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_candidate SET status = 'resolved', decision_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(decision), candidateID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		Level: "info", Type: "candidate.fetch_archive_reviewed", Message: "Fetch archive " + action, Detail: decision,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func candidateNeedsResolution(status string) bool {
	status = strings.TrimSpace(status)
	return status != "accepted" && status != "rejected" && status != "ignored" && status != "resolved"
}

func (s *Server) runLocalCandidateCleanup(ctx context.Context, candidateID int64, action string, requestedLocationIDs []int64) (localCandidateCleanupResult, error) {
	candidate, err := s.loadWorkflowCandidateForCleanup(ctx, candidateID)
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	if candidate.Type != "local_fetch_merge_cleanup" && candidate.Type != "local_duplicate_work_folder" {
		return localCandidateCleanupResult{}, fmt.Errorf("candidate type %s cannot run local cleanup", candidate.Type)
	}
	allowedIDs := candidateLocalLocationIDs(candidate.PayloadJSON)
	locationIDs := intersectLocationIDs(allowedIDs, requestedLocationIDs)
	if len(locationIDs) == 0 {
		return localCandidateCleanupResult{}, fmt.Errorf("no cleanup locations selected")
	}

	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_location_cleanup", "Clean up local locations", "Mark reviewed local locations unavailable and optionally delete the files.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "cleanup", "type": "cleanup_local_locations"},
			{"id": "review", "type": "filter_candidates"},
		},
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	input := map[string]any{"candidate_id": candidateID, "action": action, "location_ids": locationIDs}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "local_location_cleanup", "Clean up local locations", "queued", "manual", action, input, map[string]any{"candidate_id": candidateID, "locations": len(locationIDs)})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select local locations", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"locations": len(locationIDs)},
	}); err != nil {
		return localCandidateCleanupResult{}, err
	}
	cleanupNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cleanup", NodeType: "cleanup_local_locations", DisplayName: "Clean local files", Position: 2, Status: "queued",
		Input: input, Output: nil,
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	reviewNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "review", NodeType: "filter_candidates", DisplayName: "Resolve review candidate", Position: 3, Status: "queued",
		Input: map[string]any{"candidate_id": candidateID}, Output: nil,
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	initialResult := localCandidateCleanupResult{RunID: runID, CandidateID: candidateID, Action: action, Status: "succeeded", Failures: []string{}}
	initialCheckpoint := localLocationCleanupCheckpoint{CompletedLocationIDs: []int64{}, Result: initialResult}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cleanupNodeID, WorkerType: "local_location_cleanup", Status: "queued", ResourceKey: "media:cleanup", Payload: input,
		Checkpoint: initialCheckpoint, Recoverable: true, MaxRetries: 3, ProgressCurrent: 0, ProgressTotal: len(locationIDs),
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return localCandidateCleanupResult{}, err
	}
	job := workflowJobRecord{
		ID: jobID, RunID: runID, NodeRunID: cleanupNodeID,
		PayloadJSON: mustJSON(input), CheckpointJSON: mustJSON(initialCheckpoint),
	}
	jobCtx, stopHeartbeat, err := s.leaseInlineWorkflowJob(ctx, job)
	if errors.Is(err, errWorkflowJobQueued) {
		initialResult.Status = "queued"
		return initialResult, nil
	}
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	defer stopHeartbeat()
	return s.performLocalLocationCleanupJob(jobCtx, job, reviewNodeID)
}

func (s *Server) executeLocalLocationCleanupJob(ctx context.Context, job workflowJobRecord) error {
	var reviewNodeID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'review' LIMIT 1
	`, job.RunID).Scan(&reviewNodeID); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_, err := s.performLocalLocationCleanupJob(ctx, job, reviewNodeID)
	return err
}

func (s *Server) performLocalLocationCleanupJob(ctx context.Context, job workflowJobRecord, reviewNodeID int64) (localCandidateCleanupResult, error) {
	var payload localLocationCleanupJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return localCandidateCleanupResult{}, err
	}
	checkpoint := localLocationCleanupCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return localCandidateCleanupResult{}, err
	}
	result := checkpoint.Result
	if result.RunID == 0 {
		result = localCandidateCleanupResult{RunID: job.RunID, CandidateID: payload.CandidateID, Action: payload.Action, Status: "succeeded", Failures: []string{}}
	}
	completed := map[int64]bool{}
	for _, id := range checkpoint.CompletedLocationIDs {
		completed[id] = true
	}
	for index, locationID := range payload.LocationIDs {
		if completed[locationID] {
			continue
		}
		deleted, marked, cleanupErr := s.cleanupLocalLocation(ctx, locationID, payload.Action == "delete_files")
		if cleanupErr != nil {
			result.Failed++
			result.Failures = append(result.Failures, fmt.Sprintf("%d: %s", locationID, cleanupErr.Error()))
		} else {
			if deleted {
				result.Deleted++
			}
			if marked {
				result.Marked++
			}
		}
		completed[locationID] = true
		checkpoint.Result = result
		checkpoint.CompletedLocationIDs = append(checkpoint.CompletedLocationIDs, locationID)
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "cleanup", checkpoint, index+1, len(payload.LocationIDs))
	}
	result.Status = "succeeded"
	if result.Failed > 0 {
		result.Status = "partial"
	}
	if err := s.finishLocalCandidateCleanup(ctx, payload.CandidateID, job.RunID, job.NodeRunID, reviewNodeID, result); err != nil {
		return localCandidateCleanupResult{}, err
	}
	return result, nil
}

func (s *Server) loadWorkflowCandidateForCleanup(ctx context.Context, candidateID int64) (workflowCandidateRecord, error) {
	var item workflowCandidateRecord
	var nodeRunID sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			id,
			workflow_run_id,
			workflow_node_run_id,
			candidate_type,
			external_key,
			status,
			payload_json,
			decision_json,
			created_at,
			updated_at
		FROM workflow_candidate
		WHERE id = ?
	`, candidateID).Scan(
		&item.ID,
		&item.RunID,
		&nodeRunID,
		&item.Type,
		&item.ExternalKey,
		&item.Status,
		&item.PayloadJSON,
		&item.DecisionJSON,
		&item.CreatedAt,
		&item.UpdatedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowCandidateRecord{}, fmt.Errorf("workflow candidate not found")
		}
		return workflowCandidateRecord{}, err
	}
	item.NodeRunID = sqlutil.Int64(nodeRunID)
	if item.Status == "resolved" || item.Status == "ignored" || item.Status == "rejected" {
		return workflowCandidateRecord{}, fmt.Errorf("workflow candidate is already %s", item.Status)
	}
	return item, nil
}

func candidateLocalLocationIDs(payloadJSON string) []int64 {
	var payload map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return nil
	}
	ids := int64Values(payload["candidate_location_ids"])
	if len(ids) > 0 {
		return ids
	}
	locations, _ := payload["candidate_locations"].([]any)
	for _, raw := range locations {
		location, _ := raw.(map[string]any)
		ids = append(ids, int64Values(location["location_id"])...)
	}
	return uniqueInt64s(ids)
}

func int64Values(value any) []int64 {
	switch typed := value.(type) {
	case []any:
		values := make([]int64, 0, len(typed))
		for _, raw := range typed {
			values = append(values, int64Values(raw)...)
		}
		return values
	case float64:
		if typed > 0 {
			return []int64{int64(typed)}
		}
	case int64:
		if typed > 0 {
			return []int64{typed}
		}
	case int:
		if typed > 0 {
			return []int64{int64(typed)}
		}
	}
	return nil
}

func intersectLocationIDs(allowed []int64, requested []int64) []int64 {
	allowedSet := map[int64]bool{}
	for _, id := range allowed {
		if id > 0 {
			allowedSet[id] = true
		}
	}
	if len(requested) == 0 {
		return uniqueInt64s(allowed)
	}
	result := []int64{}
	for _, id := range requested {
		if allowedSet[id] {
			result = append(result, id)
		}
	}
	return uniqueInt64s(result)
}

func uniqueInt64s(values []int64) []int64 {
	seen := map[int64]bool{}
	result := []int64{}
	for _, value := range values {
		if value <= 0 || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func (s *Server) cleanupLocalLocation(ctx context.Context, locationID int64, deleteFile bool) (bool, bool, error) {
	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(ctx, `
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, locationID).Scan(&locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, false, fmt.Errorf("local media location not found")
		}
		return false, false, err
	}
	if locationType != "local" {
		return false, false, fmt.Errorf("media location is not local")
	}
	deleted := false
	if deleteFile && availability == "available" {
		var err error
		deleted, _, err = removeDestructiveFile(s.cfg.DataRoot, relPath)
		if err != nil {
			return false, false, err
		}
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND location_type = 'local'
			AND availability != 'unavailable'
	`, locationID)
	if err != nil {
		return deleted, false, err
	}
	markedRows, _ := result.RowsAffected()
	return deleted, markedRows > 0, nil
}

func (s *Server) finishLocalCandidateCleanup(ctx context.Context, candidateID int64, runID int64, cleanupNodeID int64, reviewNodeID int64, result localCandidateCleanupResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	status := result.Status
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(result), cleanupNodeID); err != nil {
		return err
	}
	reviewStatus := "resolved"
	if result.Failed > 0 {
		reviewStatus = "pending"
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"candidate_id": candidateID, "candidate_status": reviewStatus}), reviewNodeID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_candidate
		SET status = ?,
			decision_json = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, reviewStatus, mustJSON(result), candidateID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
	`, status, result.Deleted+result.Marked+result.Failed, result.Deleted+result.Marked+result.Failed, strings.Join(result.Failures, "; "), runID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		NodeRunID: reviewNodeID,
		Level:     eventLevelForCleanupResult(result),
		Type:      "candidate.local_cleanup",
		Message:   "Local cleanup " + status,
		Detail:    result,
	}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(result), runID); err != nil {
		return err
	}
	return tx.Commit()
}

func eventLevelForCleanupResult(result localCandidateCleanupResult) string {
	if result.Failed > 0 {
		return "warn"
	}
	return "info"
}
