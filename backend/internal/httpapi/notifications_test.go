package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestFetchNotificationListsAndDismissesForOwner(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, err := db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES ('notify-user', 'Notify User', 'user')`)
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	runResult, err := db.Exec(`
		INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type, input_json)
		VALUES ('remote_work_fetch', 'Fetch remote work', 'succeeded', 'manual', '{}')
	`)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := runResult.LastInsertId()
	server := NewServer(db, config.Config{})
	payload := remoteWorkFetchJobPayload{RequestedByUserID: userID, WorkCode: "RJ09999997"}
	if err := server.createRemoteFetchNotification(context.Background(), runID, "succeeded", payload); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/notifications", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: userID, Permissions: []string{"library:read"}}))
	response := httptest.NewRecorder()
	server.listNotifications(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list status = %d body = %s", response.Code, response.Body.String())
	}
	var page struct {
		Notifications []workflowNotificationRecord `json:"notifications"`
		Total         int64                        `json:"total"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Notifications) != 1 || page.Notifications[0].WorkCode != "RJ09999997" {
		t.Fatalf("notification page = %+v", page)
	}

	dismiss := httptest.NewRequest(http.MethodDelete, "/api/notifications/1", nil)
	dismiss.SetPathValue("id", strconv.FormatInt(page.Notifications[0].ID, 10))
	dismiss = dismiss.WithContext(context.WithValue(dismiss.Context(), currentUserKey, currentUser{ID: userID, Permissions: []string{"library:read"}}))
	dismissResponse := httptest.NewRecorder()
	server.dismissNotification(dismissResponse, dismiss)
	if dismissResponse.Code != http.StatusOK {
		t.Fatalf("dismiss status = %d body = %s", dismissResponse.Code, dismissResponse.Body.String())
	}

	response = httptest.NewRecorder()
	server.listNotifications(response, request)
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 || len(page.Notifications) != 0 {
		t.Fatalf("notification remained after dismissal: %+v", page)
	}
}

func TestFetchNotificationCompletesSubscriberWithoutOriginalRequestUser(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, err := db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES ('subscriber', 'Subscriber', 'user')`)
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	runResult, err := db.Exec(`
		INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type, input_json)
		VALUES ('remote_work_fetch', 'Fetch remote work', 'succeeded', 'manual', '{"work_code":"RJ09999996"}')
	`)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := runResult.LastInsertId()
	if err := subscribeRemoteFetchNotification(context.Background(), db, userID, runID, 0, "RJ09999996"); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	if err := server.createRemoteFetchNotification(context.Background(), runID, "succeeded", remoteWorkFetchJobPayload{WorkCode: "RJ09999996"}); err != nil {
		t.Fatal(err)
	}

	var status, message string
	if err := db.QueryRow(`SELECT status, message FROM workflow_notification WHERE user_id = ? AND workflow_run_id = ?`, userID, runID).Scan(&status, &message); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || message != "Fetch completed for RJ09999996." {
		t.Fatalf("notification status = %q message = %q", status, message)
	}
}
