package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
)

type mediaProgressDetail struct {
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    *string  `json:"lastPlayedAt"`
}

type mediaProgressResponse struct {
	MediaItemID     int64    `json:"mediaItemId"`
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    *string  `json:"lastPlayedAt"`
}

type workProgressSummary struct {
	MediaItemID     *int64   `json:"mediaItemId"`
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
		PositionSeconds float64  `json:"positionSeconds"`
		DurationSeconds *float64 `json:"durationSeconds"`
		Completed       bool     `json:"completed"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
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

	var progress mediaProgressResponse
	var durationSeconds sql.NullFloat64
	var lastPlayedAt sql.NullString
	if err := s.db.QueryRowContext(r.Context(), `
		INSERT INTO user_media_progress (
			user_id,
			media_item_id,
			position_seconds,
			duration_seconds,
			completed,
			last_played_at
		)
		SELECT ?, item.id, ?, ?, ?, CURRENT_TIMESTAMP
		FROM media_item AS item
		WHERE item.id = ?
		ON CONFLICT(user_id, media_item_id) DO UPDATE SET
			position_seconds = excluded.position_seconds,
			duration_seconds = excluded.duration_seconds,
			completed = excluded.completed,
			last_played_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		RETURNING media_item_id, position_seconds, duration_seconds, completed, last_played_at
	`, user.ID, payload.PositionSeconds, payload.DurationSeconds, payload.Completed, mediaItemID).Scan(
		&progress.MediaItemID,
		&progress.PositionSeconds,
		&durationSeconds,
		&progress.Completed,
		&lastPlayedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "media item not found"})
			return
		}
		writeError(w, err)
		return
	}
	progress.DurationSeconds = nullableFloat64(durationSeconds)
	progress.LastPlayedAt = nullableString(lastPlayedAt)
	writeJSON(w, http.StatusOK, progress)
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
		FROM user_media_progress
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

func (s *Server) workProgressSummary(ctx context.Context, userID int64, workID int64) (workProgressSummary, error) {
	var mediaItemID sql.NullInt64
	var title sql.NullString
	var position sql.NullFloat64
	var duration sql.NullFloat64
	var lastPlayedAt sql.NullString
	var completed sql.NullBool
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			media_item.id,
			media_item.title,
			user_media_progress.position_seconds,
			user_media_progress.duration_seconds,
			user_media_progress.last_played_at,
			user_media_progress.completed
		FROM media_item
		INNER JOIN user_media_progress ON user_media_progress.media_item_id = media_item.id
		WHERE media_item.work_id = ?
			AND media_item.kind = 'audio'
			AND user_media_progress.user_id = ?
		ORDER BY user_media_progress.last_played_at DESC, user_media_progress.updated_at DESC, media_item.id DESC
		LIMIT 1
	`, workID, userID).Scan(&mediaItemID, &title, &position, &duration, &lastPlayedAt, &completed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workProgressSummary{}, nil
		}
		return workProgressSummary{}, err
	}
	return workProgressSummary{
		MediaItemID:     nullableInt64(mediaItemID),
		Title:           title.String,
		PositionSeconds: position.Float64,
		DurationSeconds: nullableFloat64(duration),
		LastPlayedAt:    nullableString(lastPlayedAt),
		Completed:       completed.Valid && completed.Bool,
	}, nil
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
