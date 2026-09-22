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
	"strings"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

func (s *Server) cacheRemoteSourceWorkMedia(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "playback:use"); !ok {
		return
	}
	sourceID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	var payload struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	remotePath := cleanRemoteRelativePath(payload.Path)
	if remotePath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "remote path is required"})
		return
	}
	syncResult, err := s.runRemoteWorkSync(r.Context(), sourceID, code, "auto_cache_on_preview_play")
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	locationID, err := s.findRemoteMediaLocationByPath(r.Context(), syncResult.WorkID, sourceID, remotePath)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "remote media was not found", false)
		return
	}
	cacheResult, err := s.enqueueRemoteMediaCache(r.Context(), locationID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, cacheResult)
}

func (s *Server) findRemoteMediaLocationByPath(ctx context.Context, workID int64, sourceID int64, remotePath string) (int64, error) {
	remotePath = cleanRemoteRelativePath(remotePath)
	var id int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'remote_stream'
			AND location.availability = 'available'
			AND location.path = ?
		LIMIT 1
	`, workID, sourceID, remotePath).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, fmt.Errorf("remote media location not found")
		}
		return 0, err
	}
	return id, nil
}

type mediaCacheResult struct {
	RunID       int64  `json:"runId"`
	JobID       int64  `json:"jobId"`
	LocationID  int64  `json:"locationId"`
	CachePath   string `json:"cachePath"`
	Status      string `json:"status"`
	AlreadyDone bool   `json:"alreadyDone"`
}

type mediaCacheJobPayload struct {
	MediaLocationID int64 `json:"media_location_id"`
}

type mediaCacheTarget struct {
	RemoteLocationID int64
	MediaItemID      int64
	WorkCode         string
	SourceID         int64
	SourceCode       string
	RemotePath       string
	StreamURL        string
	DownloadURL      string
	RemoteHash       string
	SizeBytes        sql.NullInt64
	DurationSeconds  sql.NullInt64
	CachePath        string
}

func (s *Server) cacheMediaLocation(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "playback:use"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	result, err := s.enqueueRemoteMediaCache(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) loadMediaCacheTarget(ctx context.Context, remoteLocationID int64) (mediaCacheTarget, error) {
	var target mediaCacheTarget
	var locationType string
	var availability string
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			location.media_item_id,
			work.primary_code,
			source.id,
			source.code,
			location.location_type,
			location.path,
			location.stream_url,
			location.download_url,
			location.remote_hash,
			location.size_bytes,
			location.duration_seconds,
			location.availability
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE location.id = ?
	`, remoteLocationID).Scan(
		&target.MediaItemID,
		&target.WorkCode,
		&target.SourceID,
		&target.SourceCode,
		&locationType,
		&target.RemotePath,
		&target.StreamURL,
		&target.DownloadURL,
		&target.RemoteHash,
		&target.SizeBytes,
		&target.DurationSeconds,
		&availability,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaCacheTarget{}, fmt.Errorf("media location not found")
		}
		return mediaCacheTarget{}, err
	}
	if locationType != "remote_stream" || availability != "available" {
		return mediaCacheTarget{}, fmt.Errorf("media location is not an available remote stream")
	}
	if !s.settingBoolContext(ctx, "remote_cache_enabled", false) {
		return mediaCacheTarget{}, fmt.Errorf("remote cache is not enabled")
	}
	target.RemoteLocationID = remoteLocationID
	target.CachePath = cacheMediaRelPath(target.SourceCode, target.WorkCode, target.RemotePath)
	return target, nil
}

