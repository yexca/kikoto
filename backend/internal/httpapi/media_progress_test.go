package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestUpdateMediaProgressUpsertsAndReturnsProgress(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('progress-user', 'Progress User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999201', 'Progress work')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	mediaResult, err := db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'audio', 'Track', 'progress-track')", workID)
	if err != nil {
		t.Fatal(err)
	}
	mediaItemID, _ := mediaResult.LastInsertId()
	user := account.User{ID: userID, Username: "progress-user", Role: "user", Permissions: account.PermissionsForRole("user")}

	request := httptest.NewRequest(http.MethodPatch, "/api/media-items/1/progress", strings.NewReader(`{"positionSeconds":120,"durationSeconds":100,"completed":false}`))
	request.SetPathValue("id", "1")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response := httptest.NewRecorder()
	server.updateMediaProgress(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var progress mediaProgressResponse
	if err := json.Unmarshal(response.Body.Bytes(), &progress); err != nil {
		t.Fatal(err)
	}
	if progress.MediaItemID != mediaItemID || progress.PositionSeconds != 100 || progress.DurationSeconds == nil || *progress.DurationSeconds != 100 {
		t.Fatalf("progress = %#v", progress)
	}

	request = httptest.NewRequest(http.MethodPatch, "/api/media-items/1/progress", strings.NewReader(`{"positionSeconds":45,"durationSeconds":100,"completed":true}`))
	request.SetPathValue("id", "1")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response = httptest.NewRecorder()
	server.updateMediaProgress(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", response.Code, response.Body.String())
	}
	if err := db.QueryRow("SELECT position_seconds, completed FROM user_media_progress WHERE user_id = ? AND media_item_id = ?", userID, mediaItemID).Scan(&progress.PositionSeconds, &progress.Completed); err != nil {
		t.Fatal(err)
	}
	if progress.PositionSeconds != 45 || !progress.Completed {
		t.Fatalf("stored progress = %#v", progress)
	}
}

func TestUpdateMediaProgressReturnsNotFoundWithoutCreatingProgress(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('missing-progress-user', 'Missing Progress User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	user := account.User{ID: userID, Username: "missing-progress-user", Role: "user", Permissions: account.PermissionsForRole("user")}
	request := httptest.NewRequest(http.MethodPatch, "/api/media-items/999/progress", strings.NewReader(`{"positionSeconds":10,"durationSeconds":100,"completed":false}`))
	request.SetPathValue("id", "999")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response := httptest.NewRecorder()

	server.updateMediaProgress(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_media_progress WHERE user_id = ?", userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("progress rows = %d", count)
	}
}
