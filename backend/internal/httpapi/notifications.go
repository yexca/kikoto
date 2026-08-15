package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

type workflowNotificationRecord struct {
	ID            int64  `json:"id"`
	WorkflowRunID int64  `json:"workflowRunId"`
	Type          string `json:"type"`
	Status        string `json:"status"`
	WorkID        *int64 `json:"workId"`
	FileSourceID  *int64 `json:"fileSourceId"`
	WorkCode      string `json:"workCode"`
	Message       string `json:"message"`
	CreatedAt     string `json:"createdAt"`
}

type workflowNotificationsPage struct {
	Notifications  []workflowNotificationRecord `json:"notifications"`
	Page           int                          `json:"page"`
	PageSize       int                          `json:"pageSize"`
	Total          int64                        `json:"total"`
	TotalPages     int                          `json:"totalPages"`
	ClearableTotal int64                        `json:"clearableTotal"`
}

const (
	defaultNotificationPageSize = 50
	maxNotificationPageSize     = 100
	maxNotificationPage         = 100000
)

const clearableNotificationTypesSQL = "'remote_fetch', 'remote_track'"

type remoteTrackRunStatus struct {
	RunID       int64  `json:"runId"`
	Status      string `json:"status"`
	SummaryJSON string `json:"summaryJson"`
}

