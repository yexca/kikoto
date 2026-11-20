package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// quarantineFetchLocalRoots archives for review the folders a Fetch
// consolidated: those its copy_local items came from, chosen by
// selectFetchArchiveRoots as the plan listed them. A Fetch without copy_local
// items leaves every existing folder as it is.
func (s *Server) quarantineFetchLocalRoots(ctx context.Context, runID int64, workID int64, localSourceID int64, saveRoot string, items []remoteWorkSavePlanItem) ([]map[string]any, error) {
	if len(fetchConsolidatedSourcePaths(items)) == 0 {
		return []map[string]any{}, nil
	}
	records, err := s.loadFetchArchiveCandidates(ctx, workID, runID)
	if err != nil {
		return nil, err
	}
	publishedRoot := filepath.ToSlash(strings.Trim(saveRoot, "/"))
	archived := []map[string]any{}
	for _, record := range selectFetchArchiveRoots(records, saveRoot, items) {
		item, ok, err := s.quarantineFetchRoot(ctx, runID, workID, localSourceID, publishedRoot, record)
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

// fetchConsolidatedSourcePaths lists the local files a Fetch copies into its
// target, relative to the data root.
func fetchConsolidatedSourcePaths(items []remoteWorkSavePlanItem) []string {
	paths := []string{}
	for _, item := range items {
		if item.Action != "copy_local" {
			continue
		}
		if path := strings.Trim(filepath.ToSlash(strings.TrimSpace(item.LocalSourcePath)), "/"); path != "" {
			paths = append(paths, path)
		}
	}
	return paths
}

// fetchRootArchivedAfterFetch reports whether a folder of the work is archived
// once the Fetch is published: it holds a file the Fetch consolidated, and it
// is neither the published folder nor one the Fetch writes into.
func fetchRootArchivedAfterFetch(root string, publishedRoot string, targetRoots map[string]bool, sources []string) bool {
	root = filepath.ToSlash(strings.Trim(filepath.ToSlash(root), "/"))
	if root == "" || targetRoots[root] || (publishedRoot != "" && fetchRootsOverlap(root, publishedRoot)) {
		return false
	}
	for _, source := range sources {
		if strings.HasPrefix(source, root+"/") {
			return true
		}
	}
	return false
}

// selectFetchArchiveRoots picks, from the work's folders, the ones a Fetch
// archives once it is published. The Fetch plan lists them and the archive step
// archives them with this one rule.
func selectFetchArchiveRoots(records []fetchRootRecord, saveRoot string, items []remoteWorkSavePlanItem) []fetchRootRecord {
	sources := fetchConsolidatedSourcePaths(items)
	if len(sources) == 0 {
		return nil
	}
	publishedRoot := filepath.ToSlash(strings.Trim(saveRoot, "/"))
	targetRoots := fetchPlanTargetRoots(items)
	selected := []fetchRootRecord{}
	for _, record := range records {
		if fetchRootArchivedAfterFetch(record.path, publishedRoot, targetRoots, sources) {
			selected = append(selected, record)
		}
	}
	return selected
}

// loadFetchArchiveCandidates loads the work's local folders a Fetch may
// archive: the active ones, and those the run already archived, so a retry
// records them again.
func (s *Server) loadFetchArchiveCandidates(ctx context.Context, workID, runID int64) ([]fetchRootRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.root_path, location.role
		FROM work_folder_location AS location
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE location.work_id = ? AND source.source_type = 'local_folder'
			AND (location.state = 'active' OR (location.state = 'pending_cleanup' AND location.cleanup_run_id = ?))
		ORDER BY location.id ASC
	`, workID, runID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	records := []fetchRootRecord{}
	for rows.Next() {
		var record fetchRootRecord
		if err := rows.Scan(&record.id, &record.path, &record.role); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

// fetchPlanArchiveRoots lists the folders a Fetch archives for review once it
// is published, so the Fetch dialog shows them before the Fetch is accepted.
func (s *Server) fetchPlanArchiveRoots(ctx context.Context, plan remoteWorkSavePlan) ([]string, error) {
	roots := []string{}
	if len(fetchConsolidatedSourcePaths(plan.Items)) == 0 {
		return roots, nil
	}
	var workID int64
	err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", firstNonEmpty(plan.EditionCode, plan.PrimaryCode)).Scan(&workID)
	if errors.Is(err, sql.ErrNoRows) {
		return roots, nil
	}
	if err != nil {
		return nil, err
	}
	records, err := s.loadFetchArchiveCandidates(ctx, workID, 0)
	if err != nil {
		return nil, err
	}
	for _, record := range selectFetchArchiveRoots(records, plan.SaveRoot, plan.Items) {
		roots = append(roots, filepath.ToSlash(strings.Trim(record.path, "/")))
	}
	return roots, nil
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

func (s *Server) quarantineFetchRoot(ctx context.Context, runID, workID, localSourceID int64, publishedRoot string, record fetchRootRecord) (map[string]any, bool, error) {
	root := filepath.ToSlash(strings.Trim(record.path, "/"))
	if root == "" || fetchRootsOverlap(root, publishedRoot) {
		return nil, false, nil
	}
	// A root on an offline pool stays as it is until its pool is back; what
	// sits at its path now is not the indexed folder.
	if err := s.ensureLibraryPathOnline(ctx, root); err != nil {
		var offline libraryStorageError
		if errors.As(err, &offline) {
			return nil, false, nil
		}
		return nil, false, err
	}
	// The archive stays on the old root's pool so archiving is a rename.
	poolPath, err := s.fetchTransactionPool(ctx, root)
	if err != nil {
		return nil, false, err
	}
	archive := storagepool.Join(poolPath, filepath.ToSlash(filepath.Join(".kikoto-trash", "fetch", fmt.Sprintf("%d", runID), fmt.Sprintf("%d-%s", record.id, filepath.Base(filepath.FromSlash(root))))))
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
