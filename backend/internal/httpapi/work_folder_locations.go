package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
)

// upsertWorkFolderLocation keeps the concrete local root separate from the
// aggregated source-presence row. Cleanup and the directory UI can therefore
// bind to one stable folder identity. An upsert that would change no stored
// value leaves the row and its timestamps untouched, so a full scan of an
// unchanged library does not rewrite every folder.
func upsertWorkFolderLocation(ctx context.Context, tx *sql.Tx, workID int64, fileSourceID int64, rootPath string, role string, state string, primary bool) error {
	rootPath = normalizeFolderRootPath(rootPath)
	if workID <= 0 || fileSourceID <= 0 || rootPath == "" {
		return errors.New("invalid work folder location")
	}
	if strings.TrimSpace(role) == "" {
		role = "external"
	}
	if strings.TrimSpace(state) == "" {
		state = "active"
	}
	primaryValue := 0
	if primary {
		primaryValue = 1
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO work_folder_location (
			work_id, file_source_id, root_path, role, state, is_primary,
			last_scanned_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(file_source_id, root_path) DO UPDATE SET
			work_id = excluded.work_id,
			role = CASE WHEN work_folder_location.role = 'managed_fetch' THEN work_folder_location.role ELSE excluded.role END,
			origin_source_id = work_folder_location.origin_source_id,
			origin_remote_code = work_folder_location.origin_remote_code,
			state = CASE WHEN work_folder_location.cleanup_run_id IS NOT NULL THEN work_folder_location.state ELSE excluded.state END,
			is_primary = CASE WHEN work_folder_location.role = 'managed_fetch' THEN work_folder_location.is_primary ELSE excluded.is_primary END,
			cleanup_run_id = work_folder_location.cleanup_run_id,
			last_scanned_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_folder_location.work_id IS NOT excluded.work_id
			OR (
				work_folder_location.role <> 'managed_fetch'
				AND (
					work_folder_location.role IS NOT excluded.role
					OR work_folder_location.is_primary IS NOT excluded.is_primary
				)
			)
			OR (
				work_folder_location.cleanup_run_id IS NULL
				AND work_folder_location.state IS NOT excluded.state
			)
	`, workID, fileSourceID, rootPath, role, state, primaryValue)
	return err
}

func normalizeFolderRootPath(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	value = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(value))))
	if value == "." {
		return ""
	}
	return strings.Trim(value, "/")
}

// markMissingExternalWorkFolderLocations marks folders the scan could observe
// but did not find, together with the available file locations recorded below
// each of them, and returns how many file locations it marked. inScope limits
// that to folders the scan reached. A file below a folder the scan found, such
// as a deeper work root that replaced the missing one, keeps its state.
func markMissingExternalWorkFolderLocations(ctx context.Context, tx *sql.Tx, fileSourceID int64, seenRoots map[string]bool, inScope func(string) bool) (int, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, work_id, root_path
		FROM work_folder_location
		WHERE file_source_id = ? AND role != 'managed_fetch' AND state = 'active'
	`, fileSourceID)
	if err != nil {
		return 0, err
	}
	type missingFolder struct {
		id, workID int64
		root       string
	}
	missingFolders := []missingFolder{}
	for rows.Next() {
		var folder missingFolder
		if err := rows.Scan(&folder.id, &folder.workID, &folder.root); err != nil {
			_ = rows.Close()
			return 0, err
		}
		if !seenRoots[normalizeFolderRootPath(folder.root)] && inScope(folder.root) {
			missingFolders = append(missingFolders, folder)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	missingLocations := 0
	for _, folder := range missingFolders {
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_folder_location
			SET state = 'missing', is_primary = 0, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND role != 'managed_fetch' AND state = 'active'
		`, folder.id); err != nil {
			return 0, err
		}
		locations, err := availableLocalLocationsForWork(ctx, tx, folder.workID, fileSourceID)
		if err != nil {
			return 0, err
		}
		below := locations[:0]
		for _, location := range locations {
			if localLocationWithinRoot(location.path, folder.root) && !localLocationWithinSeenRoot(location.path, seenRoots) {
				below = append(below, location)
			}
		}
		marked, err := markLocalLocationsMissing(ctx, tx, below)
		if err != nil {
			return 0, err
		}
		missingLocations += marked
	}
	return missingLocations, nil
}

func localLocationWithinSeenRoot(locationPath string, seenRoots map[string]bool) bool {
	for root := range seenRoots {
		if localLocationWithinRoot(locationPath, root) {
			return true
		}
	}
	return false
}
