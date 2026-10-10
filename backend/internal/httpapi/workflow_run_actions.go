package httpapi

// Workflow cancellation, retry, review, recovery, and access control.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

func (s *Server) cancelWorkflowRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	tx, err := beginTxWithDatabaseBusyRetry(r.Context(), s.db)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	run, err := s.loadWorkflowRunTx(r.Context(), tx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	allowed, err := canManageWorkflowRun(r.Context(), tx, actor, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	if run.Status != "queued" && run.Status != "running" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "only queued or running workflow runs can be cancelled"})
		return
	}
	changed, err := s.cancelWorkflowRunTx(r.Context(), tx, run, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if !changed {
		_ = tx.Rollback()
		writeJSON(w, http.StatusConflict, map[string]string{"error": "workflow run has already finished"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	s.cancelActiveWorkflowJob(id)
	writeJSON(w, http.StatusOK, workflowRunActionResult{RunID: id, Status: "cancelled", Message: "run cancelled"})
}

func (s *Server) cancelWorkflowRunTx(ctx context.Context, tx *sql.Tx, run workflowRunRecord, runID int64) (bool, error) {
	summary := mergeJSONObjects(run.SummaryJSON, map[string]any{"cancelled": true, "cancel_reason": "manual"})
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'cancelled',
			error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
			AND status IN ('queued', 'running')
	`, runID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'cancelled',
			error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
			AND status IN ('queued', 'running')
	`, runID); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'cancelled', summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, mustJSON(summary), runID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return affected > 0, err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		Level: "warn", Type: "run.cancelled", Message: "Run cancelled manually",
		Detail: map[string]any{"previous_status": run.Status},
	}); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Server) retryWorkflowRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	run, err := s.loadWorkflowRun(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	allowed, err := canManageWorkflowRun(r.Context(), s.db, actor, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	if run.Status == "queued" || run.Status == "running" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "running workflow runs cannot be retried"})
		return
	}
	dispatch, err := s.dispatchWorkflowRetry(r.Context(), actor, run, id)
	if errors.Is(err, errWorkflowRetryPermission) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	if errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this workflow has no recoverable failed job"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	detail := map[string]any{"new_run_id": dispatch.NewRunID}
	if dispatch.ResumedExistingRun {
		detail = map[string]any{"resumed_run_id": id}
	}
	if err := s.recordWorkflowRunEvent(r.Context(), id, "info", "run.retry_requested", "Retry started", detail); err != nil {
		writeError(w, err)
		return
	}
	result := workflowRunActionResult{RunID: id, Status: "retried", Message: "retry started"}
	if !dispatch.ResumedExistingRun {
		result.NewRunID = &dispatch.NewRunID
	}
	writeJSON(w, http.StatusAccepted, result)
}

var (
	errWorkflowRetryPermission       = errors.New("workflow retry permission denied")
	errWorkflowRetryNoRecoverableJob = errors.New("workflow has no recoverable failed job")
)

type workflowRetryDispatchResult struct {
	NewRunID           int64
	ResumedExistingRun bool
}

func (s *Server) dispatchWorkflowRetry(ctx context.Context, actor currentUser, run workflowRunRecord, runID int64) (workflowRetryDispatchResult, error) {
	switch run.WorkflowCode {
	case "local_library_scan":
		if !userHasPermission(actor, "metadata:sync") {
			return workflowRetryDispatchResult{}, errWorkflowRetryPermission
		}
		newRunID, err := s.retryLocalLibraryScan(ctx, runID)
		return workflowRetryDispatchResult{NewRunID: newRunID}, err
	case localMediaIndexWorkflowCode:
		if !userHasPermission(actor, "metadata:sync") {
			return workflowRetryDispatchResult{}, errWorkflowRetryPermission
		}
		newRunID, err := s.retryLocalMediaIndex(ctx, runID)
		return workflowRetryDispatchResult{NewRunID: newRunID}, err
	case sourcePresenceCheckWorkflowCode:
		if !userHasPermission(actor, "sources:write") {
			return workflowRetryDispatchResult{}, errWorkflowRetryPermission
		}
		newRunID, err := s.retrySourcePresenceCheck(ctx, runID)
		return workflowRetryDispatchResult{NewRunID: newRunID}, err
	case "metadata_sync":
		if !userHasPermission(actor, "metadata:sync") {
			return workflowRetryDispatchResult{}, errWorkflowRetryPermission
		}
		// A retry repeats the failed run's scope.
		var input metadataSyncRunInput
		var inputJSON string
		if err := s.db.QueryRowContext(ctx, "SELECT input_json FROM workflow_run WHERE id = ?", runID).Scan(&inputJSON); err != nil {
			return workflowRetryDispatchResult{}, err
		}
		if err := json.Unmarshal([]byte(inputJSON), &input); err != nil {
			return workflowRetryDispatchResult{}, err
		}
		options, err := input.normalized()
		if err != nil {
			return workflowRetryDispatchResult{}, err
		}
		result, err := s.enqueueScopedDLsiteMetadataSync(ctx, "manual", "retry_run", 0, options)
		return workflowRetryDispatchResult{NewRunID: result.RunID}, err
	default:
		return s.retryWorkflowGraph(ctx, actor, runID)
	}
}

