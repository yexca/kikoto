package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// The badge is decided by the server: undismissed notifications plus the runs
// that need attention, each counted only for an account that may see it.
func TestNotificationSummaryCountsNotificationsAndAttentionPerPermission(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, err := db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES ('summary-user', 'Summary User', 'user')`)
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	fetchRun, err := db.Exec(`INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type, input_json) VALUES ('remote_work_fetch', 'Fetch remote work', 'succeeded', 'manual', '{}')`)
	if err != nil {
		t.Fatal(err)
	}
	fetchRunID, _ := fetchRun.LastInsertId()
	for _, statement := range []string{
		`INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type) VALUES ('local_library_scan', 'Failed scan', 'failed', 'manual')`,
		`INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type) VALUES ('local_library_scan', 'Running scan', 'running', 'manual')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	if err := server.createRemoteFetchNotification(context.Background(), fetchRunID, "succeeded", remoteWorkFetchJobPayload{RequestedByUserID: userID, WorkCode: "RJ00000001"}); err != nil {
		t.Fatal(err)
	}

	summaryFor := func(permissions ...string) (int, notificationSummary) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/notifications/summary", nil)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: userID, Permissions: permissions}))
		response := httptest.NewRecorder()
		server.notificationSummary(response, request)
		var summary notificationSummary
		if response.Code == http.StatusOK {
			if err := json.Unmarshal(response.Body.Bytes(), &summary); err != nil {
				t.Fatal(err)
			}
		}
		return response.Code, summary
	}

	code, full := summaryFor("library:read", "workflows:run")
	if code != http.StatusOK || full.UnreadCount != 2 || full.Notifications == nil || full.Notifications.Total != 1 ||
		full.Attention == nil || full.Attention.Total != 1 || len(full.Attention.Runs) != 1 ||
		full.Attention.Running != 1 || full.Attention.RunningRun == nil || full.Attention.RunningRun.DisplayName != "Running scan" {
		t.Fatalf("summary = %d %+v", code, full)
	}
	code, library := summaryFor("library:read")
	if code != http.StatusOK || library.UnreadCount != 1 || library.Attention != nil || library.Notifications == nil {
		t.Fatalf("library-only summary = %d %+v", code, library)
	}
	code, operator := summaryFor("workflows:run")
	if code != http.StatusOK || operator.UnreadCount != 1 || operator.Notifications != nil || operator.Attention == nil {
		t.Fatalf("workflow-only summary = %d %+v", code, operator)
	}
	if code, _ := summaryFor(); code != http.StatusForbidden {
		t.Fatalf("summary without either permission = %d", code)
	}
}
