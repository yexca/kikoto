package workflow

import (
	"context"
	"database/sql"
)

// NotificationSpec is a finished run's notification for one user.
type NotificationSpec struct {
	UserID   int64
	RunID    int64
	Type     string
	Status   string
	WorkID   int64
	WorkCode string
	Message  string
}

// InsertNotification adds a notification for a run, once per user, run, and
// type. It goes with the run when the run is deleted.
func InsertNotification(ctx context.Context, tx *sql.Tx, spec NotificationSpec) error {
	var workID any
	if spec.WorkID > 0 {
		workID = spec.WorkID
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_notification (user_id, workflow_run_id, notification_type, status, work_id, work_code, message)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO NOTHING
	`, spec.UserID, spec.RunID, spec.Type, spec.Status, workID, spec.WorkCode, spec.Message)
	return err
}
