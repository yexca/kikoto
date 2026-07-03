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
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM media_item WHERE id = ?", mediaItemID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "media item not found"})
			return
		}
		writeError(w, err)
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

	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_media_progress (
			user_id,
			media_item_id,
			position_seconds,
			duration_seconds,
			completed,
			last_played_at
		)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, media_item_id) DO UPDATE SET
			position_seconds = excluded.position_seconds,
			duration_seconds = excluded.duration_seconds,
			completed = excluded.completed,
			last_played_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, mediaItemID, payload.PositionSeconds, payload.DurationSeconds, payload.Completed); err != nil {
		writeError(w, err)
		return
	}
	if err := s.markWorkListeningFromMediaItem(r.Context(), user.ID, mediaItemID); err != nil {
		writeError(w, err)
		return
	}

	progress, err := s.loadMediaProgress(r.Context(), user.ID, mediaItemID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, mediaProgressResponse{
		MediaItemID:     mediaItemID,
		PositionSeconds: progress.PositionSeconds,
		DurationSeconds: progress.DurationSeconds,
		Completed:       progress.Completed,
		LastPlayedAt:    progress.LastPlayedAt,
	})
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

func (s *Server) markWorkListeningFromMediaItem(ctx context.Context, userID int64, mediaItemID int64) error {
	var workID int64
	if err := s.db.QueryRowContext(ctx, "SELECT work_id FROM media_item WHERE id = ?", mediaItemID).Scan(&workID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_work_state (user_id, work_id, listening_status)
		VALUES (?, ?, 'listening')
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			listening_status = CASE
				WHEN listening_status IN ('none', 'want_to_listen') THEN 'listening'
				ELSE listening_status
			END,
			updated_at = CASE
				WHEN listening_status IN ('none', 'want_to_listen') THEN CURRENT_TIMESTAMP
				ELSE updated_at
			END
	`, userID, workID)
	return err
}