func (s *Server) retryLocalLibraryScan(ctx context.Context, runID int64) (int64, error) {
	var payload localScanJobPayload
	var inputJSON string
	if err := s.db.QueryRowContext(ctx, "SELECT input_json FROM workflow_run WHERE id = ?", runID).Scan(&inputJSON); err != nil {
		return 0, err
	}
	if err := json.Unmarshal([]byte(inputJSON), &payload); err != nil {
		return 0, err
	}
	result, err := s.enqueueLocalScanWithOptions(ctx, "manual", "retry_run", 0, payload.FollowUpRun)
	return result.RunID, err
}

func (s *Server) retryWorkflowGraph(ctx context.Context, actor currentUser, runID int64) (workflowRetryDispatchResult, error) {
	allowed, err := s.canRetryWorkflowGraphRun(ctx, actor, runID)
	if err != nil {
		return workflowRetryDispatchResult{}, err
	}
	if !allowed {
		return workflowRetryDispatchResult{}, errWorkflowRetryPermission
	}
	if err := s.retryFailedWorkflowJobFor(ctx, &actor, runID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowRetryDispatchResult{}, errWorkflowRetryNoRecoverableJob
		}
		return workflowRetryDispatchResult{}, err
	}
	return workflowRetryDispatchResult{NewRunID: runID, ResumedExistingRun: true}, nil
}

type workflowRunOwnershipQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func canViewAllWorkflowRuns(actor currentUser) bool {
	return missingWorkflowGraphPermission(actor.Permissions, []string{"system:admin"}) == ""
}

// workflowRunRequesterKey is the run input field that records the account
// that started a run, directly or as the owner of the trigger that fired it.
const workflowRunRequesterKey = "requested_by_user_id"

// canAdministerWorkflowRuns reports whether an account may act on runs other
// accounts started and on maintenance such as stale-run recovery. It is the
// same capability as the other instance maintenance surfaces.
func canAdministerWorkflowRuns(actor currentUser) bool {
	return userHasPermission(actor, "sources:write")
}

func (s *Server) requireWorkflowRunAccess(w http.ResponseWriter, r *http.Request, actor currentUser, runID int64) bool {
	if s.cfg.IsDemo() {
		var showcase bool
		err := s.db.QueryRowContext(r.Context(), "SELECT trigger_reason = ? FROM workflow_run WHERE id = ?", workflow.DemoShowcaseTriggerReason, runID).Scan(&showcase)
		if errors.Is(err, sql.ErrNoRows) || err == nil && !showcase {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return false
		}
		if err != nil {
			writeError(w, err)
			return false
		}
	}
	return requireWorkflowRunAccessFrom(w, r, s.db, actor, runID)
}

func requireWorkflowRunAccessFrom(w http.ResponseWriter, r *http.Request, db workflowRunOwnershipQuerier, actor currentUser, runID int64) bool {
	allowed, err := canViewWorkflowRun(r.Context(), db, actor, runID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
		return false
	}
	if err != nil {
		writeError(w, err)
		return false
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return false
	}
	return true
}

// requireWorkflowRunManagement allows changing a run (cancel, retry, and
// candidate decisions) to the account that started it and to workflow
// administrators. It answers 404 for a run the actor cannot see.
func requireWorkflowRunManagement(w http.ResponseWriter, r *http.Request, db workflowRunOwnershipQuerier, actor currentUser, runID int64) bool {
	if !requireWorkflowRunAccessFrom(w, r, db, actor, runID) {
		return false
	}
	allowed, err := canManageWorkflowRun(r.Context(), db, actor, runID)
	if err != nil {
		writeError(w, err)
		return false
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return false
	}
	return true
}