func (s *Server) enqueueRemoteMediaCache(ctx context.Context, remoteLocationID int64) (mediaCacheResult, error) {
	target, err := s.loadMediaCacheTarget(ctx, remoteLocationID)
	if err != nil {
		return mediaCacheResult{}, err
	}
	if cacheID, ok, err := s.findAvailableCacheLocation(ctx, target.MediaItemID, target.SourceID, target.CachePath, sqlutil.Int64(target.SizeBytes)); err != nil {
		return mediaCacheResult{}, err
	} else if ok {
		_, _ = s.runCacheLimitCleanup(ctx, target.SourceID, cacheID)
		return mediaCacheResult{LocationID: cacheID, CachePath: target.CachePath, Status: "succeeded", AlreadyDone: true}, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return mediaCacheResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "media_cache", "Cache media", "Select media items, filter cache misses, sync source state, and materialize cache files.", mediaCacheDefinition())
	if err != nil {
		return mediaCacheResult{}, err
	}
	runInput := mediaCacheJobPayload{MediaLocationID: remoteLocationID}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "media_cache", "Cache media", "queued", "playback", "auto_cache_on_play", map[string]any{"media_location_id": remoteLocationID, "media_item_id": target.MediaItemID, "source_id": target.SourceID, "source_code": target.SourceCode, "work_code": target.WorkCode}, map[string]any{"cache_path": target.CachePath})
	if err != nil {
		return mediaCacheResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select media item", Position: 1, Status: "succeeded",
		Input: runInput, Output: map[string]any{"media_item_id": target.MediaItemID, "remote_location_id": remoteLocationID},
	}); err != nil {
		return mediaCacheResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync remote location", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": target.WorkCode, "source_id": target.SourceID}, Output: map[string]any{"remote_location_id": remoteLocationID},
	}); err != nil {
		return mediaCacheResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter cache miss", Position: 3, Status: "succeeded",
		Input: map[string]any{"cache_path": target.CachePath}, Output: map[string]any{"cache_missing": true},
	}); err != nil {
		return mediaCacheResult{}, err
	}
	cacheNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cache", NodeType: "materialize_cache", DisplayName: "Materialize cache file", Position: 4, Status: "queued",
		Input: map[string]any{"download_url": firstNonEmpty(target.DownloadURL, target.StreamURL), "cache_path": target.CachePath}, Output: nil,
	})
	if err != nil {
		return mediaCacheResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cacheNodeID, WorkerType: "remote_media_cache", Status: "queued", Priority: workflow.JobPriorityPlayback, ResourceKey: sourceResourceKey(firstNonEmpty(target.DownloadURL, target.StreamURL)), Payload: runInput, Recoverable: true, MaxRetries: 5, ProgressCurrent: 0, ProgressTotal: 1,
	})
	if err != nil {
		return mediaCacheResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return mediaCacheResult{}, err
	}
	return mediaCacheResult{RunID: runID, JobID: jobID, CachePath: target.CachePath, Status: "queued"}, nil
}

func (s *Server) executeRemoteMediaCacheJob(ctx context.Context, job workflowJobRecord) error {
	var payload mediaCacheJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "resolve", map[string]any{"mediaLocationId": payload.MediaLocationID}, 0, 1)
	target, err := s.loadMediaCacheTarget(ctx, payload.MediaLocationID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	releaseCacheLock, err := s.acquireCachePathLock(ctx, target.CachePath)
	if err != nil {
		_ = s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "failed", target.CachePath, err.Error(), 0)
		return err
	}
	defer releaseCacheLock()
	if cacheID, ok, err := s.findAvailableCacheLocation(ctx, target.MediaItemID, target.SourceID, target.CachePath, sqlutil.Int64(target.SizeBytes)); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	} else if ok {
		if err := s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "succeeded", target.CachePath, "", 0); err != nil {
			return err
		}
		releaseCacheLock()
		_, _ = s.runCacheLimitCleanup(ctx, target.SourceID, cacheID)
		return nil
	}
	targetPath, err := safeCachePath(s.cfg.CacheRoot, target.CachePath)
	if err != nil {
		_ = s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "failed", target.CachePath, err.Error(), 0)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		_ = s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "failed", target.CachePath, err.Error(), 0)
		return err
	}
	if info, statErr := os.Stat(targetPath); statErr == nil && existingFileMatches(targetPath, sqlutil.Int64(target.SizeBytes)) {
		cacheLocationID, upsertErr := s.upsertCacheLocation(ctx, target.MediaItemID, target.SourceID, target.CachePath, target.RemoteHash, sqlutil.Int64(target.SizeBytes), sqlutil.Int64(target.DurationSeconds), info.Size())
		if upsertErr != nil {
			_ = s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "failed", target.CachePath, upsertErr.Error(), 0)
			return upsertErr
		}
		if finishErr := s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "succeeded", target.CachePath, "", info.Size()); finishErr != nil {
			return finishErr
		}
		releaseCacheLock()
		_, _ = s.runCacheLimitCleanup(ctx, target.SourceID, cacheLocationID)
		return nil
	}
	source, err := s.loadRemoteSourceForUse(ctx, target.SourceID)
	if err != nil {
		_ = s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "failed", target.CachePath, err.Error(), 0)
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "download", map[string]any{"cachePath": target.CachePath}, 0, 1)
	written, err := s.downloadToFile(ctx, source, firstNonEmpty(target.DownloadURL, target.StreamURL), targetPath, remoteDownloadOptions{
		MaxBytes: s.remoteMediaDownloadLimitBytes(ctx),
	})
	if err != nil {
		_ = s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "failed", target.CachePath, err.Error(), 0)
		return err
	}
	cacheLocationID, err := s.upsertCacheLocation(ctx, target.MediaItemID, target.SourceID, target.CachePath, target.RemoteHash, sqlutil.Int64(target.SizeBytes), sqlutil.Int64(target.DurationSeconds), written)
	if err != nil {
		_ = s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "failed", target.CachePath, err.Error(), 0)
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "register", map[string]any{"cachePath": target.CachePath, "bytes": written}, 1, 1)
	if err := s.finishMediaCacheRun(ctx, job.RunID, job.NodeRunID, job.ID, "succeeded", target.CachePath, "", written); err != nil {
		return err
	}
	releaseCacheLock()
	if cleanup, err := s.runCacheLimitCleanup(ctx, target.SourceID, cacheLocationID); err == nil && cleanup.Removed > 0 {
		s.execBestEffort(ctx, "record media cache cleanup summary", `
			UPDATE workflow_run
			SET summary_json = ?
			WHERE id = ?
		`, mustJSON(map[string]any{
			"cache_path":            target.CachePath,
			"bytes":                 written,
			"limit_cleanup_removed": cleanup.Removed,
			"limit_cleanup_freed":   cleanup.FreedBytes,
			"total_cache_after":     cleanup.TotalAfterBytes,
			"source_cache_after":    cleanup.SourceAfterBytes,
			"total_limit_gb":        cleanup.TotalLimitGB,
			"source_limit_gb":       cleanup.SourceLimitGB,
		}), job.RunID)
	}
	return nil
}

