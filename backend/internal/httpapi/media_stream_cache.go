package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

const mediaStreamTargetTTL = 2 * time.Minute

type mediaStreamTarget struct {
	LocationType string
	RelativePath string
	Availability string
	FileSourceID int64
	StreamURL    string
	DownloadURL  string
	Kind         string
	HasAudio     sql.NullBool
	Duration     sql.NullInt64
	ExpiresAt    time.Time
}

func (s *Server) loadMediaStreamTarget(ctx context.Context, locationID int64) (mediaStreamTarget, bool, error) {
	if cached, ok := s.mediaStreamCache.Load(locationID); ok {
		target := cached.(mediaStreamTarget)
		if time.Now().Before(target.ExpiresAt) {
			current, err := s.mediaStreamTargetStillCurrent(ctx, locationID, target)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return mediaStreamTarget{}, false, err
			}
			if current {
				return target, true, nil
			}
		}
		s.mediaStreamCache.Delete(locationID)
	}

	eligible, err := s.demoMediaLocationEligible(ctx, locationID)
	if err != nil {
		return mediaStreamTarget{}, false, err
	}
	if !eligible {
		return mediaStreamTarget{}, false, sql.ErrNoRows
	}

	var target mediaStreamTarget
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.location_type,
			location.path,
			location.availability,
			location.file_source_id,
			COALESCE(location.stream_url, ''),
			COALESCE(location.download_url, ''),
			item.kind,
			item.has_audio,
			COALESCE(location.duration_seconds, item.duration_seconds)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
	`, locationID).Scan(
		&target.LocationType,
		&target.RelativePath,
		&target.Availability,
		&target.FileSourceID,
		&target.StreamURL,
		&target.DownloadURL,
		&target.Kind,
		&target.HasAudio,
		&target.Duration,
	); err != nil {
		return mediaStreamTarget{}, false, err
	}
	target.ExpiresAt = time.Now().Add(mediaStreamTargetTTL)
	s.mediaStreamCache.Store(locationID, target)
	return target, false, nil
}

// mediaStreamTargetStillCurrent checks a cached target against its location
// row. A folder edit, scan, cleanup, or delete can move a location to another
// file or retire it in place; the cache then must not serve the earlier path.
func (s *Server) mediaStreamTargetStillCurrent(ctx context.Context, locationID int64, target mediaStreamTarget) (bool, error) {
	var locationType, path, availability, streamURL, downloadURL string
	var fileSourceID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT location_type, path, availability, file_source_id,
			COALESCE(stream_url, ''), COALESCE(download_url, '')
		FROM media_file_location
		WHERE id = ?
	`, locationID).Scan(&locationType, &path, &availability, &fileSourceID, &streamURL, &downloadURL); err != nil {
		return false, err
	}
	return locationType == target.LocationType && path == target.RelativePath && availability == target.Availability &&
		fileSourceID == target.FileSourceID && streamURL == target.StreamURL && downloadURL == target.DownloadURL, nil
}
