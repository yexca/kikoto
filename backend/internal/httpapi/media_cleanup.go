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

type mediaCleanupTargetRequest struct {
	Kind       string `json:"kind"`
	LocationID int64  `json:"locationId"`
}

type mediaCleanupRequest struct {
	Targets []mediaCleanupTargetRequest `json:"targets"`
}

type mediaCleanupTarget struct {
	Kind        string `json:"kind"`
	LocationID  int64  `json:"locationId"`
	MediaItemID int64  `json:"mediaItemId"`
	WorkID      int64  `json:"workId"`
	SourceID    int64  `json:"sourceId"`
	Path        string `json:"path"`
}

type mediaCleanupJobPayload struct {
	Targets []mediaCleanupTarget `json:"targets"`
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

func (s *Server) cleanupMediaLocations(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	var request mediaCleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	result, err := s.enqueueMediaLocationCleanup(r.Context(), request.Targets)
	if err != nil {
		writeMediaCleanupError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func writeMediaCleanupError(w http.ResponseWriter, err error) {
	var symlinkErr symlinkMediaLocationError
	if errors.As(err, &symlinkErr) {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": err.Error(), "runId": symlinkErr.RunID, "candidateId": symlinkErr.CandidateID,
		})
		return
	}
	writeError(w, err)
}

func (s *Server) enqueueMediaLocationCleanup(ctx context.Context, requested []mediaCleanupTargetRequest) (mediaCleanupResult, error) {
	if len(requested) == 0 {
		return mediaCleanupResult{}, fmt.Errorf("at least one media location is required")
	}
	if len(requested) > maxMediaCleanupTargets {
		return mediaCleanupResult{}, fmt.Errorf("at most %d media locations can be cleaned at once", maxMediaCleanupTargets)
	}
	targets := make([]mediaCleanupTarget, 0, len(requested))
	seen := map[string]bool{}
	for _, item := range requested {
		target, err := s.loadMediaCleanupTarget(ctx, item)
		if err != nil {
			return mediaCleanupResult{}, err
		}
		key := mediaCleanupTargetKey(target)
		if seen[key] {
			continue
		}
		seen[key] = true
		targets = append(targets, target)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return mediaCleanupResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definition := map[string]any{"nodes": []map[string]string{
		{"id": "select", "type": "select_media_items"},
		{"id": "cleanup", "type": "cleanup_media_locations"},
	}}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "media_location_cleanup", "Clean media locations", "Delete selected cache or local files and mark their locations unavailable.", definition)
	if err != nil {
		return mediaCleanupResult{}, err
	}
	payload := mediaCleanupJobPayload{Targets: targets}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "media_location_cleanup", "Clean media locations", "queued", "manual", "delete_selected", payload, map[string]any{"locations": len(targets)})
	if err != nil {
		return mediaCleanupResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select media locations", Position: 1, Status: "succeeded",
		Input: payload, Output: map[string]any{"locations": len(targets)},
	}); err != nil {
		return mediaCleanupResult{}, err
	}
	cleanupNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cleanup", NodeType: "cleanup_media_locations", DisplayName: "Delete media files", Position: 2, Status: "queued", Input: payload,
	})
	if err != nil {
		return mediaCleanupResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cleanupNodeID, WorkerType: "media_location_cleanup", Status: "queued", Payload: payload,
		Checkpoint: mediaCleanupCheckpoint{CompletedKeys: []string{}}, Recoverable: true, MaxRetries: 3,
		ProgressCurrent: 0, ProgressTotal: len(targets),
	})
	if err != nil {
		return mediaCleanupResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return mediaCleanupResult{}, err
	}
	return mediaCleanupResult{RunID: runID, JobID: jobID, Status: "queued", Queued: len(targets)}, nil
}

