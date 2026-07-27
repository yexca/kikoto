package httpapi

import (
	"context"
	"database/sql"
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
	WorkCode      string `json:"workCode"`
	Message       string `json:"message"`
	CreatedAt     string `json:"createdAt"`
}

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	limit := 20
	if parsed, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && parsed > 0 {
		limit = min(parsed, 100)
	}
	var total int64
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COUNT(*) FROM workflow_notification
		WHERE user_id = ? AND dismissed_at IS NULL AND status IN ('succeeded', 'failed')
	`, actor.ID).Scan(&total); err != nil {
		writeError(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, workflow_run_id, notification_type, status, work_id, work_code, message, created_at
		FROM workflow_notification
		WHERE user_id = ? AND dismissed_at IS NULL AND status IN ('succeeded', 'failed')
		ORDER BY created_at DESC, id DESC
		LIMIT ?
	`, actor.ID, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	notifications := []workflowNotificationRecord{}
	for rows.Next() {
		var item workflowNotificationRecord
		var workID sql.NullInt64
		if err := rows.Scan(&item.ID, &item.WorkflowRunID, &item.Type, &item.Status, &workID, &item.WorkCode, &item.Message, &item.CreatedAt); err != nil {
			writeError(w, err)
			return
		}
		if workID.Valid {
			item.WorkID = &workID.Int64
		}
		notifications = append(notifications, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notifications": notifications, "total": total})
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

func nullableSQLInt64(value sql.NullInt64) any {
	if !value.Valid {
		return nil
	}
	return value.Int64
}