// requireWorkflowCandidateManagement resolves a candidate's run, requires
// management of that run, and requires downloads:manage for a candidate
// whose resolution removes, archives, or marks unavailable local files.
func requireWorkflowCandidateManagement(w http.ResponseWriter, r *http.Request, db workflowRunOwnershipQuerier, actor currentUser, candidateID int64) bool {
	var runID int64
	var candidateType string
	if err := db.QueryRowContext(r.Context(), "SELECT workflow_run_id, candidate_type FROM workflow_candidate WHERE id = ?", candidateID).Scan(&runID, &candidateType); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow candidate not found"})
			return false
		}
		writeError(w, err)
		return false
	}
	if !requireWorkflowRunManagement(w, r, db, actor, runID) {
		return false
	}
	if workflowCandidateChangesLocalFiles(candidateType) && !userHasPermission(actor, "downloads:manage") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return false
	}
	return true
}

func workflowCandidateChangesLocalFiles(candidateType string) bool {
	switch candidateType {
	case "local_fetch_merge_cleanup", "local_duplicate_work_folder", "local_symlink_media_location":
		return true
	default:
		return false
	}
}

type workflowRunOwnership struct {
	scope             string
	triggerReason     string
	ownerUserID       int64
	requestedByUserID int64
}

func loadWorkflowRunOwnership(ctx context.Context, db workflowRunOwnershipQuerier, runID int64) (workflowRunOwnership, error) {
	var ownership workflowRunOwnership
	err := db.QueryRowContext(ctx, `
		SELECT COALESCE(definition.scope, ''),
			COALESCE(definition.owner_user_id, 0),
			COALESCE(CAST(json_extract(run.input_json, '$.`+workflowRunRequesterKey+`') AS INTEGER), 0),
			run.trigger_reason
		FROM workflow_run AS run
		LEFT JOIN workflow_definition AS definition ON definition.id = run.workflow_definition_id
		WHERE run.id = ?
	`, runID).Scan(&ownership.scope, &ownership.ownerUserID, &ownership.requestedByUserID, &ownership.triggerReason)
	return ownership, err
}

func (ownership workflowRunOwnership) startedBy(actor currentUser) bool {
	return actor.ID > 0 && (ownership.ownerUserID == actor.ID || ownership.requestedByUserID == actor.ID)
}

// canViewWorkflowRun is the run visibility rule shared with the run list:
// system-scoped runs are visible to every workflow account, and a run of a
// user-scoped definition only to its owner or requester.
func canViewWorkflowRun(ctx context.Context, db workflowRunOwnershipQuerier, actor currentUser, runID int64) (bool, error) {
	ownership, err := loadWorkflowRunOwnership(ctx, db, runID)
	if err != nil {
		return false, err
	}
	if canViewAllWorkflowRuns(actor) {
		return true, nil
	}
	if ownership.scope != "user" && (ownership.scope != "" || ownership.triggerReason != "custom_definition") {
		return true, nil
	}
	return ownership.startedBy(actor), nil
}

// canManageWorkflowRun narrows visibility for changes: an account that does
// not administer workflows may change only the runs it started.
func canManageWorkflowRun(ctx context.Context, db workflowRunOwnershipQuerier, actor currentUser, runID int64) (bool, error) {
	visible, err := canViewWorkflowRun(ctx, db, actor, runID)
	if err != nil || !visible {
		return false, err
	}
	if canViewAllWorkflowRuns(actor) || canAdministerWorkflowRuns(actor) {
		return true, nil
	}
	ownership, err := loadWorkflowRunOwnership(ctx, db, runID)
	if err != nil {
		return false, err
	}
	return ownership.startedBy(actor), nil
}

