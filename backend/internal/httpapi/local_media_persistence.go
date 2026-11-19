package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// upsertDetectedMediaItem returns the media item of a scanned file. A file
// already recorded at its path keeps the item that holds it, such as the
// remote item a Fetch published the file under, so a path never gains a second
// item. That item becomes a plain local item: it takes the file's local
// fingerprint unless another item holds it, and leaves any remote folder.
func upsertDetectedMediaItem(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, folder localfs.WorkFolder, file localfs.LocalFile, kind string, trackNo int) (int64, error) {
	fingerprint := fmt.Sprintf("local:%s:%s", folder.Code, file.WorkRelPath)
	var trackNoValue any
	if trackNo > 0 {
		trackNoValue = trackNo
	}
	durationValue := nullableDuration(file.DurationSeconds)
	hasAudioValue := nullableBoolPointer(file.HasAudio)
	itemID, err := localPathMediaItemID(ctx, tx, workID, fileSourceID, file.RelPath, fingerprint)
	if err != nil {
		return 0, err
	}
	if itemID == 0 {
		err := tx.QueryRowContext(ctx, "SELECT id FROM media_item WHERE fingerprint = ? ORDER BY id ASC LIMIT 1", fingerprint).Scan(&itemID)
		if errors.Is(err, sql.ErrNoRows) {
			return sqlutil.InsertID(ctx, tx, `
				INSERT INTO media_item (work_id, kind, title, track_no, duration_seconds, has_audio, size_bytes, file_version, fingerprint)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			`, workID, kind, file.Title, trackNoValue, durationValue, hasAudioValue, file.SizeBytes, file.FileVersion, fingerprint)
		}
		if err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET kind = ?,
			title = ?,
			track_no = ?,
			duration_seconds = CASE WHEN file_version IS NOT ? OR size_bytes IS NOT ? THEN ? ELSE COALESCE(?, duration_seconds) END,
			has_audio = CASE WHEN file_version IS NOT ? OR size_bytes IS NOT ? THEN ? ELSE COALESCE(?, has_audio) END,
			size_bytes = ?, file_version = ?,
			parent_id = NULL,
			fingerprint = CASE WHEN EXISTS (
				SELECT 1 FROM media_item AS holder WHERE holder.fingerprint = ? AND holder.id <> media_item.id
			) THEN fingerprint ELSE ? END
		WHERE id = ?
	`, kind, file.Title, trackNoValue, file.FileVersion, file.SizeBytes, durationValue, durationValue,
		file.FileVersion, file.SizeBytes, hasAudioValue, hasAudioValue, file.SizeBytes, file.FileVersion,
		fingerprint, fingerprint, itemID); err != nil {
		return 0, err
	}
	return itemID, nil
}

// localPathMediaItemID returns the media item of the work that holds a local
// location at the path, preferring the item with the file's own fingerprint,
// or 0 when none does.
func localPathMediaItemID(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, relPath, fingerprint string) (int64, error) {
	var itemID int64
	err := tx.QueryRowContext(ctx, `
		SELECT item.id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.file_source_id = ? AND location.location_type = 'local' AND location.path = ?
			AND item.work_id = ?
		ORDER BY CASE WHEN item.fingerprint = ? THEN 0 ELSE 1 END, item.id ASC
		LIMIT 1
	`, fileSourceID, relPath, workID, fingerprint).Scan(&itemID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return itemID, err
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
	// A changed file version drops what was learned about the earlier file: its
	// duration and a failed probe. Loudness is dropped unless it was measured
	// from the version recorded now, which playback may have read before the
	// scan. SET reads the old row values.
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			duration_seconds = CASE WHEN file_version IS NOT ? OR size_bytes IS NOT ? THEN ? ELSE COALESCE(?, duration_seconds) END,
			probe_failed_version = CASE WHEN file_version IS NOT ? THEN NULL ELSE probe_failed_version END,
			loudness_version = CASE WHEN loudness_version IS NOT ? THEN NULL ELSE loudness_version END,
			loudness_integrated_lufs = CASE WHEN loudness_version IS NOT ? THEN NULL ELSE loudness_integrated_lufs END,
			loudness_peak_dbfs = CASE WHEN loudness_version IS NOT ? THEN NULL ELSE loudness_peak_dbfs END,
			loudness_peak_kind = CASE WHEN loudness_version IS NOT ? THEN NULL ELSE loudness_peak_kind END,
			file_version = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, file.SizeBytes, file.FileVersion, file.SizeBytes, durationValue, durationValue,
		file.FileVersion, file.FileVersion, file.FileVersion, file.FileVersion, file.FileVersion,
		file.FileVersion, mediaItemID, fileSourceID, file.RelPath); err != nil {
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
		SET duration_seconds = ?, file_version = ?, probe_failed_version = NULL
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
