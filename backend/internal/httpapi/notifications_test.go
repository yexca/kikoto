package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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
	payload := remoteWorkFetchJobPayload{RequestedByUserID: userID, WorkCode: "RJ00000001"}
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
	if page.Total != 1 || len(page.Notifications) != 1 || page.Notifications[0].WorkCode != "RJ00000001" {
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
		VALUES ('remote_work_fetch', 'Fetch remote work', 'succeeded', 'manual', '{"work_code":"RJ00000000"}')
	`)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := runResult.LastInsertId()
	if err := subscribeRemoteFetchNotification(context.Background(), db, userID, runID, 0, "RJ00000000"); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	if err := server.createRemoteFetchNotification(context.Background(), runID, "succeeded", remoteWorkFetchJobPayload{WorkCode: "RJ00000000"}); err != nil {
		t.Fatal(err)
	}

	var status, message string
	if err := db.QueryRow(`SELECT status, message FROM workflow_notification WHERE user_id = ? AND workflow_run_id = ?`, userID, runID).Scan(&status, &message); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || message != "Fetch completed for RJ00000000." {
		t.Fatalf("notification status = %q message = %q", status, message)
	}
}

func TestNotificationsPaginateAndClearOnlyClearableSucceededTypes(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, err := db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES ('notify-page-user', 'Notify Page User', 'user')`)
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	otherUserResult, err := db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES ('notify-page-other', 'Notify Page Other', 'user')`)
	if err != nil {
		t.Fatal(err)
	}
	otherUserID, _ := otherUserResult.LastInsertId()

	insertNotification := func(ownerID int64, notificationType, status string) {
		t.Helper()
		runResult, runErr := db.Exec(`
			INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type, input_json)
			VALUES (?, ?, ?, 'manual', '{}')
		`, notificationType, notificationType, status)
		if runErr != nil {
			t.Fatal(runErr)
		}
		runID, _ := runResult.LastInsertId()
		if _, runErr = db.Exec(`
			INSERT INTO workflow_notification (user_id, workflow_run_id, notification_type, status, work_code, message)
			VALUES (?, ?, ?, ?, 'RJ00000000', ?)
		`, ownerID, runID, notificationType, status, notificationType); runErr != nil {
			t.Fatal(runErr)
		}
	}

	insertNotification(userID, "remote_fetch", "succeeded")
	insertNotification(userID, "remote_track", "succeeded")
	insertNotification(userID, "future_review_action", "succeeded")
	insertNotification(userID, "remote_fetch", "failed")
	insertNotification(otherUserID, "remote_fetch", "succeeded")

	server := NewServer(db, config.Config{})
	requestFor := func(ownerID int64, method, path string) *http.Request {
		request := httptest.NewRequest(method, path, nil)
		return request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: ownerID, Permissions: []string{"library:read"}}))
	}

	pageRequest := requestFor(userID, http.MethodGet, "/api/notifications?page=1&pageSize=2")
	pageResponse := httptest.NewRecorder()
	server.listNotifications(pageResponse, pageRequest)
	if pageResponse.Code != http.StatusOK {
		t.Fatalf("page status = %d body = %s", pageResponse.Code, pageResponse.Body.String())
	}
	var page workflowNotificationsPage
	if err := json.Unmarshal(pageResponse.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Page != 1 || page.PageSize != 2 || page.Total != 4 || page.TotalPages != 2 || page.ClearableTotal != 2 || len(page.Notifications) != 2 {
		t.Fatalf("page = %+v", page)
	}

	pageRequest = requestFor(userID, http.MethodGet, "/api/notifications?page=2&pageSize=2")
	pageResponse = httptest.NewRecorder()
	server.listNotifications(pageResponse, pageRequest)
	if err := json.Unmarshal(pageResponse.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Page != 2 || len(page.Notifications) != 2 {
		t.Fatalf("second page = %+v", page)
	}

	clearRequest := requestFor(userID, http.MethodPost, "/api/notifications/clear-succeeded")
	clearResponse := httptest.NewRecorder()
	server.clearSucceededNotifications(clearResponse, clearRequest)
	if clearResponse.Code != http.StatusOK || !strings.Contains(clearResponse.Body.String(), `"dismissed":2`) {
		t.Fatalf("clear response = %d %s", clearResponse.Code, clearResponse.Body.String())
	}

	var active, otherActive int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_notification WHERE user_id = ? AND dismissed_at IS NULL`, userID).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_notification WHERE user_id = ? AND dismissed_at IS NULL`, otherUserID).Scan(&otherActive); err != nil {
		t.Fatal(err)
	}
	if active != 2 || otherActive != 1 {
		t.Fatalf("active notifications = %d, other user = %d; want 2 and 1", active, otherActive)
	}
}
