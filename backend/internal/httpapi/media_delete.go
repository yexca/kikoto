package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

func (s *Server) deleteMediaCacheLocation(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	result, err := s.enqueueMediaLocationCleanup(r.Context(), []mediaCleanupTargetRequest{{Kind: "cache", LocationID: id}})
	if err != nil {
		writeMediaCleanupError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) deleteMediaLocalLocation(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	result, err := s.enqueueMediaLocationCleanup(r.Context(), []mediaCleanupTargetRequest{{Kind: "local", LocationID: id}})
	if err != nil {
		writeMediaCleanupError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type mediaCacheCleanupJobPayload struct {
	CacheLocationID int64  `json:"cache_location_id"`
	CachePath       string `json:"cache_path"`
}

type localMediaDeleteJobPayload struct {
	LocalLocationID int64  `json:"local_location_id"`
	Path            string `json:"path"`
}

func (s *Server) clearCacheLocation(ctx context.Context, cacheLocationID int64, cachePath string) (int64, bool, error) {
	releaseCacheLock, err := s.acquireCachePathLock(ctx, cachePath)
	if err != nil {
		return 0, false, err
	}
	defer releaseCacheLock()
	return s.clearCacheLocationUnlocked(ctx, cacheLocationID, cachePath)
}

func (s *Server) clearCacheLocationUnlocked(ctx context.Context, cacheLocationID int64, cachePath string) (int64, bool, error) {
	targetPath, err := validateDestructivePath(s.cfg.CacheRoot, cachePath, true, false)
	if err != nil {
		return 0, false, err
	}
	var bytes int64
	if info, err := os.Lstat(targetPath); err == nil {
		if unsafeFetchStagingEntry(info) || info.IsDir() {
			return 0, false, fmt.Errorf("refusing to delete unsafe cache target %s", filepath.ToSlash(cachePath))
		}
		bytes = info.Size()
	}
	// Revalidate immediately before the unlink to reduce the window for a
	// parent replacement after the initial component walk.
	if _, err := validateDestructivePath(s.cfg.CacheRoot, cachePath, true, false); err != nil {
		return 0, false, err
	}
	deleted := false
	if err := os.Remove(targetPath); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return bytes, false, err
		}
	} else {
		deleted = true
	}
	if err := pruneEmptyCacheParents(s.cfg.CacheRoot, filepath.Dir(targetPath)); err != nil {
		return bytes, deleted, err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND location_type = 'cache'
	`, cacheLocationID)
	return bytes, deleted, err
}

type mediaLocalDeleteResult struct {
	RunID             int64  `json:"runId"`
	LocationID        int64  `json:"locationId"`
	WorkID            int64  `json:"workId"`
	Path              string `json:"path"`
	Status            string `json:"status"`
	Deleted           bool   `json:"deleted"`
	ClearedProgress   int64  `json:"clearedProgress"`
	ClearedWorkStates int64  `json:"clearedWorkStates"`
}

type symlinkMediaLocationError struct {
	RunID       int64
	CandidateID int64
	Path        string
}

func (err symlinkMediaLocationError) Error() string {
	return fmt.Sprintf("local media path %s is a symlink; review the location before deleting", filepath.ToSlash(err.Path))
}

func (s *Server) executeMediaCacheCleanupJob(ctx context.Context, job workflowJobRecord) error {
	var payload mediaCacheCleanupJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_, deleted, err := s.clearCacheLocation(ctx, payload.CacheLocationID, payload.CachePath)
	status, message := "succeeded", ""
	if err != nil {
		status, message = "failed", err.Error()
	}
	if finishErr := s.finishMediaCacheCleanup(ctx, job.RunID, job.NodeRunID, job.ID, status, payload.CacheLocationID, payload.CachePath, deleted, message); finishErr != nil {
		return finishErr
	}
	return err
}

func (s *Server) runLocalMediaDelete(ctx context.Context, localLocationID int64) (mediaLocalDeleteResult, error) {
	target, err := s.loadLocalMediaDeleteTarget(ctx, localLocationID)
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	if target.Symlink {
		runID, candidateID, err := s.createSymlinkMediaReview(ctx, target.LocationID, target.MediaItemID, target.WorkID, target.SourceID, target.RelPath)
		if err != nil {
			return mediaLocalDeleteResult{}, err
		}
		return mediaLocalDeleteResult{}, symlinkMediaLocationError{RunID: runID, CandidateID: candidateID, Path: target.RelPath}
	}
	runID, deleteNodeID, jobID, err := s.createLocalMediaDeleteWorkflow(ctx, target)
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	return s.performLocalMediaDelete(ctx, target, runID, deleteNodeID, jobID)
}

type localMediaDeleteTarget struct {
	LocationID   int64
	MediaItemID  int64
	WorkID       int64
	SourceID     int64
	RelPath      string
	Availability string
	Symlink      bool
}

func (s *Server) loadLocalMediaDeleteTarget(ctx context.Context, localLocationID int64) (localMediaDeleteTarget, error) {
	var mediaItemID int64
	var workID int64
	var sourceID int64
	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.media_item_id, item.work_id, location.file_source_id, location.location_type, location.path, location.availability
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
	`, localLocationID).Scan(&mediaItemID, &workID, &sourceID, &locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return localMediaDeleteTarget{}, fmt.Errorf("local media location not found")
		}
		return localMediaDeleteTarget{}, err
	}
	if locationType != "local" {
		return localMediaDeleteTarget{}, fmt.Errorf("media location is not a local file")
	}
	targetPath, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		return localMediaDeleteTarget{}, err
	}
	symlink := isSymlinkPath(targetPath)
	return localMediaDeleteTarget{
		LocationID: localLocationID, MediaItemID: mediaItemID, WorkID: workID, SourceID: sourceID, RelPath: relPath,
		Availability: availability, Symlink: symlink,
	}, validateLocalMediaDeletePath(s.cfg.DataRoot, relPath, symlink)
}

