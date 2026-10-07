package httpapi

import "context"

// File operations use the same online-pool and work-root depth scope as scans.
// A nested track remains visible when its enclosing work root is visible.
func (s *Server) localMediaPathInScanScope(ctx context.Context, workID, sourceID int64, relPath string) (bool, error) {
	scope, err := s.localScanScope(ctx, s.cfg.DataRoot, s.effectiveLocalScanDepth(ctx))
	if err != nil {
		return false, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT source_url FROM work_source_presence WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
		UNION SELECT root_path FROM work_folder_location WHERE work_id = ? AND file_source_id = ?
	`, workID, sourceID, workID, sourceID)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	var roots []string
	for rows.Next() {
		var root string
		if err := rows.Scan(&root); err != nil {
			return false, err
		}
		roots = append(roots, normalizeFolderRootPath(root))
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	root := localLocationWorkRoot(relPath, roots)
	return root != "" && scope.contains(root), nil
}
