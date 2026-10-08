package personal

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// A client orders checkpoints by (order, reportId), never by media position.
// Order is an occurrence Unix millisecond, monotonically advanced by that client.
type ProgressInput struct {
	ReportID        string   `json:"reportId"`
	Order           int64    `json:"order"`
	MediaItemID     int64    `json:"mediaItemId"`
	LocationID      *int64   `json:"locationId"`
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Completed       bool     `json:"completed"`
}

type PlaybackReport struct {
	Progress []ProgressInput `json:"progress"`
	History  []SessionInput  `json:"history"`
}

type ProgressResult struct {
	ReportID string          `json:"reportId"`
	Status   string          `json:"status"`
	Cursor   *ProgressCursor `json:"cursor,omitempty"`
}

type ProgressCursor struct {
	WorkID          int64    `json:"workId"`
	MediaWorkID     int64    `json:"mediaWorkId"`
	MediaItemID     int64    `json:"mediaItemId"`
	FileSourceID    *int64   `json:"fileSourceId"`
	LocationID      *int64   `json:"locationId"`
	LocationType    string   `json:"locationType"`
	PositionSeconds float64  `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Completed       bool     `json:"completed"`
	LastPlayedAt    string   `json:"lastPlayedAt"`
}

type SessionResult struct {
	SessionID string `json:"sessionId"`
	Status    string `json:"status"`
}

type PlaybackResult struct {
	Generation int64            `json:"generation"`
	Progress   []ProgressResult `json:"progress"`
	History    []SessionResult  `json:"history"`
}

func reportStatus(err error) string {
	switch {
	case err == nil:
		return "recorded"
	case errors.Is(err, ErrHistoryCleared):
		return "history_cleared"
	case errors.Is(err, ErrInvalid):
		return "invalid"
	case errors.Is(err, ErrNotFound):
		return "not_found"
	case errors.Is(err, ErrConflict):
		return "conflict"
	default:
		return ""
	}
}

// RecordPlaybackReport commits every accepted item together. Expected item
// rejections are acknowledged separately; database/cancellation failures roll
// the entire batch back. Stale history never prevents a resume checkpoint.
func (s Store) RecordPlaybackReport(ctx context.Context, user int64, input PlaybackReport) (PlaybackResult, error) {
	result := PlaybackResult{Progress: []ProgressResult{}, History: []SessionResult{}}
	if len(input.Progress) > 32 || len(input.History) > 64 || len(input.Progress)+len(input.History) == 0 {
		return result, ErrInvalid
	}
	ids := map[string]bool{}
	for _, p := range input.Progress {
		if ids[p.ReportID] {
			return result, ErrInvalid
		}
		ids[p.ReportID] = true
	}
	ids = map[string]bool{}
	for _, h := range input.History {
		if ids[h.SessionID] {
			return result, ErrInvalid
		}
		ids[h.SessionID] = true
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback() }()
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT generation FROM user_listening_generation WHERE user_id=?),0)`, user).Scan(&result.Generation); err != nil {
		return result, err
	}
	for _, progress := range input.Progress {
		cursor, status, e := recordProgress(ctx, tx, user, progress)
		if e != nil {
			return result, e
		}
		result.Progress = append(result.Progress, ProgressResult{ReportID: progress.ReportID, Status: status, Cursor: cursor})
	}
	for _, history := range input.History {
		e := ErrInvalid
		if len(history.Days) > 0 {
			e = recordSessionTx(ctx, tx, user, history)
		}
		status := reportStatus(e)
		if status == "" {
			return result, e
		}
		result.History = append(result.History, SessionResult{SessionID: history.SessionID, Status: status})
	}
	return result, tx.Commit()
}

func recordProgress(ctx context.Context, tx *sql.Tx, user int64, p ProgressInput) (*ProgressCursor, string, error) {
	if !sessionIDPattern.MatchString(p.ReportID) || p.Order <= 0 || p.Order > time.Now().Add(5*time.Minute).UnixMilli() || p.MediaItemID <= 0 || (p.LocationID != nil && *p.LocationID <= 0) || !validNumber(p.PositionSeconds) || (p.DurationSeconds != nil && !validNumber(*p.DurationSeconds)) {
		return nil, "invalid", nil
	}
	var cursor ProgressCursor
	var source, location sql.NullInt64
	var locationType sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(l.canonical_work_id,c.work_id,m.work_id),m.work_id,f.file_source_id,f.id,f.location_type FROM media_item m LEFT JOIN work_edition e ON e.work_id=m.work_id LEFT JOIN logical_work l ON l.id=e.logical_work_id LEFT JOIN work_edition c ON c.logical_work_id=e.logical_work_id AND c.is_canonical=1 LEFT JOIN media_file_location f ON f.media_item_id=m.id AND f.id=? WHERE m.id=? ORDER BY c.work_id LIMIT 1`, p.LocationID, p.MediaItemID).Scan(&cursor.WorkID, &cursor.MediaWorkID, &source, &location, &locationType)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "not_found", nil
	}
	if err != nil {
		return nil, "", err
	}
	if p.LocationID != nil && !location.Valid {
		return nil, "invalid", nil
	}
	if source.Valid {
		cursor.FileSourceID = &source.Int64
	}
	if location.Valid {
		cursor.LocationID = &location.Int64
	}
	cursor.MediaItemID, cursor.LocationType = p.MediaItemID, locationType.String
	cursor.PositionSeconds, cursor.DurationSeconds, cursor.Completed = p.PositionSeconds, p.DurationSeconds, p.Completed
	if p.DurationSeconds != nil && *p.DurationSeconds > 0 && cursor.PositionSeconds > *p.DurationSeconds {
		cursor.PositionSeconds = *p.DurationSeconds
	}
	cursor.LastPlayedAt = time.UnixMilli(p.Order).UTC().Format("2006-01-02 15:04:05")
	written, err := tx.ExecContext(ctx, `INSERT INTO user_work_playback_cursor (user_id,work_id,media_item_id,file_source_id,location_id,location_type,position_seconds,duration_seconds,completed,last_played_at,report_order,report_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,work_id) DO UPDATE SET media_item_id=excluded.media_item_id,file_source_id=excluded.file_source_id,location_id=excluded.location_id,location_type=excluded.location_type,position_seconds=excluded.position_seconds,duration_seconds=excluded.duration_seconds,completed=excluded.completed,last_played_at=excluded.last_played_at,updated_at=CURRENT_TIMESTAMP,report_order=excluded.report_order,report_id=excluded.report_id WHERE excluded.report_order > report_order OR (excluded.report_order = report_order AND excluded.report_id > report_id)`, user, cursor.WorkID, p.MediaItemID, cursor.FileSourceID, cursor.LocationID, cursor.LocationType, cursor.PositionSeconds, p.DurationSeconds, p.Completed, cursor.LastPlayedAt, p.Order, p.ReportID)
	if err != nil {
		return nil, "", err
	}
	changed, err := written.RowsAffected()
	if err != nil {
		return nil, "", err
	}
	if changed == 0 {
		return nil, "stale", nil
	}
	return &cursor, "recorded", nil
}
