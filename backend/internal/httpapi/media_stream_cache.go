package httpapi

import (
	"context"
	"database/sql"
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
			return target, true, nil
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
