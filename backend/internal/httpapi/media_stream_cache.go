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
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, locationID).Scan(&target.LocationType, &target.RelativePath, &target.Availability); err != nil {
		return mediaStreamTarget{}, false, err
	}
	target.ExpiresAt = time.Now().Add(mediaStreamTargetTTL)
	s.mediaStreamCache.Store(locationID, target)
	return target, false, nil
}
