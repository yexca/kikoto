package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// A cleanup request is one durable user intent and must produce one workflow
// run. Keep the request bounded, but large enough for the complete session-cached
// work tree so the browser never has to orchestrate sequential child runs.
const maxMediaCleanupTargets = 20000

type mediaCleanupMode string

const (
	mediaCleanupFilesOnly         mediaCleanupMode = "files_only"
	mediaCleanupForgetWork        mediaCleanupMode = "files_and_forget_work"
	mediaCleanupForgetAuditAction                  = "media_cleanup.forget_work"
)

type mediaCleanupTargetRequest struct {
	Kind         string `json:"kind"`
	LocationID   int64  `json:"locationId"`
	FolderID     int64  `json:"folderId,omitempty"`
	ExpectedPath string `json:"expectedPath,omitempty"`
}

type mediaCleanupRequest struct {
	Targets []mediaCleanupTargetRequest `json:"targets"`
	Mode    string                      `json:"mode,omitempty"`
}

type mediaCleanupTarget struct {
	Kind         string `json:"kind"`
	LocationID   int64  `json:"locationId"`
	FolderID     int64  `json:"folderId,omitempty"`
	MediaItemID  int64  `json:"mediaItemId"`
	WorkID       int64  `json:"workId"`
	SourceID     int64  `json:"sourceId"`
	Path         string `json:"path"`
	ExpectedPath string `json:"expectedPath,omitempty"`
	CleanupRunID int64  `json:"cleanupRunId,omitempty"`
}

type mediaCleanupJobPayload struct {
	Targets      []mediaCleanupTarget `json:"targets"`
	Mode         mediaCleanupMode     `json:"mode"`
	ActorUserID  int64                `json:"actorUserId,omitempty"`
	ForgetNodeID int64                `json:"forgetNodeId,omitempty"`
}

type mediaCleanupCheckpoint struct {
	CompletedKeys  []string `json:"completedKeys"`
	CompletedCount int      `json:"completedCount"`
	Deleted        int      `json:"deleted"`
}

type mediaCleanupResult struct {
	RunID  int64  `json:"runId"`
	JobID  int64  `json:"jobId"`
	Status string `json:"status"`
	Queued int    `json:"queued"`
}

type mediaCleanupTargetConflictError struct{ message string }

func (e mediaCleanupTargetConflictError) Error() string {
	if strings.TrimSpace(e.message) == "" {
		return "media cleanup target changed; refresh the work and try again"
	}
	return e.message
}

func (s *Server) cleanupMediaLocations(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	var request mediaCleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	mode, err := parseMediaCleanupMode(request.Mode)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if mode == mediaCleanupForgetWork {
		if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
			return
		}
	}
	result, err := s.enqueueMediaLocationCleanupWithOptions(r.Context(), request.Targets, mediaCleanupOptions{
		Mode: mode, ActorUserID: actor.ID,
	})
	if err != nil {
		writeMediaCleanupError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type mediaCleanupOptions struct {
	Mode        mediaCleanupMode
	ActorUserID int64
}

func parseMediaCleanupMode(value string) (mediaCleanupMode, error) {
	switch mediaCleanupMode(strings.TrimSpace(value)) {
	case "", mediaCleanupFilesOnly:
		return mediaCleanupFilesOnly, nil
	case mediaCleanupForgetWork:
		return mediaCleanupForgetWork, nil
	default:
		return "", fmt.Errorf("invalid media cleanup mode")
	}
}

func writeMediaCleanupError(w http.ResponseWriter, err error) {
	var symlinkErr symlinkMediaLocationError
	if errors.As(err, &symlinkErr) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": err.Error(), "runId": symlinkErr.RunID, "candidateId": symlinkErr.CandidateID,
		})
		return
	}
	var conflictErr mediaCleanupTargetConflictError
	if errors.As(err, &conflictErr) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": conflictErr.Error(), "code": "media_cleanup_target_changed", "retryable": false,
		})
		return
	}
	writeError(w, err)
}

func (s *Server) enqueueMediaLocationCleanup(ctx context.Context, requested []mediaCleanupTargetRequest) (mediaCleanupResult, error) {
	return s.enqueueMediaLocationCleanupWithOptions(ctx, requested, mediaCleanupOptions{Mode: mediaCleanupFilesOnly})
}

func (s *Server) enqueueMediaLocationCleanupWithOptions(ctx context.Context, requested []mediaCleanupTargetRequest, options mediaCleanupOptions) (mediaCleanupResult, error) {
	options, targets, err := s.prepareMediaCleanupTargets(ctx, requested, options)
	if err != nil {
		return mediaCleanupResult{}, err
	}
	runID, jobID, err := s.insertMediaCleanupWorkflow(ctx, targets, options)
	if err != nil {
		return mediaCleanupResult{}, err
	}
	return mediaCleanupResult{RunID: runID, JobID: jobID, Status: "queued", Queued: len(targets)}, nil
}

