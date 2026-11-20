package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func mediaItemIDForRemotePath(ctx context.Context, db sqlutil.RowQuerier, workID int64, remotePath string) (int64, error) {
	var mediaItemID int64
	err := db.QueryRowContext(ctx, `
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

// remoteFetchMediaItemID resolves the stored media item a planned remote file
// is recorded under. A file the stored listing does not contain is reported in
// terms of the file, not of the lookup that missed.
func (s *Server) remoteFetchMediaItemID(ctx context.Context, workID int64, item remoteWorkSavePlanItem) (int64, error) {
	if item.MediaItemID > 0 {
		return item.MediaItemID, nil
	}
	mediaItemID, err := mediaItemIDForRemotePath(ctx, s.db, workID, item.Path)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("%s is not in the stored file listing of this work; the remote listing changed after the Fetch was planned", item.Path)
	}
	return mediaItemID, err
}

// mediaItemIDForFetchItem keeps a target path on the media item that already
// holds it, as a scan does, so a re-Fetch of a file a scan has recorded adds no
// second location. A new path goes to the planned item, else to the remote
// item found through its remote_stream row. Registration calls it inside the
// write transaction that records the location, so a scan cannot record the
// path in between.
func mediaItemIDForFetchItem(ctx context.Context, tx *sql.Tx, workID int64, localSourceID int64, item remoteWorkSavePlanItem) (int64, error) {
	var mediaItemID int64
	err := tx.QueryRowContext(ctx, `
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
	if !errors.Is(err, sql.ErrNoRows) {
		return mediaItemID, err
	}
	if item.MediaItemID > 0 {
		return item.MediaItemID, nil
	}
	return mediaItemIDForRemotePath(ctx, tx, workID, item.Path)
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
	info, err := os.Stat(targetAbsPath)
	if err != nil {
		return err
	}
	var size any
	if info.Size() > 0 {
		size = info.Size()
	}
	mediaItemID, err := s.registerSavedLocalLocation(ctx, workID, localSourceID, item, size)
	if err != nil {
		return err
	}
	if item.Kind != "video" {
		return nil
	}
	// The probe runs after the location is committed, so it holds no write
	// transaction while it reads the file.
	duration, hasAudio, ok := s.probeMediaMetadataSeconds(ctx, targetAbsPath)
	if !ok {
		return nil
	}
	var durationValue any
	if duration > 0 {
		durationValue = duration
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_item SET duration_seconds = COALESCE(?, duration_seconds), has_audio = ? WHERE id = ?
	`, durationValue, hasAudio, mediaItemID); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE media_file_location SET duration_seconds = COALESCE(?, duration_seconds) WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'local' AND path = ?
	`, durationValue, mediaItemID, localSourceID, item.TargetPath)
	return err
}

// registerSavedLocalLocation resolves the media item of a published file and
// records its local location in one write transaction, and returns the item.
func (s *Server) registerSavedLocalLocation(ctx context.Context, workID int64, localSourceID int64, item remoteWorkSavePlanItem, size any) (int64, error) {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	mediaItemID, err := mediaItemIDForFetchItem(ctx, tx, workID, localSourceID, item)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
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
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, size, mediaItemID, localSourceID, item.TargetPath); err != nil {
		return 0, err
	}
	return mediaItemID, tx.Commit()
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
	// Presence sync leaves the cache alone: cleanupPromotedFetchCache removes
	// the cache of the promoted files only, so unselected files stay cached.
	if err := tx.Commit(); err != nil {
		return err
	}
	s.refreshQueryPlannerStatistics(ctx)
	return nil
}

// retireFetchRemoteStreams drops the remote_stream rows of the files this Fetch
// promoted: the local copy plays them now. Files the Fetch left unselected keep
// their remote streams.
func retireFetchRemoteStreams(ctx context.Context, tx *sql.Tx, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan) error {
	for _, item := range plan.Items {
		if item.Action != "cache_hit" && item.Action != "cache_download" {
			continue
		}
		sourceID := item.RemoteSourceID
		if sourceID <= 0 {
			sourceID = manifest.RemoteSourceID
		}
		if sourceID <= 0 {
			continue
		}
		remotePath := firstNonEmpty(item.RemotePath, item.Path)
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM media_file_location
			WHERE file_source_id = ? AND location_type = 'remote_stream'
				AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
				AND (
					path = ? OR media_item_id = ?
					OR media_item_id IN (
						SELECT media_item_id FROM media_file_location
						WHERE file_source_id = ? AND location_type = 'local' AND path = ?
					)
				)
		`, sourceID, manifest.WorkID, remotePath, item.MediaItemID, manifest.LocalSourceID, item.TargetPath); err != nil {
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
		`, normalizeWorkCode(workCode), workID, sourceID, sourcePresenceTypeRemoteSource)
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
