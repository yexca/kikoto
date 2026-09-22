package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

type remoteCacheLimitResult struct {
	Removed          int   `json:"removed"`
	FreedBytes       int64 `json:"freedBytes"`
	TotalAfterBytes  int64 `json:"totalAfterBytes"`
	SourceAfterBytes int64 `json:"sourceAfterBytes"`
	TotalLimitGB     int   `json:"totalLimitGb"`
	SourceLimitGB    int   `json:"sourceLimitGb"`
}

type mediaCacheLimitCleanupJobPayload struct {
	SourceID       int64 `json:"source_id"`
	KeepLocationID int64 `json:"keep_location_id"`
}

type cacheLimitCandidate struct {
	ID       int64
	SourceID int64
	Path     string
	Size     int64
}

func (s *Server) enforceRemoteCacheLimits(ctx context.Context, sourceID int64, keepLocationID int64) (remoteCacheLimitResult, error) {
	totalLimitGB := s.settingIntContext(ctx, "remote_cache_limit_gb", 20)
	result := remoteCacheLimitResult{TotalLimitGB: totalLimitGB}
	if totalLimitGB <= 0 {
		return result, nil
	}
	protected, err := s.activeRemoteFetchCacheKeys(ctx)
	if err != nil {
		return result, err
	}
	removed, freed, err := s.trimCacheScope(ctx, 0, gbToBytes(totalLimitGB), keepLocationID, protected)
	if err != nil {
		return result, err
	}
	result.Removed += removed
	result.FreedBytes += freed
	result.TotalAfterBytes, _ = s.cacheScopeSize(ctx, 0)
	result.SourceAfterBytes, _ = s.cacheScopeSize(ctx, sourceID)
	return result, nil
}

func (s *Server) runCacheLimitCleanup(ctx context.Context, sourceID int64, keepLocationID int64) (remoteCacheLimitResult, error) {
	needed, totalLimitGB, sourceLimitGB, err := s.cacheLimitCleanupNeeded(ctx, sourceID)
	result := remoteCacheLimitResult{TotalLimitGB: totalLimitGB, SourceLimitGB: sourceLimitGB}
	if err != nil || !needed {
		return result, err
	}

	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "media_cache_cleanup", "Clean media cache", "Delete cached media files and mark cache locations unavailable.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "cleanup", "type": "cleanup_cache"},
		},
	})
	if err != nil {
		return result, err
	}
	input := map[string]any{"source_id": sourceID, "keep_location_id": keepLocationID, "total_limit_gb": totalLimitGB, "source_limit_gb": sourceLimitGB}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "media_cache_cleanup", "Clean media cache", "queued", "cache_limit", "enforce_cache_limit", input, map[string]any{"source_id": sourceID})
	if err != nil {
		return result, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select old cached media", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"policy": "oldest_last_checked_first"},
	}); err != nil {
		return result, err
	}
	cleanupNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cleanup", NodeType: "cleanup_cache", DisplayName: "Enforce cache limit", Position: 2, Status: "queued",
		Input: input, Output: nil,
	})
	if err != nil {
		return result, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cleanupNodeID, WorkerType: "media_cache_limit_cleanup", Status: "queued", ResourceKey: "media:cleanup", Payload: input,
		Checkpoint: map[string]any{"phase": "pending"}, Recoverable: true, MaxRetries: 3, ProgressCurrent: 0, ProgressTotal: 1,
	})
	if err != nil {
		return result, err
	}
	if err := tx.Commit(); err != nil {
		return result, err
	}
	jobCtx, stopHeartbeat, err := s.leaseInlineWorkflowJob(ctx, workflowJobRecord{ID: jobID, RunID: runID, NodeRunID: cleanupNodeID})
	if errors.Is(err, errWorkflowJobQueued) {
		return result, nil
	}
	if err != nil {
		return result, err
	}
	defer stopHeartbeat()

	cleanup, err := s.enforceRemoteCacheLimits(jobCtx, sourceID, keepLocationID)
	status := "succeeded"
	errorMessage := ""
	if err != nil {
		status = "failed"
		errorMessage = err.Error()
		cleanup = result
	}
	if finishErr := s.finishCacheLimitCleanup(jobCtx, runID, cleanupNodeID, jobID, status, cleanup, errorMessage); finishErr != nil && err == nil {
		err = finishErr
	}
	return cleanup, err
}

func (s *Server) executeMediaCacheLimitCleanupJob(ctx context.Context, job workflowJobRecord) error {
	var payload mediaCacheLimitCleanupJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, err := s.enforceRemoteCacheLimits(ctx, payload.SourceID, payload.KeepLocationID)
	status, message := "succeeded", ""
	if err != nil {
		status, message = "failed", err.Error()
	}
	if finishErr := s.finishCacheLimitCleanup(ctx, job.RunID, job.NodeRunID, job.ID, status, result, message); finishErr != nil {
		return finishErr
	}
	return err
}