func (s *Server) loadMediaCleanupTarget(ctx context.Context, requested mediaCleanupTargetRequest) (mediaCleanupTarget, error) {
	requested.Kind = strings.TrimSpace(requested.Kind)
	if requested.LocationID <= 0 || (requested.Kind != "cache" && requested.Kind != "local" && requested.Kind != "local_root") {
		return mediaCleanupTarget{}, fmt.Errorf("invalid media cleanup target")
	}
	var target mediaCleanupTarget
	var locationType string
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.id, location.media_item_id, item.work_id, location.file_source_id,
			location.location_type, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
	`, requested.LocationID).Scan(&target.LocationID, &target.MediaItemID, &target.WorkID, &target.SourceID, &locationType, &target.Path); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaCleanupTarget{}, fmt.Errorf("media location not found")
		}
		return mediaCleanupTarget{}, err
	}
	if requested.Kind == "local_root" && locationType == "local" {
		target.Kind = requested.Kind
		if err := s.db.QueryRowContext(ctx, `
			SELECT source_url
			FROM work_source_presence
			WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
			LIMIT 1
		`, target.WorkID, target.SourceID).Scan(&target.Path); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return mediaCleanupTarget{}, fmt.Errorf("local work root not found")
			}
			return mediaCleanupTarget{}, err
		}
		rootPath, err := safeDataPath(s.cfg.DataRoot, target.Path)
		if err != nil {
			return mediaCleanupTarget{}, err
		}
		if isSymlinkPath(rootPath) {
			return mediaCleanupTarget{}, fmt.Errorf("refusing to delete symlink %s", filepath.ToSlash(target.Path))
		}
		return target, nil
	}
	if locationType != requested.Kind {
		return mediaCleanupTarget{}, fmt.Errorf("media location %d is not %s", requested.LocationID, requested.Kind)
	}
	target.Kind = locationType
	if target.Kind == "cache" {
		if _, err := safeCachePath(s.cfg.CacheRoot, target.Path); err != nil {
			return mediaCleanupTarget{}, err
		}
		return target, nil
	}
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
	if info, err := os.Stat(targetPath); err == nil && info.IsDir() {
		return mediaCleanupTarget{}, fmt.Errorf("refusing to delete directory %s", filepath.ToSlash(target.Path))
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return mediaCleanupTarget{}, err
	}
	return target, nil
}

func (s *Server) executeMediaLocationCleanupJob(ctx context.Context, job workflowJobRecord) error {
	var payload mediaCleanupJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint := mediaCleanupCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	completed := map[string]bool{}
	for _, key := range checkpoint.CompletedKeys {
		completed[key] = true
	}
	for index, target := range payload.Targets {
		key := mediaCleanupTargetKey(target)
		if index < checkpoint.CompletedCount || completed[key] {
			if checkpoint.CompletedCount < index+1 {
				checkpoint.CompletedCount = index + 1
			}
			continue
		}
		var didDelete bool
		var err error
		if target.Kind == "cache" {
			_, didDelete, err = s.clearCacheLocation(ctx, target.LocationID, target.Path)
		} else if target.Kind == "local_root" {
			didDelete, err = s.clearLocalWorkRoot(ctx, target)
		} else {
			didDelete, err = s.clearLocalMediaLocation(ctx, target.LocationID, target.Path)
		}
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		if didDelete {
			checkpoint.Deleted++
		}
		completed[key] = true
		checkpoint.CompletedCount = index + 1
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "cleanup", checkpoint, index+1, len(payload.Targets))
	}
	output := mustJSON(map[string]any{"locations": len(payload.Targets), "deleted": checkpoint.Deleted})
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", output, job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_job SET status = 'succeeded', progress_current = progress_total,
		locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", output, job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) clearLocalWorkRoot(ctx context.Context, target mediaCleanupTarget) (bool, error) {
	rootPath, err := safeDataPath(s.cfg.DataRoot, target.Path)
	if err != nil {
		return false, err
	}
	directories := []string{}
	err = filepath.WalkDir(rootPath, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) && path == rootPath {
				return nil
			}
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() {
			return fmt.Errorf("local work root still contains %s", filepath.ToSlash(path))
		}
		directories = append(directories, path)
		return nil
	})
	if err != nil {
		return false, err
	}
	sort.Slice(directories, func(i, j int) bool { return len(directories[i]) > len(directories[j]) })
	deleted := false
	for _, directory := range directories {
		if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, err
		} else if err == nil && directory == rootPath {
			deleted = true
		}
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable', last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ? AND location_type = 'local'
			AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
	`, target.SourceID, target.WorkID); err != nil {
		return false, err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE work_source_presence
		SET availability = 'unavailable', last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
	`, target.WorkID, target.SourceID)
	return deleted, err
}

func (s *Server) clearLocalMediaLocation(ctx context.Context, locationID int64, relPath string) (bool, error) {
	targetPath, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		return false, err
	}
	if info, err := os.Lstat(targetPath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return false, fmt.Errorf("refusing to delete symlink %s", filepath.ToSlash(relPath))
		}
		if info.IsDir() {
			return false, fmt.Errorf("refusing to delete directory %s", filepath.ToSlash(relPath))
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	deleted := false
	if err := os.Remove(targetPath); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	} else {
		deleted = true
	}
	_, err = s.db.ExecContext(ctx, `UPDATE media_file_location SET availability = 'unavailable',
		last_checked_at = CURRENT_TIMESTAMP WHERE id = ? AND location_type = 'local'`, locationID)
	return deleted, err
}

func mediaCleanupTargetKey(target mediaCleanupTarget) string {
	return fmt.Sprintf("%s:%d", target.Kind, target.LocationID)
}