func mediaCacheDefinition() map[string]any {
	return map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "sync", "type": "sync_file_locations"},
			{"id": "filter", "type": "filter_candidates"},
			{"id": "cache", "type": "materialize_cache"},
		},
	}
}

func (s *Server) findAvailableCacheLocation(ctx context.Context, mediaItemID int64, sourceID int64, cacheRelPath string, expectedSize *int64) (int64, bool, error) {
	var id int64
	var path string
	if err := s.db.QueryRowContext(ctx, `
		SELECT id, path
		FROM media_file_location
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
			AND availability = 'available'
	`, mediaItemID, sourceID, cacheRelPath).Scan(&id, &path); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, err
	}
	cachePath, err := safeCachePath(s.cfg.CacheRoot, path)
	if err != nil {
		return 0, false, err
	}
	if !existingFileMatches(cachePath, expectedSize) {
		return 0, false, nil
	}
	s.execBestEffort(ctx, "touch cache location check time", `
		UPDATE media_file_location
		SET last_checked_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, id)
	return id, true, nil
}

func (s *Server) upsertCacheLocation(ctx context.Context, mediaItemID int64, sourceID int64, cacheRelPath string, remoteHash string, sizeBytes *int64, durationSeconds *int64, written int64) (int64, error) {
	sizeValue := any(sizeBytes)
	if sizeBytes == nil && written > 0 {
		sizeValue = written
	}
	var durationValue any
	if durationSeconds != nil {
		durationValue = *durationSeconds
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO media_file_location (
			media_item_id,
			file_source_id,
			location_type,
			path,
			remote_hash,
			size_bytes,
			duration_seconds,
			availability,
			last_checked_at
		)
		SELECT ?, ?, 'cache', ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'cache'
				AND path = ?
		)
	`, mediaItemID, sourceID, cacheRelPath, remoteHash, sizeValue, durationValue, mediaItemID, sourceID, cacheRelPath); err != nil {
		return 0, err
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET remote_hash = ?,
			size_bytes = ?,
			duration_seconds = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
	`, remoteHash, sizeValue, durationValue, mediaItemID, sourceID, cacheRelPath); err != nil {
		return 0, err
	}
	var id int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id
		FROM media_file_location
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
	`, mediaItemID, sourceID, cacheRelPath).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *Server) finishMediaCacheRun(ctx context.Context, runID int64, nodeID int64, jobID int64, status string, cacheRelPath string, errorMessage string, written int64) error {
	output := mustJSON(map[string]any{"cache_path": cacheRelPath, "bytes": written})
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
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = ?,
			summary_json = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, output, runID); err != nil {
		return err
	}
	return nil
}

func cacheMediaRelPath(sourceCode string, workCode string, remotePath string) string {
	cleanSource := sourceCodePattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(sourceCode)), "_")
	cleanSource = strings.Trim(cleanSource, "_")
	if cleanSource == "" {
		cleanSource = "remote"
	}
	workCode = strings.ToUpper(strings.TrimSpace(workCode))
	if workCode == "" {
		workCode = "UNKNOWN"
	}
	prefix, group := workCodeShard(workCode)
	parts := strings.Split(strings.ReplaceAll(remotePath, "\\", "/"), "/")
	cleanParts := []string{"media", cleanSource, prefix, group, workCode}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || part == "." || part == ".." {
			continue
		}
		cleanParts = append(cleanParts, filepath.Base(part))
	}
	return filepath.ToSlash(filepath.Join(cleanParts...))
}

func workCodeShard(workCode string) (string, string) {
	code := strings.ToUpper(strings.TrimSpace(workCode))
	prefix := code
	if len(prefix) > 2 {
		prefix = prefix[:2]
	}
	if prefix == "" {
		prefix = "UNKNOWN"
	}
	digits := ""
	for _, char := range code {
		if char >= '0' && char <= '9' {
			digits += string(char)
		}
	}
	group := "misc"
	if len(digits) >= 3 {
		group = digits[:3]
	}
	return prefix, group
}