func (s *Server) prepareMediaCleanupTargets(ctx context.Context, requested []mediaCleanupTargetRequest, options mediaCleanupOptions) (mediaCleanupOptions, []mediaCleanupTarget, error) {
	mode, err := parseMediaCleanupMode(string(options.Mode))
	if err != nil {
		return mediaCleanupOptions{}, nil, err
	}
	options.Mode = mode
	if mode == mediaCleanupForgetWork && options.ActorUserID <= 0 {
		return mediaCleanupOptions{}, nil, fmt.Errorf("an authenticated actor is required to forget a work")
	}
	if len(requested) == 0 {
		return mediaCleanupOptions{}, nil, fmt.Errorf("at least one media location is required")
	}
	if len(requested) > maxMediaCleanupTargets {
		return mediaCleanupOptions{}, nil, fmt.Errorf("at most %d media locations can be cleaned at once", maxMediaCleanupTargets)
	}
	targets := make([]mediaCleanupTarget, 0, len(requested))
	seen := map[string]bool{}
	for _, item := range requested {
		target, err := s.loadMediaCleanupTarget(ctx, item)
		if err != nil {
			return mediaCleanupOptions{}, nil, err
		}
		key := mediaCleanupTargetKey(target)
		if seen[key] {
			continue
		}
		seen[key] = true
		targets = append(targets, target)
	}
	if mode == mediaCleanupForgetWork {
		if err := validateMediaForgetTargets(targets); err != nil {
			return mediaCleanupOptions{}, nil, err
		}
	}
	return options, targets, nil
}

type mediaCleanupWorkflowSpec struct {
	Code        string
	DisplayName string
	Description string
	Nodes       []map[string]string
}

func mediaCleanupWorkflowSpecForMode(mode mediaCleanupMode) mediaCleanupWorkflowSpec {
	spec := mediaCleanupWorkflowSpec{
		Code:        "media_location_cleanup",
		DisplayName: "Clean media locations",
		Description: "Delete selected cache or local files and mark their locations unavailable.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "cleanup", "type": "cleanup_media_locations"},
		},
	}
	if mode == mediaCleanupForgetWork {
		spec.Code = "media_cleanup_forget_work"
		spec.DisplayName = "Delete media and forget work"
		spec.Description = "Delete selected files, then remove an unlinked logical work family and its personal state."
		spec.Nodes = append(spec.Nodes, map[string]string{"id": "forget", "type": "forget_unlinked_work"})
	}
	return spec
}

func (s *Server) insertMediaCleanupWorkflow(ctx context.Context, targets []mediaCleanupTarget, options mediaCleanupOptions) (int64, int64, error) {
	spec := mediaCleanupWorkflowSpecForMode(options.Mode)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	definition, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.DisplayName, spec.Description, map[string]any{"nodes": spec.Nodes})
	if err != nil {
		return 0, 0, err
	}
	payload := mediaCleanupJobPayload{Targets: targets, Mode: options.Mode, ActorUserID: options.ActorUserID}
	runID, err := workflow.InsertRun(ctx, tx, definition, spec.Code, spec.DisplayName, "queued", "manual", "delete_selected", payload, map[string]any{"locations": len(targets), "mode": options.Mode})
	if err != nil {
		return 0, 0, err
	}
	payload, cleanupNodeID, err := insertMediaCleanupNodeRuns(ctx, tx, runID, payload)
	if err != nil {
		return 0, 0, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cleanupNodeID, WorkerType: "media_location_cleanup", Status: "queued", Priority: workflow.JobPriorityUserInitiated, ResourceKey: "media:cleanup", Payload: payload,
		Checkpoint: mediaCleanupCheckpoint{CompletedKeys: []string{}}, Recoverable: true, MaxRetries: 3,
		ProgressCurrent: 0, ProgressTotal: len(targets),
	})
	if err != nil {
		return 0, 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return runID, jobID, nil
}

