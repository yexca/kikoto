package httpapi

import (
	"context"
	"database/sql"
	"path"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

type indexedLocalLocation struct {
	id   int64
	path string
}

func availableLocalLocationsForWork(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64) ([]indexedLocalLocation, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT location.id, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.file_source_id = ?
			AND location.location_type = 'local' AND location.availability = 'available'
	`, workID, fileSourceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	locations := []indexedLocalLocation{}
	for rows.Next() {
		var location indexedLocalLocation
		if err := rows.Scan(&location.id, &location.path); err != nil {
			return nil, err
		}
		locations = append(locations, location)
	}
	return locations, rows.Err()
}

func localLocationWithinRoot(locationPath, root string) bool {
	locationPath, root = normalizeFolderRootPath(locationPath), normalizeFolderRootPath(root)
	return root != "" && (locationPath == root || strings.HasPrefix(locationPath, root+"/"))
}

// A file's parent directory may lie below the discovery depth while its work
// root is in scope. Prefer recorded roots; legacy locations without a matching
// root use the same work-code parser as folder discovery, without reading disk.
func localLocationWorkRoot(locationPath string, roots []string) string {
	matched := ""
	for _, root := range roots {
		if len(root) > len(matched) && localLocationWithinRoot(locationPath, root) {
			matched = root
		}
	}
	if matched != "" {
		return matched
	}
	for root := path.Dir(normalizeFolderRootPath(locationPath)); root != "." && root != "/"; root = path.Dir(root) {
		if code, _ := localfs.ExtractWorkCode(path.Base(root)); code != "" {
			return root
		}
	}
	return ""
}

func localLocationsInScanScope(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, scope localScanScope) ([]indexedLocalLocation, error) {
	locations, err := availableLocalLocationsForWork(ctx, tx, workID, fileSourceID)
	if err != nil || len(locations) == 0 {
		return locations, err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT source_url FROM work_source_presence
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
		UNION
		SELECT root_path FROM work_folder_location WHERE work_id = ? AND file_source_id = ?
	`, workID, fileSourceID, workID, fileSourceID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	roots := []string{}
	for rows.Next() {
		var root string
		if err := rows.Scan(&root); err != nil {
			return nil, err
		}
		roots = append(roots, normalizeFolderRootPath(root))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	kept := locations[:0]
	for _, location := range locations {
		if root := localLocationWorkRoot(location.path, roots); root != "" && scope.contains(root) {
			kept = append(kept, location)
		}
	}
	return kept, nil
}

func markLocalLocationsMissing(ctx context.Context, tx *sql.Tx, locations []indexedLocalLocation) (int, error) {
	for _, location := range locations {
		if _, err := tx.ExecContext(ctx, `
			UPDATE media_file_location
			SET availability = 'missing', last_checked_at = CURRENT_TIMESTAMP
			WHERE id = ? AND availability = 'available'
		`, location.id); err != nil {
			return 0, err
		}
	}
	return len(locations), nil
}

// folderRoot bounds reconciliation to the folder that was actually indexed.
// Only the isolated demo indexer passes an empty root to reconcile its full set.
func markMissingLocalLocationsForWork(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, seenPaths map[string]bool, folderRoot string) (int, error) {
	locations, err := availableLocalLocationsForWork(ctx, tx, workID, fileSourceID)
	if err != nil {
		return 0, err
	}
	missing := locations[:0]
	for _, location := range locations {
		if !seenPaths[location.path] && (folderRoot == "" || localLocationWithinRoot(location.path, folderRoot)) {
			missing = append(missing, location)
		}
	}
	return markLocalLocationsMissing(ctx, tx, missing)
}

func markLocalLocationsMissingForChangedFolder(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, folderPath string, scope localScanScope) (int, error) {
	if normalizeFolderRootPath(folderPath) == "" {
		return 0, nil
	}
	locations, err := localLocationsInScanScope(ctx, tx, workID, fileSourceID, scope)
	if err != nil {
		return 0, err
	}
	for _, location := range locations {
		if !localLocationWithinRoot(location.path, folderPath) {
			// Invalidate the observable set so lazy indexing rebuilds the
			// complete current tree, preserving copies the scan cannot see.
			return markLocalLocationsMissing(ctx, tx, locations)
		}
	}
	return 0, nil
}

func markAvailableLocalLocationsMissingForWork(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, scope localScanScope) (int, error) {
	locations, err := localLocationsInScanScope(ctx, tx, workID, fileSourceID, scope)
	if err != nil {
		return 0, err
	}
	return markLocalLocationsMissing(ctx, tx, locations)
}
