package httpapi

import (
	"context"
	"errors"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

// refreshIndexedLocalScanFolder verifies only folders that already have an
// index. New folders retain lazy indexing. File trees are read outside write
// transactions, and an unchanged observation never rewrites media rows.
func (s *Server) refreshIndexedLocalScanFolder(ctx context.Context, sourceID int64, folder localfs.WorkFolder, scope localScanScope) (checked, updated, missing int, err error) {
	// Discovery can see a work root while a descendant is unreadable. Its
	// complete file tree is unknown, so preserve that index and let the scan's
	// unreadable-folder result report the partial run.
	for _, unreadable := range scope.unreadable {
		if localRelativePathsOverlap(folder.RelPath, unreadable) {
			return 0, 0, 0, nil
		}
	}
	var workID int64
	var completed bool
	err = s.db.QueryRowContext(ctx, `
		SELECT work.id, EXISTS (
			SELECT 1 FROM work_source_presence AS presence
			WHERE presence.work_id = work.id AND presence.file_source_id = ?
				AND presence.presence_type = 'local' AND presence.source_url = ?
				AND presence.availability = 'available'
				AND COALESCE(json_extract(presence.raw_json, '$.file_tree_scanned'), 0) = 1
		)
		FROM work WHERE work.primary_code = ?
	`, sourceID, folder.RelPath, folder.Code).Scan(&workID, &completed)
	if err != nil {
		return 0, 0, 0, err
	}
	observed, err := s.indexedLocalScanFiles(ctx, workID, sourceID, folder.RelPath)
	if err != nil || (!completed && len(observed) == 0) {
		return 0, 0, 0, err
	}
	guard := func(ctx context.Context) error {
		current, err := s.localScanScope(ctx, s.cfg.DataRoot, scope.depth)
		if err != nil {
			return err
		}
		if !scope.contains(folder.RelPath) || !current.contains(folder.RelPath) {
			return errors.New("local work folder is outside the observable scan scope")
		}
		return nil
	}
	if err := guard(ctx); err != nil {
		return 0, 0, 0, err
	}
	files, err := localfs.CollectWorkFiles(s.cfg.DataRoot, folder.AbsPath)
	if err != nil {
		return 0, 0, 0, err
	}
	if err := guard(ctx); err != nil {
		return 0, 0, 0, err
	}
	for _, file := range files {
		previous, exists := observed[file.RelPath]
		if !exists || previous.size != file.SizeBytes || previous.version != file.FileVersion {
			updated++
		}
		delete(observed, file.RelPath)
	}
	missing = len(observed)
	if updated == 0 && missing == 0 {
		return len(files), 0, 0, nil
	}
	// Reuse the same per-work coalescing and serialized write slot as lazy
	// indexing. The guard is checked again before and after its filesystem read.
	if err := s.indexLocalMediaForWorkGuarded(ctx, workID, sourceID, folder.RelPath, guard); err != nil {
		return 0, 0, 0, err
	}
	return len(files), updated, missing, nil
}

type localScanFileObservation struct {
	size    int64
	version string
}

func (s *Server) indexedLocalScanFiles(ctx context.Context, workID, sourceID int64, root string) (map[string]localScanFileObservation, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.path, COALESCE(location.size_bytes, 0), COALESCE(location.file_version, '')
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.file_source_id = ?
			AND location.location_type = 'local' AND location.availability = 'available'
			AND substr(location.path, 1, length(?) + 1) = ? || '/'
	`, workID, sourceID, root, root)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := map[string]localScanFileObservation{}
	for rows.Next() {
		var path string
		var file localScanFileObservation
		if err := rows.Scan(&path, &file.size, &file.version); err != nil {
			return nil, err
		}
		result[path] = file
	}
	return result, rows.Err()
}