func (s *Server) getRemoteTrackRunStatus(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	runID, err := parseInt64PathValue(r, "id")
	if err != nil || runID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid track run id"})
		return
	}
	var result remoteTrackRunStatus
	err = s.db.QueryRowContext(r.Context(), `
		SELECT run.id, run.status, run.summary_json
		FROM workflow_run AS run
		INNER JOIN workflow_notification AS notification
			ON notification.workflow_run_id = run.id
			AND notification.user_id = ?
			AND notification.notification_type = 'remote_track'
		WHERE run.id = ? AND run.workflow_code = 'remote_source_sync'
	`, actor.ID, runID).Scan(&result.RunID, &result.Status, &result.SummaryJSON)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "track run not found"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	page, pageSize := notificationPageParams(r)
	var total int64
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COUNT(*) FROM workflow_notification
		WHERE user_id = ? AND dismissed_at IS NULL AND status IN ('succeeded', 'failed')
	`, actor.ID).Scan(&total); err != nil {
		writeError(w, err)
		return
	}
	var clearableTotal int64
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COUNT(*) FROM workflow_notification
		WHERE user_id = ? AND dismissed_at IS NULL AND status = 'succeeded'
			AND notification_type IN (`+clearableNotificationTypesSQL+`)
	`, actor.ID).Scan(&clearableTotal); err != nil {
		writeError(w, err)
		return
	}
	totalPages := max(1, (int(total)+pageSize-1)/pageSize)
	if page > totalPages {
		page = totalPages
	}
	offset := (page - 1) * pageSize
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT notification.id, notification.workflow_run_id, notification.notification_type,
			notification.status, notification.work_id,
			NULLIF(CAST(json_extract(run.input_json, '$.source_id') AS INTEGER), 0),
			notification.work_code, notification.message, notification.created_at
		FROM workflow_notification AS notification
		INNER JOIN workflow_run AS run ON run.id = notification.workflow_run_id
		WHERE notification.user_id = ? AND notification.dismissed_at IS NULL AND notification.status IN ('succeeded', 'failed')
		ORDER BY notification.created_at DESC, notification.id DESC
		LIMIT ? OFFSET ?
	`, actor.ID, pageSize, offset)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	notifications := []workflowNotificationRecord{}
	for rows.Next() {
		var item workflowNotificationRecord
		var workID sql.NullInt64
		var fileSourceID sql.NullInt64
		if err := rows.Scan(&item.ID, &item.WorkflowRunID, &item.Type, &item.Status, &workID, &fileSourceID, &item.WorkCode, &item.Message, &item.CreatedAt); err != nil {
			writeError(w, err)
			return
		}
		if workID.Valid {
			item.WorkID = &workID.Int64
		}
		if fileSourceID.Valid {
			item.FileSourceID = &fileSourceID.Int64
		}
		notifications = append(notifications, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workflowNotificationsPage{
		Notifications:  notifications,
		Page:           page,
		PageSize:       pageSize,
		Total:          total,
		TotalPages:     totalPages,
		ClearableTotal: clearableTotal,
	})
}

func notificationPageParams(r *http.Request) (int, int) {
	page := 1
	pageSize := defaultNotificationPageSize
	if parsed, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("page"))); err == nil && parsed > 0 {
		page = min(parsed, maxNotificationPage)
	}
	pageSizeValue := strings.TrimSpace(r.URL.Query().Get("pageSize"))
	if pageSizeValue == "" {
		// Keep the old limit parameter working for API clients during the
		// transition to page/pageSize.
		pageSizeValue = strings.TrimSpace(r.URL.Query().Get("limit"))
	}
	if parsed, err := strconv.Atoi(pageSizeValue); err == nil && parsed > 0 {
		pageSize = min(parsed, maxNotificationPageSize)
	}
	return page, pageSize
}

func (s *Server) dismissNotification(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid notification id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		UPDATE workflow_notification
		SET dismissed_at = CURRENT_TIMESTAMP
		WHERE id = ? AND user_id = ? AND dismissed_at IS NULL
	`, id, actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "notification not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) clearSucceededNotifications(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		UPDATE workflow_notification
		SET dismissed_at = CURRENT_TIMESTAMP
		WHERE user_id = ? AND dismissed_at IS NULL AND status = 'succeeded'
			AND notification_type IN (`+clearableNotificationTypesSQL+`)
	`, actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	affected, _ := result.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dismissed": affected})
}

func (s *Server) createRemoteFetchNotification(ctx context.Context, runID int64, status string, payload remoteWorkFetchJobPayload) error {
	if runID <= 0 {
		return nil
	}
	status = strings.TrimSpace(status)
	if status != "succeeded" && status != "failed" {
		return nil
	}
	var runStatus string
	if err := s.db.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&runStatus); err != nil {
		return err
	}
	if runStatus != status {
		return nil
	}
	code := strings.ToUpper(strings.TrimSpace(payload.WorkCode))
	var workID sql.NullInt64
	var editionCode sql.NullString
	_ = s.db.QueryRowContext(ctx, `
		SELECT work_id, edition_code FROM remote_fetch_manifest WHERE workflow_run_id = ?
	`, runID).Scan(&workID, &editionCode)
	if editionCode.Valid && strings.TrimSpace(editionCode.String) != "" {
		code = strings.ToUpper(strings.TrimSpace(editionCode.String))
	}
	message := "Fetch completed for " + code + "."
	if status == "failed" {
		message = "Fetch failed for " + code + "."
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_notification
		SET status = ?, work_id = COALESCE(?, work_id), work_code = ?, message = ?
		WHERE workflow_run_id = ? AND notification_type = 'remote_fetch'
	`, status, nullableSQLInt64(workID), code, message, runID); err != nil {
		return err
	}
	if payload.RequestedByUserID <= 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO workflow_notification (
			user_id, workflow_run_id, notification_type, status, work_id, work_code, message
		)
		VALUES (?, ?, 'remote_fetch', ?, ?, ?, ?)
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO UPDATE SET
			status = excluded.status,
			work_id = excluded.work_id,
			work_code = excluded.work_code,
			message = excluded.message
	`, payload.RequestedByUserID, runID, status, nullableSQLInt64(workID), code, message)
	return err
}

type contextExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func subscribeRemoteFetchNotification(ctx context.Context, execer contextExecer, userID, runID, workID int64, workCode string) error {
	if userID <= 0 || runID <= 0 {
		return nil
	}
	var nullableWorkID any
	if workID > 0 {
		nullableWorkID = workID
	}
	_, err := execer.ExecContext(ctx, `
		INSERT INTO workflow_notification (
			user_id, workflow_run_id, notification_type, status, work_id, work_code
		)
		VALUES (?, ?, 'remote_fetch', 'pending', ?, ?)
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO NOTHING
	`, userID, runID, nullableWorkID, strings.ToUpper(strings.TrimSpace(workCode)))
	return err
}

func (s *Server) createRemoteTrackNotification(ctx context.Context, runID int64, status string, payload remoteWorkTrackJobPayload) error {
	if runID <= 0 {
		return nil
	}
	status = strings.TrimSpace(status)
	if status != "succeeded" && status != "failed" {
		return nil
	}
	var runStatus string
	var workID sql.NullInt64
	var primaryCode sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT status,
			NULLIF(CAST(json_extract(summary_json, '$.work_id') AS INTEGER), 0),
			CAST(json_extract(summary_json, '$.primary_code') AS TEXT)
		FROM workflow_run
		WHERE id = ?
	`, runID).Scan(&runStatus, &workID, &primaryCode); err != nil {
		return err
	}
	if runStatus != status {
		return nil
	}
	code := strings.ToUpper(strings.TrimSpace(payload.WorkCode))
	if primaryCode.Valid && strings.TrimSpace(primaryCode.String) != "" {
		code = strings.ToUpper(strings.TrimSpace(primaryCode.String))
	}
	message := "Track completed for " + code + "."
	if status == "failed" {
		message = "Track failed for " + code + "."
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_notification
		SET status = ?, work_id = COALESCE(?, work_id), work_code = ?, message = ?
		WHERE workflow_run_id = ? AND notification_type = 'remote_track'
	`, status, nullableSQLInt64(workID), code, message, runID); err != nil {
		return err
	}
	if payload.RequestedByUserID <= 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO workflow_notification (
			user_id, workflow_run_id, notification_type, status, work_id, work_code, message
		)
		VALUES (?, ?, 'remote_track', ?, ?, ?, ?)
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO UPDATE SET
			status = excluded.status,
			work_id = excluded.work_id,
			work_code = excluded.work_code,
			message = excluded.message
	`, payload.RequestedByUserID, runID, status, nullableSQLInt64(workID), code, message)
	return err
}

func subscribeRemoteTrackNotification(ctx context.Context, execer contextExecer, userID, runID int64, workID *int64, workCode string) error {
	if userID <= 0 || runID <= 0 {
		return nil
	}
	var nullableWorkID any
	if workID != nil && *workID > 0 {
		nullableWorkID = *workID
	}
	_, err := execer.ExecContext(ctx, `
		INSERT INTO workflow_notification (
			user_id, workflow_run_id, notification_type, status, work_id, work_code
		)
		VALUES (?, ?, 'remote_track', 'pending', ?, ?)
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO NOTHING
	`, userID, runID, nullableWorkID, strings.ToUpper(strings.TrimSpace(workCode)))
	return err
}

func nullableSQLInt64(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}
