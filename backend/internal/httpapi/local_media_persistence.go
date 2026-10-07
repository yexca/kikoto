package httpapi

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func upsertDetectedMediaItem(ctx context.Context, tx *sql.Tx, workID int64, folder localfs.WorkFolder, file localfs.LocalFile, kind string, trackNo int) (int64, error) {
	fingerprint := fmt.Sprintf("local:%s:%s", folder.Code, file.WorkRelPath)
	var trackNoValue any
	if trackNo > 0 {
		trackNoValue = trackNo
	}
	durationValue := nullableDuration(file.DurationSeconds)
	hasAudioValue := nullableBoolPointer(file.HasAudio)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO media_item (
			work_id,
			kind,
			title,
			track_no,
			duration_seconds,
			has_audio,
			size_bytes,
			file_version,
			fingerprint
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM media_item WHERE fingerprint = ?
		)
	`, workID, kind, file.Title, trackNoValue, durationValue, hasAudioValue, file.SizeBytes, file.FileVersion, fingerprint, fingerprint)
	if err != nil {
		return 0, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return 0, err
	} else if affected > 0 {
		return result.LastInsertId()
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET kind = ?,
			title = ?,
			track_no = ?,
			duration_seconds = CASE WHEN file_version IS NOT ? OR size_bytes IS NOT ? THEN ? ELSE COALESCE(?, duration_seconds) END,
			has_audio = CASE WHEN file_version IS NOT ? OR size_bytes IS NOT ? THEN ? ELSE COALESCE(?, has_audio) END,
			size_bytes = ?, file_version = ?
		WHERE fingerprint = ?
	`, kind, file.Title, trackNoValue, file.FileVersion, file.SizeBytes, durationValue, durationValue,
		file.FileVersion, file.SizeBytes, hasAudioValue, hasAudioValue, file.SizeBytes, file.FileVersion, fingerprint); err != nil {
		return 0, err
	}
	return sqlutil.SelectID(ctx, tx, "SELECT id FROM media_item WHERE fingerprint = ? ORDER BY id ASC LIMIT 1", fingerprint)
}

func upsertDetectedLocation(ctx context.Context, tx *sql.Tx, mediaItemID int64, fileSourceID int64, file localfs.LocalFile) (int64, error) {
	durationValue := nullableDuration(file.DurationSeconds)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO media_file_location (
			media_item_id,
			file_source_id,
			location_type,
			path,
			size_bytes,
			file_version,
			duration_seconds,
			availability,
			last_checked_at
		)
		SELECT ?, ?, 'local', ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'local'
				AND path = ?
		)
	`, mediaItemID, fileSourceID, file.RelPath, file.SizeBytes, file.FileVersion, durationValue, mediaItemID, fileSourceID, file.RelPath)
	if err != nil {
		return 0, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return 0, err
	} else if affected > 0 {
		return result.LastInsertId()
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			duration_seconds = CASE WHEN file_version IS NOT ? OR size_bytes IS NOT ? THEN ? ELSE COALESCE(?, duration_seconds) END,
			file_version = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, file.SizeBytes, file.FileVersion, file.SizeBytes, durationValue, durationValue, file.FileVersion, mediaItemID, fileSourceID, file.RelPath); err != nil {
		return 0, err
	}
	return sqlutil.SelectID(ctx, tx, `
		SELECT id
		FROM media_file_location
		WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'local' AND path = ?
		ORDER BY id ASC
		LIMIT 1
	`, mediaItemID, fileSourceID, file.RelPath)
}

func (s *Server) updateLocalMediaMetadata(ctx context.Context, locationID int64, file localfs.LocalFile, expectedVersion string, durationSeconds int64, hasAudio bool) error {
	var durationValue any
	if durationSeconds > 0 {
		durationValue = durationSeconds
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET duration_seconds = ?, file_version = ?
		WHERE id = ? AND location_type = 'local' AND path = ?
			AND size_bytes = ? AND file_version = ? AND availability = 'available'
	`, durationValue, file.FileVersion, locationID, file.RelPath, file.SizeBytes, expectedVersion)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET duration_seconds = ?, has_audio = ?, file_version = ?
		WHERE id = (SELECT media_item_id FROM media_file_location WHERE id = ?)
			AND (file_version = '' OR file_version = ?)
	`, durationValue, hasAudio, file.FileVersion, locationID, file.FileVersion); err != nil {
		return err
	}
	return tx.Commit()
}

func localLocationExists(ctx context.Context, tx *sql.Tx, fileSourceID int64, file localfs.LocalFile) (bool, error) {
	var count int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM media_file_location
		WHERE file_source_id = ?
			AND location_type = 'local'
			AND path = ?
			AND size_bytes = ?
			AND file_version = ?
			AND availability = 'available'
	`, fileSourceID, file.RelPath, file.SizeBytes, file.FileVersion).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}