func (s *Server) canRetryWorkflowGraphRun(ctx context.Context, actor currentUser, runID int64) (bool, error) {
	if missingWorkflowGraphPermission(actor.Permissions, []string{"system:admin"}) == "" {
		return true, nil
	}
	var payloadJSON string
	err := s.db.QueryRowContext(ctx, `
		SELECT payload_json
		FROM workflow_job
		WHERE workflow_run_id = ? AND status = 'failed' AND recoverable = 1 AND worker_type = 'custom_workflow'
		ORDER BY id DESC
		LIMIT 1
	`, runID).Scan(&payloadJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	var payload workflowGraphJobPayload
	if err := decodeWorkflowJobPayload(payloadJSON, &payload); err != nil {
		return false, err
	}
	if payload.UserID != actor.ID {
		return false, nil
	}
	graph, err := validateWorkflowGraphDefinition(payload.DefinitionJSON)
	if err != nil {
		return false, err
	}
	return missingWorkflowGraphPermission(actor.Permissions, workflowGraphRequiredPermissions(graph)) == "", nil
}

func (s *Server) retryFailedWorkflowJob(ctx context.Context, runID int64) error {
	return s.retryFailedWorkflowJobFor(ctx, nil, runID)
}

// retryFailedWorkflowJobFor requeues the newest recoverable failed job. With
// an actor, the job's work must be something that actor could start.
func (s *Server) retryFailedWorkflowJobFor(ctx context.Context, actor *currentUser, runID int64) error {
	var job workflowJobRecord
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workflow_run_id, COALESCE(workflow_node_run_id, 0), worker_type,
			payload_json, checkpoint_json, '', resume_count, retry_count, max_retries
		FROM workflow_job
		WHERE workflow_run_id = ? AND status = 'failed' AND recoverable = 1
			AND worker_type IN (
				'remote_work_fetch', 'remote_media_cache', 'remote_popular_collection',
				'media_cache_limit_cleanup', 'media_cache_cleanup', 'local_media_delete', 'local_location_cleanup',
				'media_location_cleanup', 'metadata_family_sync', 'custom_workflow', 'metadata_genre_names'
			)
		ORDER BY id DESC LIMIT 1
	`, runID).Scan(
		&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType,
		&job.PayloadJSON, &job.CheckpointJSON, &job.LockedBy, &job.ResumeCount, &job.RetryCount, &job.MaxRetries,
	)
	if err != nil {
		return err
	}
	if actor != nil && missingWorkflowGraphPermission(actor.Permissions, workflowJobRetryPermissions(job)) != "" {
		return errWorkflowRetryPermission
	}
	return s.requeueFailedWorkflowJob(ctx, job, 0, "Manual retry requested")
}

// workflowJobRetryPermissions is what starting the failed job's work again
// requires, so a retry never does more than the actor could start directly.
// Graph jobs are checked against their graph by canRetryWorkflowGraphRun.
func workflowJobRetryPermissions(job workflowJobRecord) []string {
	switch job.WorkerType {
	case "remote_work_fetch", "remote_media_cache":
		return []string{"remote:fetch"}
	case "remote_popular_collection":
		var payload remoteCollectionJobPayload
		_ = decodeWorkflowJobPayload(job.PayloadJSON, &payload)
		return []string{"tags:write", remoteCollectionActionPermission(payload.Action)}
	case "media_cache_limit_cleanup", "media_cache_cleanup", "local_media_delete", "local_location_cleanup", "media_location_cleanup":
		return []string{"downloads:manage"}
	case "metadata_family_sync", "metadata_genre_names":
		return []string{"metadata:sync"}
	default:
		return nil
	}
}

func (s *Server) reviewWorkflowRun(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	run, err := s.loadWorkflowRun(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	if !s.requireWorkflowRunAccess(w, r, user, id) {
		return
	}
	if run.PendingCandidates > 0 || run.PendingMetadata > 0 || run.Status == "queued" || run.Status == "running" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "resolve pending issues and wait for completion before marking the run reviewed"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO workflow_run_review (workflow_run_id, user_id, status, reviewed_at)
		VALUES (?, ?, 'reviewed', CURRENT_TIMESTAMP)
		ON CONFLICT(workflow_run_id, user_id) DO UPDATE SET
			status = 'reviewed',
			reviewed_at = CURRENT_TIMESTAMP
	`, id, user.ID); err != nil {
		writeError(w, err)
		return
	}
	if err := workflow.InsertEvent(r.Context(), tx, id, workflow.EventSpec{
		Level:   "info",
		Type:    "run.reviewed",
		Message: "Run marked reviewed",
		Detail:  map[string]any{"user_id": user.ID},
	}); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	next, err := s.loadWorkflowRun(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, next)
}

func (s *Server) recoverStaleWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	if !canAdministerWorkflowRuns(actor) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	var result workflow.OrphanSweepResult
	err := withDatabaseBusyRetry(r.Context(), func() error {
		var err error
		result, err = s.workflowStore.SettleOrphans(r.Context(), workflow.OrphanSweep{
			Reason: "manual recovery", LiveLeases: s.workflowLeases.live,
			SettleIdleRuns: true, IdleRunGrace: manualRecoveryIdleRunGrace,
			ViewerUserID: actor.ID, CanViewAll: canViewAllWorkflowRuns(actor),
		})
		return err
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workflowRunActionResult{
		Status: "recovered", Message: "jobs without a running executor were requeued or marked failed; running jobs were left alone",
		Recovered: result.Changed(), Requeued: result.Requeued, Failed: result.Failed, Active: result.Active,
	})
}