func insertMediaCleanupNodeRuns(ctx context.Context, tx *sql.Tx, runID int64, payload mediaCleanupJobPayload) (mediaCleanupJobPayload, int64, error) {
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select media locations", Position: 1, Status: "succeeded",
		Input: payload, Output: map[string]any{"locations": len(payload.Targets)},
	}); err != nil {
		return payload, 0, err
	}
	cleanupNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cleanup", NodeType: "cleanup_media_locations", DisplayName: "Delete media files", Position: 2, Status: "queued", Input: payload,
	})
	if err != nil {
		return payload, 0, err
	}
	if payload.Mode == mediaCleanupForgetWork {
		forgetNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
			NodeID: "forget", NodeType: "forget_unlinked_work", DisplayName: "Forget unlinked work", Position: 3, Status: "queued", Input: payload,
		})
		if err != nil {
			return payload, 0, err
		}
		payload.ForgetNodeID = forgetNodeID
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET input_json = ? WHERE id = ?", mustJSON(payload), forgetNodeID); err != nil {
			return payload, 0, err
		}
	}
	return payload, cleanupNodeID, nil
}

func validateMediaForgetTargets(targets []mediaCleanupTarget) error {
	if len(targets) == 0 {
		return fmt.Errorf("at least one media location is required")
	}
	workIDs := map[int64]struct{}{}
	hasRoot := false
	for _, target := range targets {
		if target.WorkID <= 0 {
			return fmt.Errorf("forget work target is missing its work")
		}
		workIDs[target.WorkID] = struct{}{}
		if target.Kind == "local_root" {
			hasRoot = true
		}
	}
	if !hasRoot {
		return fmt.Errorf("forget work requires the complete local work root")
	}
	if len(workIDs) != 1 {
		return fmt.Errorf("forget work can target only one work")
	}
	return nil
}

func (s *Server) loadMediaCleanupTarget(ctx context.Context, requested mediaCleanupTargetRequest) (mediaCleanupTarget, error) {
	requested.Kind = strings.TrimSpace(requested.Kind)
	if requested.LocationID <= 0 || (requested.Kind != "cache" && requested.Kind != "local" && requested.Kind != "local_root") {
		return mediaCleanupTarget{}, fmt.Errorf("invalid media cleanup target")
	}
	target, locationType, err := s.loadMediaCleanupLocation(ctx, requested.LocationID)
	if err != nil {
		return mediaCleanupTarget{}, err
	}
	switch requested.Kind {
	case "local_root":
		return s.prepareLocalRootCleanupTarget(ctx, requested, target, locationType)
	case "cache":
		return prepareCacheCleanupTarget(requested, target, locationType, s.cfg.CacheRoot)
	default:
		return s.prepareLocalFileCleanupTarget(ctx, requested, target, locationType)
	}
}

