package personal

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"regexp"
	"strings"
	"time"
)

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{7,79}$`)

type SessionInput struct {
	Generation      int64        `json:"generation"`
	SessionID       string       `json:"sessionId"`
	WorkID          int64        `json:"workId"`
	ListenedSeconds float64      `json:"listenedSeconds"`
	StartedAt       string       `json:"startedAt,omitempty"`
	LastListenedAt  string       `json:"lastListenedAt,omitempty"`
	Days            []SessionDay `json:"days,omitempty"`
}

type SessionDay struct {
	Day             string  `json:"day"`
	ListenedSeconds float64 `json:"listenedSeconds"`
}

func validNumber(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 }

func (s Store) ListeningGeneration(ctx context.Context, user int64) (int64, error) {
	var generation int64
	err := s.DB.QueryRowContext(ctx, `SELECT COALESCE((SELECT generation FROM user_listening_generation WHERE user_id=?),0)`, user).Scan(&generation)
	return generation, err
}

func (s Store) RecordSession(ctx context.Context, user int64, input SessionInput) error {
	if !validSession(input) {
		return ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err = recordSessionTx(ctx, tx, user, input); err != nil {
		return err
	}
	return tx.Commit()
}

func validSession(input SessionInput) bool {
	if input.Generation < 0 || !sessionIDPattern.MatchString(input.SessionID) || input.WorkID <= 0 || !validNumber(input.ListenedSeconds) || input.ListenedSeconds <= 0 || input.ListenedSeconds > 86400 {
		return false
	}
	if len(input.Days) == 0 {
		return input.StartedAt == "" && input.LastListenedAt == ""
	}
	if len(input.Days) > 32 {
		return false
	}
	start, e1 := time.Parse(time.RFC3339Nano, input.StartedAt)
	end, e2 := time.Parse(time.RFC3339Nano, input.LastListenedAt)
	if e1 != nil || e2 != nil || end.Before(start) || end.After(time.Now().Add(5*time.Minute)) {
		return false
	}
	first, last := start.UTC().Format("2006-01-02"), end.UTC().Format("2006-01-02")
	previous := ""
	total := 0.0
	for _, day := range input.Days {
		parsed, err := time.Parse("2006-01-02", day.Day)
		if err != nil || parsed.Format("2006-01-02") != day.Day || day.Day <= previous || day.Day < first || day.Day > last || !validNumber(day.ListenedSeconds) || day.ListenedSeconds <= 0 {
			return false
		}
		previous = day.Day
		total += day.ListenedSeconds
	}
	return math.Abs(total-input.ListenedSeconds) < 0.000001
}

// recordSessionTx shares the caller's transaction with an independent resume
// checkpoint. Expected history rejections do not mutate either history table.
func recordSessionTx(ctx context.Context, tx *sql.Tx, user int64, input SessionInput) error {
	if !validSession(input) {
		return ErrInvalid
	}
	var err error
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
	var dated bool
	var started string
	err = tx.QueryRowContext(ctx, `SELECT work_id,listened_seconds,dated_report,created_at FROM user_listening_session WHERE user_id = ? AND session_id = ?`, user, input.SessionID).Scan(&storedWork, &previous, &dated, &started)
	newSession := errors.Is(err, sql.ErrNoRows)
	if err != nil && !newSession {
		return err
	}
	if !newSession && storedWork != work {
		return ErrConflict
	}
	if !newSession && dated != (len(input.Days) > 0) {
		return ErrConflict
	}
	if !newSession && input.ListenedSeconds <= previous {
		return nil
	}
	if len(input.Days) > 0 {
		return recordDatedSession(ctx, tx, user, work, input, newSession, started)
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
	return nil
}

func recordDatedSession(ctx context.Context, tx *sql.Tx, user, work int64, input SessionInput, newSession bool, storedStart string) error {
	start, _ := time.Parse(time.RFC3339Nano, input.StartedAt)
	end, _ := time.Parse(time.RFC3339Nano, input.LastListenedAt)
	started := start.UTC().Format("2006-01-02 15:04:05")
	if !newSession && storedStart != started {
		return ErrConflict
	}
	previous := map[string]float64{}
	rows, err := tx.QueryContext(ctx, `SELECT day,listened_seconds FROM user_listening_session_day WHERE user_id=? AND session_id=?`, user, input.SessionID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var day string
		var seconds float64
		if err = rows.Scan(&day, &seconds); err != nil {
			_ = rows.Close()
			return err
		}
		previous[day] = seconds
	}
	if err = rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	for _, day := range input.Days {
		if day.ListenedSeconds < previous[day.Day] {
			return ErrConflict
		}
		delete(previous, day.Day)
	}
	if len(previous) > 0 {
		return ErrConflict
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO user_listening_session (user_id,session_id,work_id,listened_seconds,created_at,updated_at,dated_report) VALUES (?,?,?,?,?,?,1) ON CONFLICT(user_id,session_id) DO UPDATE SET listened_seconds=excluded.listened_seconds,updated_at=MAX(updated_at,excluded.updated_at)`, user, input.SessionID, work, input.ListenedSeconds, started, end.UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return err
	}
	for _, day := range input.Days {
		var before float64
		if err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT listened_seconds FROM user_listening_session_day WHERE user_id=? AND session_id=? AND day=?),0)`, user, input.SessionID, day.Day).Scan(&before); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO user_listening_session_day (user_id,session_id,day,listened_seconds) VALUES (?,?,?,?) ON CONFLICT(user_id,session_id,day) DO UPDATE SET listened_seconds=excluded.listened_seconds`, user, input.SessionID, day.Day, day.ListenedSeconds); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO user_listening_day (user_id,work_id,day,listened_seconds) VALUES (?,?,?,?) ON CONFLICT(user_id,work_id,day) DO UPDATE SET listened_seconds=listened_seconds+excluded.listened_seconds`, user, work, day.Day, day.ListenedSeconds-before); err != nil {
			return err
		}
	}
	if newSession {
		_, err = tx.ExecContext(ctx, `INSERT INTO user_listening_day (user_id,work_id,day,listen_count) VALUES (?,?,?,1) ON CONFLICT(user_id,work_id,day) DO UPDATE SET listen_count=listen_count+1`, user, work, start.UTC().Format("2006-01-02"))
	}
	return err
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
	// CoverURL is filled by the HTTP layer, which owns the cover cache.
	CoverURL string `json:"coverUrl"`
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
