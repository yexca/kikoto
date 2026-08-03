package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"time"
)

type mediaProgressDetail struct {
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    *string  `json:"lastPlayedAt"`
}

type mediaProgressResponse struct {
	WorkID          int64    `json:"workId"`
	MediaWorkID     int64    `json:"mediaWorkId"`
	MediaItemID     int64    `json:"mediaItemId"`
	FileSourceID    *int64   `json:"fileSourceId"`
	LocationID      *int64   `json:"locationId"`
	LocationType    string   `json:"locationType"`
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    *string  `json:"lastPlayedAt"`
}

type workProgressSummary struct {
	WorkID          *int64   `json:"workId"`
	MediaWorkID     *int64   `json:"mediaWorkId"`
	MediaItemID     *int64   `json:"mediaItemId"`
	FileSourceID    *int64   `json:"fileSourceId"`
	LocationID      *int64   `json:"locationId"`
	LocationType    string   `json:"locationType"`
	Title           string   `json:"title"`
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	LastPlayedAt    *string  `json:"lastPlayedAt"`
	Completed       bool     `json:"completed"`
}

func (s *Server) updateMediaProgress(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	mediaItemID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media item id"})
		return
	}
	if eligible, err := s.demoMediaItemEligible(r.Context(), mediaItemID); err != nil || !eligible {
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeError(w, err)
			return
		}
		writeAPIError(w, http.StatusNotFound, "not_found", "media item not found", false)
		return
	}
	var payload struct {
		LocationID      *int64   `json:"locationId"`
		PositionSeconds float64  `json:"positionSeconds"`
		DurationSeconds *float64 `json:"durationSeconds"`
		Completed       bool     `json:"completed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if payload.LocationID != nil && *payload.LocationID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "locationId must be a positive integer"})
		return
	}
	if !validSeconds(payload.PositionSeconds) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "positionSeconds must be finite and non-negative"})
		return
	}
	if payload.DurationSeconds != nil && !validSeconds(*payload.DurationSeconds) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "durationSeconds must be finite and non-negative"})
		return
	}
	if payload.DurationSeconds != nil && *payload.DurationSeconds > 0 && payload.PositionSeconds > *payload.DurationSeconds {
		payload.PositionSeconds = *payload.DurationSeconds
	}

	workID, fileSourceID, locationID, locationType, err := s.progressTarget(r.Context(), mediaItemID, payload.LocationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "media item not found", false)
			return
		}
		writeError(w, err)
		return
	}
	if payload.LocationID != nil && locationID == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "locationId must belong to the media item"})
		return
	}
	canonicalWorkID, err := s.canonicalWorkID(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}

	lastPlayedAt := time.Now().UTC().Truncate(time.Second).Format("2006-01-02 15:04:05")
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_work_playback_cursor (
			user_id,
			work_id,
			media_item_id,
			file_source_id,
			location_id,
			location_type,
			position_seconds,
			duration_seconds,
			completed,
			last_played_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			media_item_id = excluded.media_item_id,
			file_source_id = excluded.file_source_id,
			location_id = excluded.location_id,
			location_type = excluded.location_type,
			position_seconds = excluded.position_seconds,
			duration_seconds = excluded.duration_seconds,
			completed = excluded.completed,
			last_played_at = excluded.last_played_at,
			updated_at = excluded.last_played_at
	`, user.ID, canonicalWorkID, mediaItemID, fileSourceID, locationID, locationType,
		payload.PositionSeconds, payload.DurationSeconds, payload.Completed, lastPlayedAt); err != nil {
		writeError(w, err)
		return
	}
	progress := mediaProgressResponse{
		WorkID:          canonicalWorkID,
		MediaWorkID:     workID,
		MediaItemID:     mediaItemID,
		FileSourceID:    fileSourceID,
		LocationID:      locationID,
		LocationType:    locationType,
		PositionSeconds: payload.PositionSeconds,
		DurationSeconds: payload.DurationSeconds,
		Completed:       payload.Completed,
		LastPlayedAt:    &lastPlayedAt,
	}
	writeJSON(w, http.StatusOK, progress)
}

func (s *Server) getWorkPlaybackCursor(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.requireDemoWork(w, r, workID) {
		return
	}
	cursor, err := s.loadWorkPlaybackCursor(r.Context(), user.ID, workID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"cursor": cursor})
}