func (s *Server) loadMediaCleanupLocation(ctx context.Context, locationID int64) (mediaCleanupTarget, string, error) {
	var target mediaCleanupTarget
	var locationType string
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.id, location.media_item_id, item.work_id, location.file_source_id,
			location.location_type, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
	`, locationID).Scan(&target.LocationID, &target.MediaItemID, &target.WorkID, &target.SourceID, &locationType, &target.Path); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaCleanupTarget{}, "", fmt.Errorf("media location not found")
		}
		return mediaCleanupTarget{}, "", err
	}
	return target, locationType, nil
}

func (s *Server) prepareLocalRootCleanupTarget(ctx context.Context, requested mediaCleanupTargetRequest, target mediaCleanupTarget, locationType string) (mediaCleanupTarget, error) {
	if locationType != "local" {
		return mediaCleanupTarget{}, fmt.Errorf("media location %d is not local", requested.LocationID)
	}
	locationPath := normalizeFolderRootPath(target.Path)
	folder, err := s.resolveMediaCleanupFolder(ctx, target.WorkID, target.SourceID, requested.FolderID, requested.ExpectedPath)
	if err != nil {
		return mediaCleanupTarget{}, err
	}
	target.Kind = requested.Kind
	target.FolderID = folder.ID
	target.Path = folder.RootPath
	target.ExpectedPath = folder.RootPath
	if !mediaCleanupPathWithinRoot(target.Path, locationPath) {
		return mediaCleanupTarget{}, mediaCleanupTargetConflictError{message: "selected file is outside the confirmed local root"}
	}
	if _, err := validateDestructivePath(s.cfg.DataRoot, target.Path, true, true); err != nil {
		return mediaCleanupTarget{}, err
	}
	return target, nil
}

func prepareCacheCleanupTarget(requested mediaCleanupTargetRequest, target mediaCleanupTarget, locationType, cacheRoot string) (mediaCleanupTarget, error) {
	if locationType != requested.Kind {
		return mediaCleanupTarget{}, fmt.Errorf("media location %d is not %s", requested.LocationID, requested.Kind)
	}
	target.Kind = locationType
	if _, err := validateDestructivePath(cacheRoot, target.Path, true, false); err != nil {
		return mediaCleanupTarget{}, err
	}
	return target, nil
}

func (s *Server) prepareLocalFileCleanupTarget(ctx context.Context, requested mediaCleanupTargetRequest, target mediaCleanupTarget, locationType string) (mediaCleanupTarget, error) {
	if locationType != requested.Kind {
		return mediaCleanupTarget{}, fmt.Errorf("media location %d is not %s", requested.LocationID, requested.Kind)
	}
	target.Kind = locationType
	targetPath, err := safeDataPath(s.cfg.DataRoot, target.Path)
	if err != nil {
		return mediaCleanupTarget{}, err
	}
	if isSymlinkPath(targetPath) {
		runID, candidateID, err := s.createSymlinkMediaReview(ctx, target.LocationID, target.MediaItemID, target.WorkID, target.SourceID, target.Path)
		if err != nil {
			return mediaCleanupTarget{}, err
		}
		return mediaCleanupTarget{}, symlinkMediaLocationError{RunID: runID, CandidateID: candidateID, Path: target.Path}
	}
	if _, err := validateDestructivePath(s.cfg.DataRoot, target.Path, true, false); err != nil {
		return mediaCleanupTarget{}, err
	}
	if info, err := os.Stat(targetPath); err == nil && info.IsDir() {
		return mediaCleanupTarget{}, fmt.Errorf("refusing to delete directory %s", filepath.ToSlash(target.Path))
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return mediaCleanupTarget{}, err
	}
	return target, nil
}

type mediaCleanupFolder struct {
	ID       int64
	WorkID   int64
	SourceID int64
	RootPath string
	State    string
}

func (s *Server) resolveMediaCleanupFolder(ctx context.Context, workID int64, sourceID int64, requestedID int64, expectedPath string) (mediaCleanupFolder, error) {
	expectedPath = normalizeFolderRootPath(expectedPath)
	if requestedID <= 0 || expectedPath == "" {
		return mediaCleanupFolder{}, mediaCleanupTargetConflictError{message: "the local root confirmation is incomplete; refresh the work and try again"}
	}
	var folder mediaCleanupFolder
	if err := s.db.QueryRowContext(ctx, `
		SELECT id, work_id, file_source_id, root_path, state
		FROM work_folder_location
		WHERE id = ?
	`, requestedID).Scan(&folder.ID, &folder.WorkID, &folder.SourceID, &folder.RootPath, &folder.State); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaCleanupFolder{}, mediaCleanupTargetConflictError{message: "the confirmed local root no longer exists"}
		}
		return mediaCleanupFolder{}, err
	}
	if folder.WorkID != workID || folder.SourceID != sourceID || folder.State != "active" {
		return mediaCleanupFolder{}, mediaCleanupTargetConflictError{message: "the confirmed local root is no longer available"}
	}
	folder.RootPath = normalizeFolderRootPath(folder.RootPath)
	if expectedPath != folder.RootPath {
		return mediaCleanupFolder{}, mediaCleanupTargetConflictError{message: "the confirmed local root path changed"}
	}
	if folder.RootPath == "" {
		return mediaCleanupFolder{}, mediaCleanupTargetConflictError{message: "the confirmed local root path is empty"}
	}
	return folder, nil
}

func mediaCleanupPathWithinRoot(root string, candidate string) bool {
	root = normalizeFolderRootPath(root)
	candidate = normalizeFolderRootPath(candidate)
	return candidate == root || strings.HasPrefix(candidate, root+"/")
}

func relativeDataPath(root string, absolutePath string) string {
	relative, err := filepath.Rel(root, absolutePath)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(relative)
}

func (s *Server) mediaCleanupRunCancelled(ctx context.Context, runID int64) (bool, error) {
	var status string
	err := withDatabaseBusyRetry(context.WithoutCancel(ctx), func() error {
		return s.db.QueryRowContext(context.WithoutCancel(ctx), "SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&status)
	})
	if err != nil {
		return false, err
	}
	return status == "cancelled", nil
}

func (s *Server) claimMediaCleanupFolder(ctx context.Context, target mediaCleanupTarget, runID int64) error {
	if target.FolderID <= 0 {
		return nil
	}
	var result sql.Result
	err := withDatabaseBusyRetry(context.WithoutCancel(ctx), func() error {
		var err error
		result, err = s.db.ExecContext(context.WithoutCancel(ctx), `
		UPDATE work_folder_location
		SET state = 'pending_cleanup', cleanup_run_id = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND work_id = ? AND file_source_id = ? AND root_path = ?
			AND state = 'active' AND cleanup_run_id IS NULL
	`, runID, target.FolderID, target.WorkID, target.SourceID, normalizeFolderRootPath(target.Path))
		return err
	})
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected > 0 {
		return nil
	}
	var state string
	var claimed sql.NullInt64
	err = withDatabaseBusyRetry(context.WithoutCancel(ctx), func() error {
		return s.db.QueryRowContext(context.WithoutCancel(ctx), `
		SELECT state, cleanup_run_id FROM work_folder_location WHERE id = ?
	`, target.FolderID).Scan(&state, &claimed)
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaCleanupTargetConflictError{message: "the local root disappeared before deletion started"}
		}
		return err
	}
	if state == "pending_cleanup" && claimed.Valid && claimed.Int64 == runID {
		return nil
	}
	return mediaCleanupTargetConflictError{message: "the local root is already being changed by another operation"}
}

func (s *Server) restoreMediaCleanupFolders(ctx context.Context, runID int64) error {
	if runID <= 0 {
		return nil
	}
	err := withDatabaseBusyRetry(context.WithoutCancel(ctx), func() error {
		_, err := s.db.ExecContext(context.WithoutCancel(ctx), `
		UPDATE work_folder_location
		SET state = 'active', cleanup_run_id = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE cleanup_run_id = ? AND state = 'pending_cleanup'
	`, runID)
		return err
	})
	return err
}

func (s *Server) finishCancelledMediaCleanup(ctx context.Context, job workflowJobRecord) error {
	ctx = context.WithoutCancel(ctx)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'cancelled', error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
		WHERE workflow_run_id = ? AND status IN ('queued', 'running')
	`, job.RunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'cancelled', error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'cancelled',
			summary_json = json_set(COALESCE(NULLIF(summary_json, ''), '{}'), '$.cancelled', true, '$.cancel_reason', 'manual'),
			finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
		WHERE id = ? AND status IN ('queued', 'running')
	`, job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) executeMediaLocationCleanupJob(ctx context.Context, job workflowJobRecord) error {
	payload, checkpoint, err := decodeMediaCleanupExecution(job)
	if err != nil {
		_ = s.failClaimedWorkflowJob(context.WithoutCancel(ctx), job, err.Error())
		return err
	}
	statusCtx := context.WithoutCancel(ctx)
	finishCancelled := func() error {
		if err := s.restoreMediaCleanupFolders(statusCtx, job.RunID); err != nil {
			return err
		}
		return s.finishCancelledMediaCleanup(statusCtx, job)
	}
	if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
		return err
	}
	completed := mediaCleanupCompletedKeys(checkpoint)
	if stopped, err := s.processMediaCleanupTargets(ctx, statusCtx, job, payload, &checkpoint, completed, finishCancelled); stopped {
		return err
	}
	workIDs, err := mediaCleanupForgetWorkIDs(payload)
	if err != nil {
		_ = s.failClaimedWorkflowJob(statusCtx, job, err.Error())
		return err
	}
	if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
		return err
	}
	return s.finishMediaCleanupExecution(statusCtx, job, payload, checkpoint, workIDs, finishCancelled)
}

func decodeMediaCleanupExecution(job workflowJobRecord) (mediaCleanupJobPayload, mediaCleanupCheckpoint, error) {
	var payload mediaCleanupJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		return mediaCleanupJobPayload{}, mediaCleanupCheckpoint{}, err
	}
	mode, err := parseMediaCleanupMode(string(payload.Mode))
	if err != nil {
		return mediaCleanupJobPayload{}, mediaCleanupCheckpoint{}, err
	}
	payload.Mode = mode
	checkpoint := mediaCleanupCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		return mediaCleanupJobPayload{}, mediaCleanupCheckpoint{}, err
	}
	return payload, checkpoint, nil
}

func mediaCleanupCompletedKeys(checkpoint mediaCleanupCheckpoint) map[string]bool {
	completed := make(map[string]bool, len(checkpoint.CompletedKeys))
	for _, key := range checkpoint.CompletedKeys {
		completed[key] = true
	}
	return completed
}

func (s *Server) stopMediaCleanupIfNeeded(ctx context.Context, statusCtx context.Context, runID int64, finishCancelled func() error) (bool, error) {
	if ctx.Err() != nil {
		cancelled, err := s.mediaCleanupRunCancelled(statusCtx, runID)
		if err != nil {
			return true, err
		}
		if !cancelled {
			return true, ctx.Err()
		}
		return true, finishCancelled()
	}
	cancelled, err := s.mediaCleanupRunCancelled(statusCtx, runID)
	if err != nil {
		return true, err
	}
	if cancelled {
		return true, finishCancelled()
	}
	return false, nil
}

func (s *Server) processMediaCleanupTargets(
	ctx context.Context,
	statusCtx context.Context,
	job workflowJobRecord,
	payload mediaCleanupJobPayload,
	checkpoint *mediaCleanupCheckpoint,
	completed map[string]bool,
	finishCancelled func() error,
) (bool, error) {
	for index, target := range payload.Targets {
		if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
			return true, err
		}
		key := mediaCleanupTargetKey(target)
		if index < checkpoint.CompletedCount || completed[key] {
			if checkpoint.CompletedCount < index+1 {
				checkpoint.CompletedCount = index + 1
			}
			continue
		}
		if target.Kind == "local_root" && target.FolderID > 0 {
			if err := s.claimMediaCleanupFolder(statusCtx, target, job.RunID); err != nil {
				return true, s.failMediaCleanupTarget(statusCtx, job, err)
			}
		}
		target.CleanupRunID = job.RunID
		didDelete, err := s.clearMediaCleanupTarget(statusCtx, target)
		if err != nil {
			if stopped, stopErr := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
				return true, stopErr
			}
			return true, s.failMediaCleanupTarget(statusCtx, job, err)
		}
		if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
			return true, err
		}
		if didDelete {
			checkpoint.Deleted++
		}
		completed[key] = true
		checkpoint.CompletedCount = index + 1
		checkpoint.CompletedKeys = append(checkpoint.CompletedKeys, key)
		if err := s.updateWorkflowJobCheckpoint(statusCtx, job.ID, "cleanup", *checkpoint, index+1, len(payload.Targets)); err != nil {
			return true, s.failMediaCleanupTarget(statusCtx, job, err)
		}
	}
	return false, nil
}

func (s *Server) clearMediaCleanupTarget(ctx context.Context, target mediaCleanupTarget) (bool, error) {
	switch target.Kind {
	case "cache":
		_, deleted, err := s.clearCacheLocation(ctx, target.LocationID, target.Path)
		return deleted, err
	case "local_root":
		return s.clearLocalWorkRoot(ctx, target)
	default:
		return s.clearLocalMediaLocation(ctx, target.LocationID, target.Path)
	}
}

func (s *Server) failMediaCleanupTarget(ctx context.Context, job workflowJobRecord, err error) error {
	_ = s.restoreMediaCleanupFolders(ctx, job.RunID)
	_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
	return err
}

func mediaCleanupForgetWorkIDs(payload mediaCleanupJobPayload) ([]int64, error) {
	if payload.Mode != mediaCleanupForgetWork {
		return nil, nil
	}
	uniqueWorkIDs := map[int64]struct{}{}
	for _, target := range payload.Targets {
		if target.WorkID <= 0 {
			return nil, fmt.Errorf("forget work target is missing its work")
		}
		uniqueWorkIDs[target.WorkID] = struct{}{}
	}
	if len(uniqueWorkIDs) != 1 {
		return nil, fmt.Errorf("forget work can target only one work")
	}
	workIDs := make([]int64, 0, len(uniqueWorkIDs))
	for workID := range uniqueWorkIDs {
		workIDs = append(workIDs, workID)
	}
	return workIDs, nil
}

func (s *Server) finishMediaCleanupExecution(
	ctx context.Context,
	job workflowJobRecord,
	payload mediaCleanupJobPayload,
	checkpoint mediaCleanupCheckpoint,
	workIDs []int64,
	finishCancelled func() error,
) error {
	fileOutput := map[string]any{"locations": len(payload.Targets), "deleted": checkpoint.Deleted}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		_ = s.restoreMediaCleanupFolders(ctx, job.RunID)
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var runStatus string
	if err := tx.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", job.RunID).Scan(&runStatus); err != nil {
		_ = s.restoreMediaCleanupFolders(ctx, job.RunID)
		return err
	}
	if runStatus == "cancelled" {
		_ = tx.Rollback()
		return finishCancelled()
	}
	if payload.Mode == mediaCleanupFilesOnly {
		return s.finishMediaCleanupFilesOnly(ctx, tx, job, fileOutput, finishCancelled)
	}
	return s.finishMediaCleanupForget(ctx, tx, job, payload, checkpoint, workIDs, fileOutput, finishCancelled)
}

func (s *Server) finishMediaCleanupFilesOnly(
	ctx context.Context,
	tx *sql.Tx,
	job workflowJobRecord,
	fileOutput map[string]any,
	finishCancelled func() error,
) error {
	output := mustJSON(fileOutput)
	updates := []struct {
		query string
		args  []any
	}{
		{"UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{output, job.NodeRunID}},
		{"UPDATE workflow_job SET status = 'succeeded', progress_current = progress_total, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", []any{job.ID}},
		{"UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{output, job.RunID}},
	}
	for _, update := range updates {
		affected, err := execMediaCleanupUpdate(ctx, tx, update.query, update.args...)
		if err != nil {
			return err
		}
		if !affected {
			_ = tx.Rollback()
			return finishCancelled()
		}
	}
	if err := tx.Commit(); err != nil {
		_ = s.restoreMediaCleanupFolders(ctx, job.RunID)
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	return nil
}

func execMediaCleanupUpdate(ctx context.Context, tx *sql.Tx, query string, args ...any) (bool, error) {
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

type mediaCleanupForgetResult struct {
	purge          unlinkedWorkDeleteResult
	forgetNodeID   int64
	status         string
	forgetOutput   map[string]any
	combinedOutput map[string]any
}

func (s *Server) prepareMediaCleanupForget(
	ctx context.Context,
	tx *sql.Tx,
	job workflowJobRecord,
	payload mediaCleanupJobPayload,
	checkpoint mediaCleanupCheckpoint,
	workIDs []int64,
) (mediaCleanupForgetResult, error) {
	purge, err := s.deleteUnlinkedWorkFamiliesTx(ctx, tx, workIDs)
	if err != nil {
		return mediaCleanupForgetResult{}, err
	}
	if err := insertUnlinkedWorkDeleteAudit(ctx, tx, payload.ActorUserID, purge, checkpoint.Deleted > 0, mediaCleanupForgetAuditAction); err != nil {
		return mediaCleanupForgetResult{}, err
	}
	forgetNodeID := payload.ForgetNodeID
	if forgetNodeID <= 0 {
		if err := tx.QueryRowContext(ctx, `SELECT id FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'forget' LIMIT 1`, job.RunID).Scan(&forgetNodeID); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return mediaCleanupForgetResult{}, err
		}
	}
	partial := len(purge.Skipped) > 0
	status := "succeeded"
	if partial {
		status = "partial"
	}
	forgetOutput := map[string]any{
		"forgotten_family_count": purge.DeletedFamilyCount,
		"forgotten_work_count":   purge.DeletedWorkCount,
		"forgotten_work_ids":     purge.DeletedWorkIDs,
		"deleted_codes":          purge.DeletedCodes,
		"skipped":                purge.Skipped,
	}
	combinedOutput := map[string]any{
		"mode":                   string(payload.Mode),
		"locations":              len(payload.Targets),
		"deleted":                checkpoint.Deleted,
		"work_forgotten":         purge.DeletedFamilyCount > 0,
		"forgotten_family_count": purge.DeletedFamilyCount,
		"forgotten_work_count":   purge.DeletedWorkCount,
		"forgotten_work_ids":     purge.DeletedWorkIDs,
		"deleted_codes":          purge.DeletedCodes,
		"skipped":                purge.Skipped,
	}
	return mediaCleanupForgetResult{
		purge: purge, forgetNodeID: forgetNodeID, status: status,
		forgetOutput: forgetOutput, combinedOutput: combinedOutput,
	}, nil
}

func (s *Server) finishMediaCleanupForget(
	ctx context.Context,
	tx *sql.Tx,
	job workflowJobRecord,
	payload mediaCleanupJobPayload,
	checkpoint mediaCleanupCheckpoint,
	workIDs []int64,
	fileOutput map[string]any,
	finishCancelled func() error,
) error {
	result, err := s.prepareMediaCleanupForget(ctx, tx, job, payload, checkpoint, workIDs)
	if err != nil {
		return err
	}
	updates := []struct {
		query string
		args  []any
	}{
		{"UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{mustJSON(fileOutput), job.NodeRunID}},
		{"UPDATE workflow_job SET status = 'succeeded', progress_current = progress_total, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", []any{job.ID}},
	}
	for _, update := range updates {
		affected, err := execMediaCleanupUpdate(ctx, tx, update.query, update.args...)
		if err != nil {
			return err
		}
		if !affected {
			_ = tx.Rollback()
			return finishCancelled()
		}
	}
	if result.forgetNodeID > 0 {
		affected, err := execMediaCleanupUpdate(ctx, tx, "UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", result.status, mustJSON(result.forgetOutput), result.forgetNodeID)
		if err != nil {
			return err
		}
		if !affected {
			_ = tx.Rollback()
			return finishCancelled()
		}
	}
	if len(result.purge.Skipped) > 0 {
		if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
			NodeRunID: result.forgetNodeID, JobID: job.ID, Level: "warn", Type: "media_cleanup.work_retained",
			Message: "Files were deleted, but the work was retained because another source is still available",
			Detail:  map[string]any{"skipped": result.purge.Skipped, "work_ids": workIDs},
		}); err != nil {
			return err
		}
	}
	affected, err := execMediaCleanupUpdate(ctx, tx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", result.status, mustJSON(result.combinedOutput), job.RunID)
	if err != nil {
		return err
	}
	if !affected {
		_ = tx.Rollback()
		return finishCancelled()
	}
	if err := tx.Commit(); err != nil {
		_ = s.restoreMediaCleanupFolders(ctx, job.RunID)
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	return nil
}

func (s *Server) clearLocalWorkRoot(ctx context.Context, target mediaCleanupTarget) (bool, error) {
	rootPath, err := validateDestructiveDirectoryTree(s.cfg.DataRoot, target.Path)
	if err != nil {
		return false, err
	}
	directories, err := collectLocalWorkRootDirectories(rootPath)
	if err != nil {
		return false, err
	}
	deleted, err := s.removeLocalWorkRootDirectories(rootPath, directories)
	if err != nil {
		return false, err
	}
	if err := s.markLocalWorkRootUnavailable(ctx, target); err != nil {
		return false, err
	}
	return deleted, nil
}

func collectLocalWorkRootDirectories(rootPath string) ([]string, error) {
	directories := []string{}
	err := filepath.WalkDir(rootPath, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) && path == rootPath {
				return nil
			}
			return walkErr
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return infoErr
		}
		if unsafeFetchStagingEntry(info) || !entry.IsDir() {
			return fmt.Errorf("local work root still contains %s", filepath.ToSlash(path))
		}
		directories = append(directories, path)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(directories, func(i, j int) bool { return len(directories[i]) > len(directories[j]) })
	return directories, nil
}

func (s *Server) removeLocalWorkRootDirectories(rootPath string, directories []string) (bool, error) {
	deleted := false
	for _, directory := range directories {
		if _, err := validateDestructivePath(s.cfg.DataRoot, relativeDataPath(s.cfg.DataRoot, directory), false, true); err != nil {
			return false, err
		}
		if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, err
		} else if err == nil && directory == rootPath {
			deleted = true
		}
	}
	return deleted, nil
}

func (s *Server) markLocalWorkRootUnavailable(ctx context.Context, target mediaCleanupTarget) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	root := normalizeFolderRootPath(target.Path)
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable', last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ? AND location_type = 'local'
			AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
			AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
	`, target.SourceID, target.WorkID, root, root, root); err != nil {
		return err
	}
	if target.FolderID > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_folder_location
			SET state = 'ignored', cleanup_run_id = NULL, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND work_id = ? AND file_source_id = ? AND root_path = ?
				AND state = 'pending_cleanup'
				AND (cleanup_run_id = ? OR (? = 0 AND cleanup_run_id IS NULL))
		`, target.FolderID, target.WorkID, target.SourceID, root, target.CleanupRunID, target.CleanupRunID); err != nil {
			return err
		}
	}
	var available int
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			WHERE item.work_id = ? AND location.file_source_id = ?
			AND location.location_type = 'local' AND location.availability = 'available'
		) OR EXISTS (
			SELECT 1 FROM work_folder_location
			WHERE work_id = ? AND file_source_id = ? AND state = 'active'
		)
	`, target.WorkID, target.SourceID, target.WorkID, target.SourceID).Scan(&available); err != nil {
		return err
	}
	remainingRoot := ""
	_ = tx.QueryRowContext(ctx, `
		SELECT root_path FROM work_folder_location
		WHERE work_id = ? AND file_source_id = ? AND state = 'active'
		ORDER BY is_primary DESC, updated_at DESC, id ASC LIMIT 1
	`, target.WorkID, target.SourceID).Scan(&remainingRoot)
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET availability = CASE WHEN ? <> 0 THEN 'available' ELSE 'unavailable' END,
			source_url = CASE WHEN ? <> '' THEN ? ELSE source_url END,
			last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
	`, available, remainingRoot, remainingRoot, target.WorkID, target.SourceID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return nil
}

func (s *Server) clearLocalMediaLocation(ctx context.Context, locationID int64, relPath string) (bool, error) {
	deleted, _, err := removeDestructiveFile(s.cfg.DataRoot, relPath)
	if err != nil {
		return false, err
	}
	err = withDatabaseBusyRetry(ctx, func() error {
		_, err := s.db.ExecContext(ctx, `UPDATE media_file_location SET availability = 'unavailable',
		last_checked_at = CURRENT_TIMESTAMP WHERE id = ? AND location_type = 'local'`, locationID)
		return err
	})
	return deleted, err
}

func mediaCleanupTargetKey(target mediaCleanupTarget) string {
	if target.Kind == "local_root" && target.FolderID > 0 {
		return fmt.Sprintf("%s:folder:%d", target.Kind, target.FolderID)
	}
	return fmt.Sprintf("%s:%d", target.Kind, target.LocationID)
}