func validateLocalMediaDeletePath(dataRoot, relPath string, symlink bool) error {
	if symlink {
		return nil
	}
	_, err := validateDestructivePath(dataRoot, relPath, true, false)
	return err
}

func (s *Server) createLocalMediaDeleteWorkflow(ctx context.Context, target localMediaDeleteTarget) (int64, int64, int64, error) {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return 0, 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_media_delete", "Delete local media", "Delete a local media file and mark only that file location unavailable.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "delete", "type": "delete_local_media"},
		},
	})
	if err != nil {
		return 0, 0, 0, err
	}
	input := map[string]any{"local_location_id": target.LocationID, "media_item_id": target.MediaItemID, "work_id": target.WorkID, "source_id": target.SourceID, "path": target.RelPath}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "local_media_delete", "Delete local media", "queued", "manual", "delete_local", input, map[string]any{"path": target.RelPath})
	if err != nil {
		return 0, 0, 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select local media", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"availability": target.Availability},
	}); err != nil {
		return 0, 0, 0, err
	}
	deleteNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "delete", NodeType: "delete_local_media", DisplayName: "Delete local file", Position: 2, Status: "queued",
		Input: input, Output: nil,
	})
	if err != nil {
		return 0, 0, 0, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: deleteNodeID, WorkerType: "local_media_delete", Status: "queued", ResourceKey: "media:cleanup", Payload: input,
		Checkpoint: map[string]any{"phase": "pending"}, Recoverable: true, MaxRetries: 3, ProgressCurrent: 0, ProgressTotal: 1,
	})
	if err != nil {
		return 0, 0, 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, 0, err
	}
	return runID, deleteNodeID, jobID, nil
}

