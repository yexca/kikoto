package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"os"
)

func (s *Server) mediaItemIDForRemotePath(ctx context.Context, workID int64, remotePath string) (int64, error) {
	var mediaItemID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT item.id
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.work_id = ?
			AND location.location_type = 'remote_stream'
			AND location.path = ?
		ORDER BY item.id ASC
		LIMIT 1
	`, workID, remotePath).Scan(&mediaItemID)
	return mediaItemID, err
}

// Registration normally resolves a remote item through its remote_stream row.
// Releases that retired those rows before completing the manifest left some
// published Fetches without them; the local location written before that
// retirement still identifies the same media item.
func (s *Server) mediaItemIDForFetchItem(ctx context.Context, workID int64, localSourceID int64, item remoteWorkSavePlanItem) (int64, error) {
	if item.MediaItemID > 0 {
		return item.MediaItemID, nil
	}
	mediaItemID, err := s.mediaItemIDForRemotePath(ctx, workID, item.Path)
	if !errors.Is(err, sql.ErrNoRows) {
		return mediaItemID, err
	}
	err = s.db.QueryRowContext(ctx, `
		SELECT item.id
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.path = ?
		ORDER BY item.id ASC
		LIMIT 1
	`, workID, localSourceID, item.TargetPath).Scan(&mediaItemID)
	return mediaItemID, err
}

func (s *Server) markCacheLocationUnavailable(ctx context.Context, sourceID int64, cachePath string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
	`, sourceID, cachePath)
	return err
}

func (s *Server) upsertSavedLocalLocation(ctx context.Context, workID int64, localSourceID int64, item remoteWorkSavePlanItem, targetAbsPath string) error {
	mediaItemID, err := s.mediaItemIDForFetchItem(ctx, workID, localSourceID, item)
	if err != nil {
		return err
	}
	info, err := os.Stat(targetAbsPath)
	if err != nil {
		return err
	}
	var size any
	if info.Size() > 0 {
		size = info.Size()
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO media_file_location (
			media_item_id,
			file_source_id,
			location_type,
			path,
			size_bytes,
			availability,
			last_checked_at
		)
		SELECT ?, ?, 'local', ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'local'
				AND path = ?
		)
	`, mediaItemID, localSourceID, item.TargetPath, size, mediaItemID, localSourceID, item.TargetPath); err != nil {
		return err
	}
	if _, err = s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, size, mediaItemID, localSourceID, item.TargetPath); err != nil {
		return err
	}
	if item.Kind == "video" {
		duration, hasAudio, ok := s.probeMediaMetadataSeconds(ctx, targetAbsPath)
		if ok {
			var durationValue any
			if duration > 0 {
				durationValue = duration
			}
			if _, err := s.db.ExecContext(ctx, `
				UPDATE media_item SET duration_seconds = COALESCE(?, duration_seconds), has_audio = ? WHERE id = ?
			`, durationValue, hasAudio, mediaItemID); err != nil {
				return err
			}
			if _, err := s.db.ExecContext(ctx, `
				UPDATE media_file_location SET duration_seconds = COALESCE(?, duration_seconds) WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'local' AND path = ?
			`, durationValue, mediaItemID, localSourceID, item.TargetPath); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) finishFetchPresence(ctx context.Context, workID int64, remoteSourceIDs []int64, localSourceID int64, workCode string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, remoteSourceID := range remoteSourceIDs {
		if remoteSourceID <= 0 {
			continue
		}
		if err := ensureFetchSourcePresence(ctx, tx, workID, remoteSourceID, workCode); err != nil {
			return err
		}
	}
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: localSourceID,
		PresenceType: "local",
		RemoteID:     "",
		Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"primary_code": workCode,
			"source":       "remote_fetch",
		}),
	}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.cleanupFetchCacheWithoutTrackedPresence(ctx, workID, remoteSourceIDs)
}

func retireFetchRemoteStreams(ctx context.Context, tx *sql.Tx, workID int64, remoteSourceIDs []int64) error {
	for _, remoteSourceID := range remoteSourceIDs {
		if remoteSourceID <= 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM media_file_location
			WHERE file_source_id = ? AND location_type = 'remote_stream'
				AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
		`, remoteSourceID, workID); err != nil {
			return err
		}
	}
	return nil
}

func ensureFetchSourcePresence(ctx context.Context, tx *sql.Tx, workID int64, sourceID int64, workCode string) error {
	var found int
	err := tx.QueryRowContext(ctx, `
		SELECT 1
		FROM work_source_presence
		WHERE work_id = ? AND file_source_id = ? AND presence_type = ?
		LIMIT 1
	`, workID, sourceID, sourcePresenceTypeRemoteSource).Scan(&found)
	if err == nil {
		_, updateErr := tx.ExecContext(ctx, `
			UPDATE work_source_presence
			SET remote_code = COALESCE(NULLIF(?, ''), remote_code),
				availability = 'available',
				last_seen_at = CURRENT_TIMESTAMP,
				last_checked_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
			WHERE work_id = ? AND file_source_id = ? AND presence_type = ?
		`, normalizeDLsiteCode(workCode), workID, sourceID, sourcePresenceTypeRemoteSource)
		return updateErr
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID: workID, FileSourceID: sourceID, PresenceType: sourcePresenceTypeRemoteSource,
		RemoteCode: workCode, Availability: "available",
		RawJSON: mustJSON(map[string]any{"source": "remote_fetch", "primary_code": workCode}),
	})
}
