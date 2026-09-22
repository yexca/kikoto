package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func (s *Server) resolveMediaWorkIDForRequest(ctx context.Context, workID int64) (int64, error) {
	var primaryCode string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&primaryCode); err != nil {
		return 0, err
	}
	translations, err := s.loadLogicalWorkTranslations(ctx, primaryCode)
	if err != nil {
		return 0, err
	}
	return s.resolveMediaWorkID(ctx, workID, translations)
}

func (s *Server) loadWorkMediaItems(ctx context.Context, userID int64, mediaWorkID int64) ([]mediaItemDetail, error) {
	mediaItems, itemIndexes, err := s.loadMediaItemRows(ctx, userID, mediaWorkID)
	if err != nil {
		return nil, err
	}
	if len(mediaItems) == 0 {
		return mediaItems, nil
	}
	if err := s.loadMediaLocationRows(ctx, mediaWorkID, mediaItems, itemIndexes); err != nil {
		return nil, err
	}
	inferMediaItemKinds(mediaItems)
	return mediaItems, nil
}

func (s *Server) loadMediaItemRows(ctx context.Context, userID int64, mediaWorkID int64) ([]mediaItemDetail, map[int64]int, error) {
	mediaItems := []mediaItemDetail{}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			media_item.id,
			media_item.parent_id,
			media_item.kind,
			media_item.title,
			media_item.disc_no,
			media_item.track_no,
			media_item.duration_seconds,
			media_item.has_audio,
			media_item.size_bytes,
			media_item.fingerprint,
			playback_cursor.position_seconds,
			playback_cursor.duration_seconds,
			playback_cursor.completed,
			playback_cursor.last_played_at,
			(
				SELECT preference.lyrics_media_item_id
				FROM user_media_lyrics_preference AS preference
				WHERE preference.user_id = ?
					AND preference.audio_media_item_id = media_item.id
			) AS preferred_lyrics_media_item_id
		FROM media_item
		LEFT JOIN user_work_playback_cursor AS playback_cursor ON playback_cursor.media_item_id = media_item.id
			AND playback_cursor.user_id = ?
		WHERE media_item.work_id = ?
		ORDER BY
			COALESCE(media_item.disc_no, 0) ASC,
			COALESCE(media_item.track_no, 0) ASC,
			media_item.title ASC,
			media_item.id ASC
	`, userID, userID, mediaWorkID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()

	itemIndexes := map[int64]int{}
	for rows.Next() {
		var item mediaItemDetail
		var parentID sql.NullInt64
		var discNo sql.NullInt64
		var trackNo sql.NullInt64
		var itemDurationSeconds sql.NullInt64
		var hasAudio sql.NullBool
		var sizeBytes sql.NullInt64
		var progressPositionSeconds sql.NullFloat64
		var progressDurationSeconds sql.NullFloat64
		var progressCompleted sql.NullBool
		var progressLastPlayedAt sql.NullString
		var preferredLyricsMediaItemID sql.NullInt64
		if err := rows.Scan(
			&item.ID,
			&parentID,
			&item.Kind,
			&item.Title,
			&discNo,
			&trackNo,
			&itemDurationSeconds,
			&hasAudio,
			&sizeBytes,
			&item.Fingerprint,
			&progressPositionSeconds,
			&progressDurationSeconds,
			&progressCompleted,
			&progressLastPlayedAt,
			&preferredLyricsMediaItemID,
		); err != nil {
			_ = rows.Close()
			return nil, nil, err
		}
		item.ParentID = sqlutil.Int64(parentID)
		item.DiscNo = sqlutil.Int64(discNo)
		item.TrackNo = sqlutil.Int64(trackNo)
		item.DurationSeconds = sqlutil.Int64(itemDurationSeconds)
		item.HasAudio = sqlutil.Bool(hasAudio)
		item.SizeBytes = sqlutil.Int64(sizeBytes)
		item.Progress = nullableMediaProgress(progressPositionSeconds, progressDurationSeconds, progressCompleted, progressLastPlayedAt)
		item.PreferredLyricsMediaItemID = sqlutil.Int64(preferredLyricsMediaItemID)
		item.Locations = []fileLocationDetail{}
		itemIndexes[item.ID] = len(mediaItems)
		mediaItems = append(mediaItems, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, nil, err
	}
	return mediaItems, itemIndexes, nil
}

func (s *Server) loadMediaLocationRows(ctx context.Context, mediaWorkID int64, mediaItems []mediaItemDetail, itemIndexes map[int64]int) error {
	locationRows, err := s.db.QueryContext(ctx, `
		SELECT
			location.id,
			location.media_item_id,
			location.file_source_id,
			source.code,
			source.display_name,
			location.location_type,
			location.path,
			location.stream_url,
			location.download_url,
			location.remote_hash,
			location.size_bytes,
			location.duration_seconds,
			location.availability,
			location.last_checked_at
		FROM media_file_location AS location
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
		ORDER BY source.priority ASC, location.id ASC
	`, mediaWorkID)
	if err != nil {
		return err
	}
	defer func() { _ = locationRows.Close() }()

	for locationRows.Next() {
		var mediaItemID int64
		var location fileLocationDetail
		var sizeBytes sql.NullInt64
		var locationDurationSeconds sql.NullInt64
		var lastCheckedAt sql.NullString
		if err := locationRows.Scan(
			&location.ID,
			&mediaItemID,
			&location.FileSourceID,
			&location.FileSourceCode,
			&location.FileSourceName,
			&location.LocationType,
			&location.Path,
			&location.StreamURL,
			&location.DownloadURL,
			&location.RemoteHash,
			&sizeBytes,
			&locationDurationSeconds,
			&location.Availability,
			&lastCheckedAt,
		); err != nil {
			_ = locationRows.Close()
			return err
		}
		location.SizeBytes = sqlutil.Int64(sizeBytes)
		location.DurationSeconds = sqlutil.Int64(locationDurationSeconds)
		location.LastCheckedAt = sqlutil.String(lastCheckedAt)
		if (location.LocationType == "local" || location.LocationType == "cache") && location.Availability == "available" && location.StreamURL == "" {
			location.StreamURL = fmt.Sprintf("/api/media/%d/stream", location.ID)
		}
		if index, ok := itemIndexes[mediaItemID]; ok {
			mediaItems[index].Locations = append(mediaItems[index].Locations, location)
		}
	}
	if err := locationRows.Err(); err != nil {
		_ = locationRows.Close()
		return err
	}
	if err := locationRows.Close(); err != nil {
		return err
	}
	return nil
}

func inferMediaItemKinds(mediaItems []mediaItemDetail) {
	// Older scans may have stored files before an extension was recognized.
	// Derive the playable kind from the concrete location so existing media
	// becomes usable without requiring a destructive rescan.
	for index := range mediaItems {
		if mediaItems[index].Kind != "file" {
			continue
		}
		for _, location := range mediaItems[index].Locations {
			if location.Availability != "available" && location.Availability != "remote" {
				continue
			}
			if kind := mediaKindFromPath(location.Path); kind != "file" {
				mediaItems[index].Kind = kind
				if mediaItems[index].DurationSeconds == nil {
					mediaItems[index].DurationSeconds = location.DurationSeconds
				}
				break
			}
		}
	}
}

func (s *Server) workHasAvailableLocalMedia(ctx context.Context, workID int64) (bool, error) {
	var exists bool
	if err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM media_item AS item
			INNER JOIN media_file_location AS location ON location.media_item_id = item.id
			WHERE item.work_id = ?
				AND location.location_type = 'local'
				AND location.availability = 'available'
		)
	`, workID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

func (s *Server) workHasMedia(ctx context.Context, workID int64) (bool, error) {
	var exists bool
	if err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM media_item AS item
			INNER JOIN media_file_location AS location ON location.media_item_id = item.id
			WHERE item.work_id = ?
				AND location.availability = 'available'
		)
	`, workID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

func (s *Server) workHasUnindexedAvailableLocalPresence(ctx context.Context, workID int64) (bool, error) {
	var exists bool
	if err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM work_source_presence AS presence
			INNER JOIN file_source AS source ON source.id = presence.file_source_id
			WHERE presence.work_id = ?
				AND presence.presence_type = 'local'
				AND presence.availability = 'available'
				AND source.source_type = 'local_folder'
				AND COALESCE(json_extract(presence.raw_json, '$.file_tree_scanned'), 0) = 0
		)
	`, workID).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

func localFileKind(path string) string {
	extension := strings.ToLower(filepath.Ext(path))
	switch extension {
	case ".mp3", ".m4a", ".flac", ".wav", ".wma", ".ogg", ".oga", ".opus", ".aac":
		return "audio"
	case ".mp4", ".m4v", ".webm", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".f4v", ".mpeg", ".mpg", ".mpe", ".m2v", ".m2ts", ".mts", ".ts", ".3gp", ".3g2", ".ogv", ".asf", ".rm", ".rmvb", ".vob", ".divx", ".xvid", ".mxf", ".ogm", ".svi", ".nsv", ".wtv", ".amv", ".mjpeg", ".mjpg", ".dv", ".y4m", ".ismv", ".ism":
		return "video"
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif":
		return "image"
	case ".txt", ".md", ".json", ".lrc", ".cue", ".srt", ".vtt", ".ass", ".csv", ".log", ".ini", ".yaml", ".yml":
		return "text"
	default:
		return "file"
	}
}

func isTextFile(path string) bool {
	return localFileKind(path) == "text"
}
