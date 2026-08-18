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
// bind to one stable folder identity.
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

func markMissingExternalWorkFolderLocations(ctx context.Context, tx *sql.Tx, fileSourceID int64, seenRoots map[string]bool) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, root_path
		FROM work_folder_location
		WHERE file_source_id = ? AND role != 'managed_fetch' AND state = 'active'
	`, fileSourceID)
	if err != nil {
		return err
	}
	missingIDs := []int64{}
	for rows.Next() {
		var id int64
		var rootPath string
		if err := rows.Scan(&id, &rootPath); err != nil {
			_ = rows.Close()
			return err
		}
		if !seenRoots[strings.ToLower(normalizeFolderRootPath(rootPath))] {
			missingIDs = append(missingIDs, id)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range missingIDs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_folder_location
			SET state = 'missing', is_primary = 0, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND role != 'managed_fetch' AND state = 'active'
		`, id); err != nil {
			return err
		}
	}
	return nil
}
