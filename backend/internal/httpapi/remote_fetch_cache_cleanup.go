package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
)

func (s *Server) cleanupPromotedFetchCache(ctx context.Context, plan remoteWorkSavePlan, workID int64) (int, error) {
	trackedSources, err := s.trackedFetchSourceIDs(ctx, workID)
	if err != nil {
		return 0, err
	}
	removed := 0
	seen := map[string]bool{}
	for _, item := range plan.Items {
		deleted, err := s.cleanupPromotedFetchCacheItem(ctx, plan.SourceID, item, trackedSources, seen)
		if err != nil {
			return removed, err
		}
		if deleted {
			removed++
		}
	}
	return removed, nil
}

func (s *Server) trackedFetchSourceIDs(ctx context.Context, workID int64) (map[int64]bool, error) {
	trackedSources := map[int64]bool{}
	if workID <= 0 {
		return trackedSources, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT file_source_id
		FROM work_source_presence
		WHERE work_id = ?
			AND presence_type = 'tracked'
			AND availability = 'available'
	`, workID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sourceID int64
		if err := rows.Scan(&sourceID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		trackedSources[sourceID] = true
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return trackedSources, nil
}

func (s *Server) cleanupPromotedFetchCacheItem(
	ctx context.Context,
	defaultSourceID int64,
	item remoteWorkSavePlanItem,
	trackedSources map[int64]bool,
	seen map[string]bool,
) (bool, error) {
	if item.Action != "cache_hit" && item.Action != "cache_download" {
		return false, nil
	}
	sourceID := item.RemoteSourceID
	if sourceID <= 0 {
		sourceID = defaultSourceID
	}
	if trackedSources[sourceID] {
		return false, nil
	}
	key := fmt.Sprintf("%d:%s", sourceID, item.CachePath)
	if seen[key] {
		return false, nil
	}
	seen[key] = true
	releaseCacheLock, err := s.acquireCachePathLock(ctx, item.CachePath)
	if err != nil {
		return false, err
	}
	defer releaseCacheLock()
	var locationID int64
	err = s.db.QueryRowContext(ctx, `
		SELECT id FROM media_file_location
		WHERE file_source_id = ? AND location_type = 'cache' AND path = ?
		ORDER BY availability = 'available' DESC, id DESC LIMIT 1
	`, sourceID, item.CachePath).Scan(&locationID)
	if errors.Is(err, sql.ErrNoRows) {
		deleted, _, removeErr := s.removeCacheFileUnlocked(item.CachePath)
		if removeErr != nil {
			return false, removeErr
		}
		if err := s.markCacheLocationUnavailable(ctx, sourceID, item.CachePath); err != nil {
			return false, err
		}
		return deleted, nil
	}
	if err != nil {
		return false, err
	}
	_, deleted, err := s.clearCacheLocationUnlocked(ctx, locationID, item.CachePath)
	return deleted, err
}

// Fetch records source availability and local materialization. It does not
// create tracked intent; only an already active tracked source owns its cache.
func (s *Server) cleanupFetchCacheWithoutTrackedPresence(ctx context.Context, workID int64, sourceIDs []int64) error {
	for _, sourceID := range sourceIDs {
		if sourceID <= 0 {
			continue
		}
		var tracked int
		if err := s.db.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM work_source_presence
				WHERE work_id = ? AND file_source_id = ?
					AND presence_type = 'tracked' AND availability = 'available'
			)
		`, workID, sourceID).Scan(&tracked); err != nil {
			return err
		}
		if tracked != 0 {
			continue
		}
		locations, err := s.cacheLocationsForWorkSource(ctx, workID, sourceID)
		if err != nil {
			return err
		}
		for _, location := range locations {
			if _, _, err := s.clearCacheLocation(ctx, location.ID, location.Path); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) insertFetchCleanupCandidate(ctx context.Context, runID int64, workID int64, localSourceID int64, workCode string, items []remoteWorkSavePlanItem) error {
	archivedRoots, err := s.quarantineFetchLocalRoots(ctx, runID, workID, localSourceID, items)
	if err != nil {
		return err
	}
	if len(archivedRoots) > 0 {
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
			SELECT ?, 'local_fetch_merge_cleanup', ?, 'pending', ?
			WHERE NOT EXISTS (
				SELECT 1 FROM workflow_candidate
				WHERE workflow_run_id = ? AND candidate_type = 'local_fetch_merge_cleanup'
			)
		`, runID, workCode, mustJSON(map[string]any{
			"work_id": workID, "work_code": workCode, "local_source_id": localSourceID,
			"archived_roots": archivedRoots,
			"message":        "Old local roots were archived after Fetch. Keep the archive or permanently delete it after review.",
		}), runID)
		return err
	}
	targets := map[string]bool{}
	for _, item := range items {
		if item.TargetPath != "" {
			targets[filepath.ToSlash(item.TargetPath)] = true
		}
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			location.id,
			location.media_item_id,
			location.path,
			location.size_bytes,
			item.title,
			item.kind
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
		ORDER BY location.path ASC
	`, workID, localSourceID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	candidates := []map[string]any{}
	locationIDs := []int64{}
	for rows.Next() {
		var id int64
		var mediaItemID int64
		var path string
		var size sql.NullInt64
		var title string
		var kind string
		if err := rows.Scan(&id, &mediaItemID, &path, &size, &title, &kind); err != nil {
			return err
		}
		if targets[filepath.ToSlash(path)] {
			continue
		}
		locationIDs = append(locationIDs, id)
		item := map[string]any{
			"location_id":   id,
			"media_item_id": mediaItemID,
			"path":          filepath.ToSlash(path),
			"title":         title,
			"kind":          kind,
		}
		if size.Valid {
			item["size_bytes"] = size.Int64
		}
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'local_fetch_merge_cleanup', ?, 'pending', ?)
	`, runID, workCode, mustJSON(map[string]any{
		"work_id":                workID,
		"work_code":              workCode,
		"local_source_id":        localSourceID,
		"candidate_locations":    candidates,
		"candidate_location_ids": locationIDs,
		"fetched_targets":        sortedStringKeys(targets),
		"message":                "Fetch completed while other local files for this work still exist. Review before deleting or hiding old local files.",
	}))
	return err
}
