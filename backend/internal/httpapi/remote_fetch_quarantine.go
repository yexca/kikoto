package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func (s *Server) quarantineFetchLocalRoots(ctx context.Context, runID int64, workID int64, localSourceID int64, items []remoteWorkSavePlanItem) ([]map[string]any, error) {
	publishedRoot, records, err := s.loadFetchRootsForQuarantine(ctx, workID, localSourceID)
	if err != nil {
		return nil, err
	}
	targetRoots := fetchPlanTargetRoots(items)
	archived := []map[string]any{}
	for _, record := range records {
		item, ok, err := s.quarantineFetchRoot(ctx, runID, workID, localSourceID, publishedRoot, targetRoots, record)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		archived = append(archived, item)
	}
	return archived, nil
}

type fetchRootRecord struct {
	id         int64
	path, role string
}

func fetchPlanTargetRoots(items []remoteWorkSavePlanItem) map[string]bool {
	targets := map[string]bool{}
	for _, item := range items {
		path := filepath.ToSlash(strings.TrimSpace(item.TargetPath))
		if path == "" {
			continue
		}
		for _, root := range fetchRootCandidatesForPath(path) {
			targets[root] = true
		}
	}
	return targets
}

func (s *Server) loadFetchRootsForQuarantine(ctx context.Context, workID, localSourceID int64) (string, []fetchRootRecord, error) {
	var publishedRoot string
	if err := s.db.QueryRowContext(ctx, `
		SELECT root_path FROM work_folder_location
		WHERE work_id = ? AND file_source_id = ? AND role = 'managed_fetch' AND state = 'active' AND is_primary = 1
		ORDER BY updated_at DESC, id DESC LIMIT 1
	`, workID, localSourceID).Scan(&publishedRoot); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", nil, err
	}
	publishedRoot = filepath.ToSlash(strings.Trim(publishedRoot, "/"))
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, root_path, role
		FROM work_folder_location
		WHERE work_id = ? AND file_source_id = ? AND state = 'active' AND root_path <> ?
		ORDER BY id ASC
	`, workID, localSourceID, publishedRoot)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = rows.Close() }()
	records := []fetchRootRecord{}
	for rows.Next() {
		var record fetchRootRecord
		if err := rows.Scan(&record.id, &record.path, &record.role); err != nil {
			return "", nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return "", nil, err
	}
	return publishedRoot, records, rows.Close()
}

func (s *Server) quarantineFetchRoot(ctx context.Context, runID, workID, localSourceID int64, publishedRoot string, targetRoots map[string]bool, record fetchRootRecord) (map[string]any, bool, error) {
	root := filepath.ToSlash(strings.Trim(record.path, "/"))
	if root == "" || fetchRootsOverlap(root, publishedRoot) || targetRoots[root] {
		return nil, false, nil
	}
	archive := filepath.ToSlash(filepath.Join(".kikoto-trash", "fetch", fmt.Sprintf("%d", runID), fmt.Sprintf("%d-%s", record.id, filepath.Base(filepath.FromSlash(root)))))
	files, totalBytes, ok, err := s.archiveFetchRoot(root, archive)
	if err != nil || !ok {
		return nil, false, err
	}
	if err := s.markFetchRootQuarantined(ctx, runID, workID, localSourceID, record.id, root); err != nil {
		return nil, false, err
	}
	return map[string]any{
		"folder_id": record.id, "original_path": root, "archive_path": archive,
		"role": record.role, "files": files, "file_count": len(files), "size_bytes": totalBytes,
	}, true, nil
}

func (s *Server) archiveFetchRoot(root, archive string) ([]map[string]any, int64, bool, error) {
	sourcePath, err := safeDataPath(s.cfg.DataRoot, root)
	if err != nil {
		return nil, 0, false, err
	}
	archivePath, err := safeDataPath(s.cfg.DataRoot, archive)
	if err != nil {
		return nil, 0, false, err
	}
	info, statErr := os.Lstat(sourcePath)
	if statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, 0, false, nil
		}
		files, totalBytes, err := archivedRootFileSummary(sourcePath)
		if err != nil {
			return nil, 0, false, err
		}
		if err := os.MkdirAll(filepath.Dir(archivePath), 0o755); err != nil {
			return nil, 0, false, err
		}
		if err := os.Rename(sourcePath, archivePath); err != nil {
			return nil, 0, false, fmt.Errorf("archive old fetch root %s: %w", root, err)
		}
		return files, totalBytes, true, nil
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return nil, 0, false, statErr
	}
	if _, archiveErr := os.Stat(archivePath); archiveErr != nil {
		return nil, 0, false, nil
	}
	files, totalBytes, err := archivedRootFileSummary(archivePath)
	return files, totalBytes, err == nil, err
}

func (s *Server) markFetchRootQuarantined(ctx context.Context, runID, workID, localSourceID, folderID int64, root string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE work_folder_location SET state = 'pending_cleanup', cleanup_run_id = ?, is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", runID, folderID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable', last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ? AND location_type = 'local'
			AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
			AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
	`, localSourceID, workID, root, root, root); err != nil {
		return err
	}
	return tx.Commit()
}

func fetchRootCandidatesForPath(path string) []string {
	parts := strings.Split(strings.Trim(filepath.ToSlash(path), "/"), "/")
	result := make([]string, 0, len(parts))
	for index := 1; index < len(parts); index++ {
		result = append(result, strings.Join(parts[:index], "/"))
	}
	return result
}

func fetchRootsOverlap(left string, right string) bool {
	left = strings.Trim(filepath.ToSlash(left), "/")
	right = strings.Trim(filepath.ToSlash(right), "/")
	return left == right || strings.HasPrefix(left, right+"/") || strings.HasPrefix(right, left+"/")
}

func archivedRootFileSummary(root string) ([]map[string]any, int64, error) {
	files := []map[string]any{}
	var totalBytes int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("archived root contains unsupported symbolic link: %s", filepath.ToSlash(path))
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		totalBytes += info.Size()
		files = append(files, map[string]any{"path": filepath.ToSlash(relative), "size_bytes": info.Size()})
		return nil
	})
	return files, totalBytes, err
}
