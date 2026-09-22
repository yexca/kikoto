package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"
)

type workSourceUntrackResult struct {
	WorkID         int64    `json:"workId"`
	SourceID       int64    `json:"sourceId"`
	Status         string   `json:"status"`
	ClearedCaches  int      `json:"clearedCaches"`
	DeletedFiles   int      `json:"deletedFiles"`
	CachePaths     []string `json:"cachePaths"`
	TrackedCleared bool     `json:"trackedCleared"`
	WorkPreserved  bool     `json:"workPreserved"`
	LocalPreserved bool     `json:"localPreserved"`
}

func (s *Server) untrackWorkSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil || workID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	sourceID, err := parseInt64PathValue(r, "sourceId")
	if err != nil || sourceID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	result, err := s.runWorkSourceUntrack(r.Context(), workID, sourceID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) runWorkSourceUntrack(ctx context.Context, workID int64, sourceID int64) (workSourceUntrackResult, error) {
	var found int
	if err := s.db.QueryRowContext(ctx, `
		SELECT 1
		FROM work_source_presence
		WHERE work_id = ?
			AND file_source_id = ?
			AND presence_type = 'tracked'
			AND availability = 'available'
		LIMIT 1
	`, workID, sourceID).Scan(&found); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workSourceUntrackResult{}, fmt.Errorf("tracked source not found")
		}
		return workSourceUntrackResult{}, err
	}

	cacheLocations, err := s.cacheLocationsForWorkSource(ctx, workID, sourceID)
	if err != nil {
		return workSourceUntrackResult{}, err
	}
	deletedFiles := 0
	cachePaths := make([]string, 0, len(cacheLocations))
	lockPaths := make([]string, 0, len(cacheLocations))
	seenLockPaths := make(map[string]struct{}, len(cacheLocations))
	for _, location := range cacheLocations {
		cachePaths = append(cachePaths, location.Path)
		lockPath := filepath.ToSlash(strings.TrimSpace(location.Path))
		if _, ok := seenLockPaths[lockPath]; !ok {
			seenLockPaths[lockPath] = struct{}{}
			lockPaths = append(lockPaths, lockPath)
		}
	}
	sort.Strings(lockPaths)
	locks := make([]func(), 0, len(lockPaths))
	defer func() {
		for index := len(locks) - 1; index >= 0; index-- {
			locks[index]()
		}
	}()
	for _, lockPath := range lockPaths {
		release, acquireErr := s.acquireCachePathLock(ctx, lockPath)
		if acquireErr != nil {
			return workSourceUntrackResult{}, acquireErr
		}
		locks = append(locks, release)
	}
	for _, location := range cacheLocations {
		deleted, _, err := s.removeCacheFileUnlocked(location.Path)
		if err != nil {
			return workSourceUntrackResult{}, err
		}
		if !deleted {
			continue
		}
		deletedFiles++
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workSourceUntrackResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ?
			AND file_source_id = ?
			AND presence_type = 'tracked'
	`, workID, sourceID); err != nil {
		return workSourceUntrackResult{}, err
	}
	for _, location := range cacheLocations {
		if _, err := tx.ExecContext(ctx, `
			UPDATE media_file_location
			SET availability = 'unavailable',
				last_checked_at = CURRENT_TIMESTAMP
			WHERE id = ?
				AND location_type = 'cache'
		`, location.ID); err != nil {
			return workSourceUntrackResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return workSourceUntrackResult{}, err
	}
	return workSourceUntrackResult{
		WorkID:         workID,
		SourceID:       sourceID,
		Status:         "succeeded",
		ClearedCaches:  len(cacheLocations),
		DeletedFiles:   deletedFiles,
		CachePaths:     cachePaths,
		TrackedCleared: true,
		WorkPreserved:  true,
		LocalPreserved: true,
	}, nil
}

type cacheLocationForCleanup struct {
	ID   int64
	Path string
}

func (s *Server) cacheLocationsForWorkSource(ctx context.Context, workID int64, sourceID int64) ([]cacheLocationForCleanup, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'cache'
			AND location.availability = 'available'
		ORDER BY location.id ASC
	`, workID, sourceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	locations := []cacheLocationForCleanup{}
	for rows.Next() {
		var location cacheLocationForCleanup
		if err := rows.Scan(&location.ID, &location.Path); err != nil {
			return nil, err
		}
		locations = append(locations, location)
	}
	return locations, rows.Err()
}