func (s *Server) cacheLimitCleanupNeeded(ctx context.Context, sourceID int64) (bool, int, int, error) {
	totalLimitGB := s.settingIntContext(ctx, "remote_cache_limit_gb", 20)
	if totalLimitGB > 0 {
		size, err := s.cacheScopeSize(ctx, 0)
		if err != nil {
			return false, totalLimitGB, 0, err
		}
		if size > gbToBytes(totalLimitGB) {
			return true, totalLimitGB, 0, nil
		}
	}
	return false, totalLimitGB, 0, nil
}

func (s *Server) finishCacheLimitCleanup(ctx context.Context, runID int64, nodeID int64, jobID int64, status string, result remoteCacheLimitResult, errorMessage string) error {
	output := mustJSON(map[string]any{
		"removed":            result.Removed,
		"freed_bytes":        result.FreedBytes,
		"total_cache_after":  result.TotalAfterBytes,
		"source_cache_after": result.SourceAfterBytes,
		"total_limit_gb":     result.TotalLimitGB,
		"source_limit_gb":    result.SourceLimitGB,
		"error":              errorMessage,
	})
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, errorMessage, nodeID); err != nil {
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

func (s *Server) trimCacheScope(ctx context.Context, sourceID int64, limitBytes int64, keepLocationID int64, protected map[string]struct{}) (int, int64, error) {
	currentBytes, err := s.cacheScopeSize(ctx, sourceID)
	if err != nil {
		return 0, 0, err
	}
	if currentBytes <= limitBytes {
		return 0, 0, nil
	}
	candidates, err := s.cacheCleanupCandidates(ctx, sourceID)
	if err != nil {
		return 0, 0, err
	}
	removed := 0
	var freed int64
	for _, candidate := range candidates {
		if currentBytes <= limitBytes {
			break
		}
		if candidate.ID == keepLocationID {
			continue
		}
		if _, ok := protected[cacheLocationKey(candidate.SourceID, candidate.Path)]; ok {
			continue
		}
		bytes, deleted, err := s.clearCacheLocation(ctx, candidate.ID, candidate.Path)
		if err != nil {
			return removed, freed, err
		}
		_ = deleted
		if bytes <= 0 {
			bytes = candidate.Size
		}
		currentBytes -= bytes
		freed += bytes
		removed++
	}
	return removed, freed, nil
}

func cacheLocationKey(_ int64, cachePath string) string {
	return filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(cachePath))))
}

// Active Fetch manifests protect every cache object that may still be needed
// by staging or publication. The manifest already contains the durable plan,
// so this does not require a separate cache lease table.
func (s *Server) activeRemoteFetchCacheKeys(ctx context.Context) (map[string]struct{}, error) {
	protected := map[string]struct{}{}
	rows, err := s.db.QueryContext(ctx, `
		SELECT manifest.remote_source_id, manifest.plan_json
		FROM remote_fetch_manifest AS manifest
		INNER JOIN workflow_run AS run ON run.id = manifest.workflow_run_id
		WHERE run.workflow_code = 'remote_work_fetch'
			AND run.status IN ('queued', 'running', 'partial')
			AND manifest.state <> 'completed'
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var manifestSourceID int64
		var planJSON string
		if err := rows.Scan(&manifestSourceID, &planJSON); err != nil {
			return nil, err
		}
		var plan remoteWorkSavePlan
		if err := json.Unmarshal([]byte(planJSON), &plan); err != nil {
			continue
		}
		for _, item := range plan.Items {
			if item.Action != "cache_hit" && item.Action != "cache_download" {
				continue
			}
			sourceID := item.RemoteSourceID
			if sourceID <= 0 {
				sourceID = plan.SourceID
			}
			if sourceID <= 0 {
				sourceID = manifestSourceID
			}
			if strings.TrimSpace(item.CachePath) != "" {
				protected[cacheLocationKey(sourceID, item.CachePath)] = struct{}{}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return protected, nil
}

func (s *Server) cacheScopeSize(ctx context.Context, sourceID int64) (int64, error) {
	query := `
		SELECT COALESCE(SUM(COALESCE(size_bytes, 0)), 0)
		FROM media_file_location
		WHERE location_type = 'cache'
			AND availability = 'available'
	`
	args := []any{}
	if sourceID > 0 {
		query += " AND file_source_id = ?"
		args = append(args, sourceID)
	}
	var size int64
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&size); err != nil {
		return 0, err
	}
	return size, nil
}

func (s *Server) cacheCleanupCandidates(ctx context.Context, sourceID int64) ([]cacheLimitCandidate, error) {
	query := `
		SELECT id, file_source_id, path, COALESCE(size_bytes, 0)
		FROM media_file_location
		WHERE location_type = 'cache'
			AND availability = 'available'
	`
	args := []any{}
	if sourceID > 0 {
		query += " AND file_source_id = ?"
		args = append(args, sourceID)
	}
	query += " ORDER BY COALESCE(last_checked_at, '1970-01-01') ASC, id ASC"
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []cacheLimitCandidate{}
	for rows.Next() {
		var item cacheLimitCandidate
		if err := rows.Scan(&item.ID, &item.SourceID, &item.Path, &item.Size); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func gbToBytes(value int) int64 {
	return int64(value) * 1024 * 1024 * 1024
}