func (s *Server) progressTarget(ctx context.Context, mediaItemID int64, requestedLocationID *int64) (int64, *int64, *int64, string, error) {
	var workID int64
	var fileSourceID, locationID sql.NullInt64
	var locationType sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT item.work_id, location.file_source_id, location.id, location.location_type
		FROM media_item AS item
		LEFT JOIN media_file_location AS location
			ON location.media_item_id = item.id AND location.id = ?
		WHERE item.id = ?
	`, requestedLocationID, mediaItemID).Scan(&workID, &fileSourceID, &locationID, &locationType); err != nil {
		return 0, nil, nil, "", err
	}
	return workID, nullableInt64(fileSourceID), nullableInt64(locationID), locationType.String, nil
}

func (s *Server) canonicalWorkID(ctx context.Context, workID int64) (int64, error) {
	var canonicalWorkID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(logical.canonical_work_id, canonical_edition.work_id, work.id)
		FROM work
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		LEFT JOIN work_edition AS canonical_edition
			ON canonical_edition.logical_work_id = edition.logical_work_id
			AND canonical_edition.is_canonical = 1
		WHERE work.id = ?
		ORDER BY canonical_edition.work_id ASC
		LIMIT 1
	`, workID).Scan(&canonicalWorkID); err != nil {
		return 0, err
	}
	return canonicalWorkID, nil
}

func validSeconds(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0
}

func (s *Server) loadMediaProgress(ctx context.Context, userID int64, mediaItemID int64) (mediaProgressDetail, error) {
	var progress mediaProgressDetail
	var durationSeconds sql.NullFloat64
	var lastPlayedAt sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT position_seconds, duration_seconds, completed, last_played_at
		FROM user_work_playback_cursor
		WHERE user_id = ? AND media_item_id = ?
	`, userID, mediaItemID).Scan(
		&progress.PositionSeconds,
		&durationSeconds,
		&progress.Completed,
		&lastPlayedAt,
	); err != nil {
		return mediaProgressDetail{}, err
	}
	progress.DurationSeconds = nullableFloat64(durationSeconds)
	progress.LastPlayedAt = nullableString(lastPlayedAt)
	return progress, nil
}

func (s *Server) loadWorkPlaybackCursor(ctx context.Context, userID int64, workID int64) (*workProgressSummary, error) {
	canonicalWorkID, err := s.canonicalWorkID(ctx, workID)
	if err != nil {
		return nil, err
	}
	var cursor workProgressSummary
	var cursorWorkID, mediaWorkID, mediaItemID, fileSourceID, locationID sql.NullInt64
	var title, locationType sql.NullString
	var position, duration sql.NullFloat64
	var lastPlayedAt sql.NullString
	var completed sql.NullBool
	if err := s.db.QueryRowContext(ctx, `
		SELECT cursor.work_id, item.work_id, cursor.media_item_id, cursor.file_source_id, cursor.location_id,
			cursor.location_type, item.title, cursor.position_seconds, cursor.duration_seconds,
			cursor.last_played_at, cursor.completed
		FROM user_work_playback_cursor AS cursor
		INNER JOIN media_item AS item ON item.id = cursor.media_item_id
		WHERE cursor.user_id = ? AND cursor.work_id = ?
	`, userID, canonicalWorkID).Scan(
		&cursorWorkID,
		&mediaWorkID,
		&mediaItemID,
		&fileSourceID,
		&locationID,
		&locationType,
		&title,
		&position,
		&duration,
		&lastPlayedAt,
		&completed,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	cursor.WorkID = nullableInt64(cursorWorkID)
	cursor.MediaWorkID = nullableInt64(mediaWorkID)
	cursor.MediaItemID = nullableInt64(mediaItemID)
	cursor.FileSourceID = nullableInt64(fileSourceID)
	cursor.LocationID = nullableInt64(locationID)
	cursor.LocationType = locationType.String
	cursor.Title = title.String
	cursor.PositionSeconds = position.Float64
	cursor.DurationSeconds = nullableFloat64(duration)
	cursor.LastPlayedAt = nullableString(lastPlayedAt)
	cursor.Completed = completed.Valid && completed.Bool
	return &cursor, nil
}

func (s *Server) workProgressSummary(ctx context.Context, userID int64, workID int64) (workProgressSummary, error) {
	cursor, err := s.loadWorkPlaybackCursor(ctx, userID, workID)
	if err != nil {
		return workProgressSummary{}, err
	}
	if cursor == nil {
		return workProgressSummary{}, nil
	}
	return *cursor, nil
}

func nullableMediaProgress(position sql.NullFloat64, duration sql.NullFloat64, completed sql.NullBool, lastPlayedAt sql.NullString) *mediaProgressDetail {
	if !position.Valid && !duration.Valid && !completed.Valid && !lastPlayedAt.Valid {
		return nil
	}
	return &mediaProgressDetail{
		PositionSeconds: position.Float64,
		DurationSeconds: nullableFloat64(duration),
		Completed:       completed.Valid && completed.Bool,
		LastPlayedAt:    nullableString(lastPlayedAt),
	}
}

func nullableFloat64(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}
