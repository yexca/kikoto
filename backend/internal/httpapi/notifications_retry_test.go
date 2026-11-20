package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A Fetch or Track that fails, has its failure dismissed, and then succeeds
// on retry notifies again; repeating the same outcome keeps a dismissal.
func TestRetriedSuccessNotifiesAfterADismissedFailure(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'notify-user', 'Notify User', 'user');
		INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, input_json)
		VALUES (1, 'remote_work_fetch', 'Fetch remote work', 'failed', 'manual', '{}'),
			(2, 'remote_work_track', 'Track remote work', 'failed', 'manual', '{}');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	notify := map[int64]func(status string) error{
		1: func(status string) error {
			return server.createRemoteFetchNotification(ctx, 1, status, remoteWorkFetchJobPayload{RequestedByUserID: 1, WorkCode: "RJ00000016"})
		},
		2: func(status string) error {
			return server.createRemoteTrackNotification(ctx, 2, status, remoteWorkTrackJobPayload{RequestedByUserID: 1, WorkCode: "RJ00000016"})
		},
	}
	visible := func(runID int64) bool {
		t.Helper()
		var shown bool
		if err := db.QueryRow(`SELECT dismissed_at IS NULL FROM workflow_notification WHERE workflow_run_id = ?`, runID).Scan(&shown); err != nil {
			t.Fatal(err)
		}
		return shown
	}
	for runID, record := range notify {
		if err := record("failed"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE workflow_notification SET dismissed_at = CURRENT_TIMESTAMP WHERE workflow_run_id = ?`, runID); err != nil {
			t.Fatal(err)
		}
		if err := record("failed"); err != nil {
			t.Fatal(err)
		}
		if visible(runID) {
			t.Fatalf("run %d: the same failure came back after it was dismissed", runID)
		}
		if _, err := db.Exec(`UPDATE workflow_run SET status = 'succeeded' WHERE id = ?`, runID); err != nil {
			t.Fatal(err)
		}
		if err := record("succeeded"); err != nil {
			t.Fatal(err)
		}
		if !visible(runID) {
			t.Fatalf("run %d: the success after a dismissed failure is not shown", runID)
		}
	}
}
