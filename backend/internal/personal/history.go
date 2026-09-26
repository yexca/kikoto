package personal

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"regexp"
	"strings"
)

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{7,79}$`)

type SessionInput struct {
	Generation      int64   `json:"generation"`
	SessionID       string  `json:"sessionId"`
	WorkID          int64   `json:"workId"`
	ListenedSeconds float64 `json:"listenedSeconds"`
}

func validNumber(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 }

func (s Store) ListeningGeneration(ctx context.Context, user int64) (int64, error) {
	var generation int64
	err := s.DB.QueryRowContext(ctx, `SELECT COALESCE((SELECT generation FROM user_listening_generation WHERE user_id=?),0)`, user).Scan(&generation)
	return generation, err
}

func (s Store) RecordSession(ctx context.Context, user int64, input SessionInput) error {
	if input.Generation < 0 || !sessionIDPattern.MatchString(input.SessionID) || input.WorkID <= 0 || !validNumber(input.ListenedSeconds) || input.ListenedSeconds <= 0 || input.ListenedSeconds > 86400 {
		return ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var generation int64
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT generation FROM user_listening_generation WHERE user_id=?),0)`, user).Scan(&generation); err != nil {
		return err
	}
	if generation != input.Generation {
		return ErrHistoryCleared
	}
	var work int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(l.canonical_work_id,w.id) FROM work w LEFT JOIN work_edition e ON e.work_id = w.id LEFT JOIN logical_work l ON l.id = e.logical_work_id WHERE w.id = ?`, input.WorkID).Scan(&work)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var previous float64
	var storedWork int64
	err = tx.QueryRowContext(ctx, `SELECT work_id,listened_seconds FROM user_listening_session WHERE user_id = ? AND session_id = ?`, user, input.SessionID).Scan(&storedWork, &previous)
	newSession := errors.Is(err, sql.ErrNoRows)
	if err != nil && !newSession {
		return err
	}
	if !newSession && storedWork != work {
		return ErrConflict
	}
	if !newSession && input.ListenedSeconds <= previous {
		return nil
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO user_listening_session (user_id,session_id,work_id,listened_seconds) VALUES (?,?,?,?) ON CONFLICT(user_id,session_id) DO UPDATE SET listened_seconds = excluded.listened_seconds, updated_at = CURRENT_TIMESTAMP`, user, input.SessionID, work, input.ListenedSeconds)
	if err != nil {
		return err
	}
	count := 0
	if newSession {
		count = 1
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO user_listening_day (user_id,work_id,day,listened_seconds,listen_count) VALUES (?,?,date('now'),?,?) ON CONFLICT(user_id,work_id,day) DO UPDATE SET listened_seconds = listened_seconds + excluded.listened_seconds, listen_count = listen_count + excluded.listen_count`, user, work, input.ListenedSeconds-previous, count)
	if err != nil {
		return err
	}
	return tx.Commit()
}

// Imported totals are deltas above native session totals; retries never inflate them.
const historyCTE = `WITH history AS (
 SELECT work_id, SUM(listened_seconds) listened_seconds, SUM(listen_count) listen_count, MAX(last_played_at) last_played_at FROM (
  SELECT work_id, listened_seconds, 1 listen_count, updated_at last_played_at FROM user_listening_session WHERE user_id = ?
  UNION ALL SELECT work_id, listened_seconds, listen_count, last_played_at FROM user_listening_import WHERE user_id = ?
 ) GROUP BY work_id
) `

type HistoryItem struct {
	WorkID          int64   `json:"workId"`
	PrimaryCode     string  `json:"primaryCode"`
	Title           string  `json:"title"`
	ListenedSeconds float64 `json:"listenedSeconds"`
	ListenCount     int64   `json:"listenCount"`
	LastPlayedAt    string  `json:"lastPlayedAt"`
}

type HistoryPage struct {
	Items    []HistoryItem `json:"items"`
	Total    int           `json:"total"`
	Page     int           `json:"page"`
	PageSize int           `json:"pageSize"`
}

func historyItems(rows *sql.Rows) ([]HistoryItem, error) {
	defer func() { _ = rows.Close() }()
	items := []HistoryItem{}
	for rows.Next() {
		var item HistoryItem
		if err := rows.Scan(&item.WorkID, &item.PrimaryCode, &item.Title, &item.ListenedSeconds, &item.ListenCount, &item.LastPlayedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s Store) History(ctx context.Context, user int64, query string, page, size int) (HistoryPage, error) {
	page, size = pageBounds(page, size)
	result := HistoryPage{Items: []HistoryItem{}, Page: page, PageSize: size}
	if len(query) > 800 {
		return result, ErrInvalid
	}
	query = strings.TrimSpace(query)
	where := ` FROM history h JOIN work w ON w.id = h.work_id WHERE instr(LOWER(w.primary_code || ' ' || w.title),LOWER(?)) > 0`
	if err := s.DB.QueryRowContext(ctx, historyCTE+`SELECT COUNT(*)`+where, user, user, query).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := s.DB.QueryContext(ctx, historyCTE+`SELECT w.id,w.primary_code,w.title,h.listened_seconds,h.listen_count,h.last_played_at`+where+` ORDER BY h.last_played_at DESC,w.id DESC LIMIT ? OFFSET ?`, user, user, query, size, (page-1)*size)
	if err != nil {
		return result, err
	}
	result.Items, err = historyItems(rows)
	return result, err
}

type ListeningDay struct {
	Date            string  `json:"date"`
	ListenedSeconds float64 `json:"listenedSeconds"`
	ListenCount     int64   `json:"listenCount"`
}

type Statistics struct {
	ListenedSeconds float64        `json:"listenedSeconds"`
	ListenCount     int64          `json:"listenCount"`
	WorkCount       int            `json:"workCount"`
	ActiveDays      int            `json:"activeDays"`
	Daily           []ListeningDay `json:"daily"`
	TopWorks        []HistoryItem  `json:"topWorks"`
}

func (s Store) Statistics(ctx context.Context, user int64) (Statistics, error) {
	result := Statistics{Daily: []ListeningDay{}, TopWorks: []HistoryItem{}}
	err := s.DB.QueryRowContext(ctx, historyCTE+`SELECT COALESCE(SUM(listened_seconds),0),COALESCE(SUM(listen_count),0),COUNT(*) FROM history`, user, user).Scan(&result.ListenedSeconds, &result.ListenCount, &result.WorkCount)
	if err != nil {
		return result, err
	}
	if err = s.DB.QueryRowContext(ctx, `SELECT COUNT(DISTINCT day) FROM user_listening_day WHERE user_id = ?`, user).Scan(&result.ActiveDays); err != nil {
		return result, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT day,SUM(listened_seconds),SUM(listen_count) FROM user_listening_day WHERE user_id = ? AND day >= date('now','-29 days') GROUP BY day ORDER BY day`, user)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var day ListeningDay
		if err = rows.Scan(&day.Date, &day.ListenedSeconds, &day.ListenCount); err != nil {
			_ = rows.Close()
			return result, err
		}
		result.Daily = append(result.Daily, day)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return result, err
	}
	rows, err = s.DB.QueryContext(ctx, historyCTE+`SELECT w.id,w.primary_code,w.title,h.listened_seconds,h.listen_count,h.last_played_at FROM history h JOIN work w ON w.id = h.work_id ORDER BY h.listened_seconds DESC,w.id LIMIT 10`, user, user)
	if err != nil {
		return result, err
	}
	result.TopWorks, err = historyItems(rows)
	return result, err
}

func (s Store) ClearHistory(ctx context.Context, user int64) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Invalidate even a session whose first report is still in flight. A client
	// must obtain the new generation before starting a new listening interval.
	if _, err = tx.ExecContext(ctx, `INSERT INTO user_listening_generation (user_id,generation) VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1`, user); err != nil {
		return err
	}
	for _, table := range []string{"user_listening_session", "user_listening_import", "user_listening_day"} {
		if _, err = tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE user_id = ?`, user); err != nil {
			return err
		}
	}
	return tx.Commit()
}