func (s *Server) performLocalMediaDelete(ctx context.Context, target localMediaDeleteTarget, runID, deleteNodeID, jobID int64) (mediaLocalDeleteResult, error) {
	jobCtx, stopHeartbeat, err := s.leaseInlineWorkflowJob(ctx, workflowJobRecord{ID: jobID, RunID: runID, NodeRunID: deleteNodeID})
	if errors.Is(err, errWorkflowJobQueued) {
		return mediaLocalDeleteResult{RunID: runID, LocationID: target.LocationID, WorkID: target.WorkID, Status: "queued"}, nil
	}
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	defer stopHeartbeat()

	deleted, _, err := removeDestructiveFile(s.cfg.DataRoot, target.RelPath)
	if err != nil {
		_ = s.finishLocalMediaDelete(jobCtx, runID, deleteNodeID, jobID, "failed", target.LocationID, target.RelPath, deleted, err.Error())
		return mediaLocalDeleteResult{}, err
	}
	if _, err := s.db.ExecContext(jobCtx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND location_type = 'local'
	`, target.LocationID); err != nil {
		_ = s.finishLocalMediaDelete(jobCtx, runID, deleteNodeID, jobID, "failed", target.LocationID, target.RelPath, deleted, err.Error())
		return mediaLocalDeleteResult{}, err
	}
	if err := s.finishLocalMediaDelete(jobCtx, runID, deleteNodeID, jobID, "succeeded", target.LocationID, target.RelPath, deleted, ""); err != nil {
		return mediaLocalDeleteResult{}, err
	}
	return mediaLocalDeleteResult{
		RunID:             runID,
		LocationID:        target.LocationID,
		WorkID:            target.WorkID,
		Path:              target.RelPath,
		Status:            "succeeded",
		Deleted:           deleted,
		ClearedProgress:   0,
		ClearedWorkStates: 0,
	}, nil
}

func (s *Server) executeLocalMediaDeleteJob(ctx context.Context, job workflowJobRecord) error {
	var payload localMediaDeleteJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	deleted := false
	deleted, _, err := removeDestructiveFile(s.cfg.DataRoot, payload.Path)
	if err == nil {
		_, err = s.db.ExecContext(ctx, `
			UPDATE media_file_location
			SET availability = 'unavailable', last_checked_at = CURRENT_TIMESTAMP
			WHERE id = ? AND location_type = 'local'
		`, payload.LocalLocationID)
	}
	status, message := "succeeded", ""
	if err != nil {
		status, message = "failed", err.Error()
	}
	if finishErr := s.finishLocalMediaDelete(ctx, job.RunID, job.NodeRunID, job.ID, status, payload.LocalLocationID, payload.Path, deleted, message); finishErr != nil {
		return finishErr
	}
	return err
}

func isSymlinkPath(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && unsafeFetchStagingEntry(info)
}

func (s *Server) createSymlinkMediaReview(ctx context.Context, localLocationID int64, mediaItemID int64, workID int64, sourceID int64, relPath string) (int64, int64, error) {
	externalKey := symlinkMediaReviewExternalKey(localLocationID, relPath)
	var existingRunID int64
	var existingCandidateID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT workflow_run_id, id
		FROM workflow_candidate
		WHERE candidate_type = 'local_symlink_media_location'
			AND external_key = ?
			AND status = 'pending'
		ORDER BY updated_at DESC, id DESC
		LIMIT 1
	`, externalKey).Scan(&existingRunID, &existingCandidateID); err == nil {
		return existingRunID, existingCandidateID, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, 0, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_symlink_review", "Review local symlink", "Notify users when a local media delete request targets a symlink.", map[string]any{
		"nodes": []map[string]string{
			{"id": "detect", "type": "filter_candidates"},
			{"id": "review", "type": "filter_candidates"},
		},
	})
	if err != nil {
		return 0, 0, err
	}
	input := map[string]any{
		"local_location_id": localLocationID,
		"media_item_id":     mediaItemID,
		"work_id":           workID,
		"source_id":         sourceID,
		"path":              relPath,
		"reason":            "symlink_delete_blocked",
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "local_symlink_review", "Review local symlink", "skipped", "manual", "delete_local", input, map[string]any{"path": relPath, "reason": "symlink_delete_blocked"})
	if err != nil {
		return 0, 0, err
	}
	detectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "detect", NodeType: "filter_candidates", DisplayName: "Detect symlink media", Position: 1, Status: "skipped",
		Input: input, Output: map[string]any{"blocked": true, "path": relPath, "reason": "symlink_delete_blocked"},
	})
	if err != nil {
		return 0, 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "review", NodeType: "filter_candidates", DisplayName: "Review symlink location", Position: 2, Status: "skipped",
		Input: input, Output: map[string]any{"candidate_status": "pending"},
	}); err != nil {
		return 0, 0, err
	}
	candidatePayload := map[string]any{
		"local_location_id":      localLocationID,
		"media_item_id":          mediaItemID,
		"work_id":                workID,
		"source_id":              sourceID,
		"path":                   relPath,
		"message":                "Delete was blocked because this local media path is a symlink. The link and its target were left untouched.",
		"recommended_action":     "Resolve or ignore this review item after checking the linked file.",
		"candidate_location_ids": []int64{localLocationID},
		"candidate_locations": []map[string]any{{
			"location_id": localLocationID,
			"path":        relPath,
			"reason":      "symlink_delete_blocked",
		}},
	}
	candidateID, err := sqlutil.InsertID(ctx, tx, `
		INSERT INTO workflow_candidate (workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, ?, 'local_symlink_media_location', ?, 'pending', ?)
	`, runID, detectNodeID, externalKey, mustJSON(candidatePayload))
	if err != nil {
		return 0, 0, err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		NodeRunID: detectNodeID,
		Level:     "warn",
		Type:      "candidate.symlink_media_location",
		Message:   "Local media delete blocked for symlink",
		Detail:    candidatePayload,
	}); err != nil {
		return 0, 0, err
	}
	return runID, candidateID, tx.Commit()
}

func symlinkMediaReviewExternalKey(localLocationID int64, relPath string) string {
	return fmt.Sprintf("location:%d:%s", localLocationID, filepath.ToSlash(relPath))
}

func (s *Server) finishLocalMediaDelete(ctx context.Context, runID int64, deleteNodeID int64, jobID int64, status string, locationID int64, relPath string, deleted bool, errorMessage string) error {
	output := mustJSON(map[string]any{
		"location_id":          locationID,
		"path":                 relPath,
		"deleted":              deleted,
		"preserved_user_state": true,
		"error":                errorMessage,
	})
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, errorMessage, deleteNodeID); err != nil {
		return err
	}
	progress := 1
	if status != "succeeded" {
		progress = 0
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, progress_current = ?, progress_total = 1, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, progress, errorMessage, jobID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, runID)
	return err
}

func (s *Server) finishMediaCacheCleanup(ctx context.Context, runID int64, nodeID int64, jobID int64, status string, cacheLocationID int64, cachePath string, deleted bool, errorMessage string) error {
	output := mustJSON(map[string]any{"cache_location_id": cacheLocationID, "cache_path": cachePath, "deleted": deleted, "error": errorMessage})
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?,
			output_json = ?,
			error_message = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, output, errorMessage, nodeID); err != nil {
		return err
	}
	progress := 1
	if status != "succeeded" {
		progress = 0
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?,
			progress_current = ?,
			progress_total = 1,
			error_message = ?,
			locked_by = '',
			locked_at = NULL,
			heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, progress, errorMessage, jobID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = ?,
			summary_json = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, output, runID)
	return err
}
