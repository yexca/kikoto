package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestUpdateMediaProgressUpsertsCanonicalWorkCursorWithLocationIdentity(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('progress-user', 'Progress User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(701, 'RJ00000000', 'Canonical work'),
			(702, 'RJ00000001', 'Translated work');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (700, 701, 'RJ00000000');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, is_canonical) VALUES
			(701, 700, 'RJ00000000', 1),
			(702, 700, 'RJ00000001', 0);
		INSERT INTO file_source (id, code, display_name, source_type) VALUES
			(711, 'example_remote', 'Example Remote', 'kikoeru_compatible');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(721, 702, 'audio', 'Translated track', 'progress-track');
		INSERT INTO media_file_location (
			id, media_item_id, file_source_id, location_type, path, stream_url, availability
		) VALUES (731, 721, 711, 'remote_stream', 'RJ00000001/track.mp3', 'https://example.invalid/track.mp3', 'remote');
	`); err != nil {
		t.Fatal(err)
	}
	user := account.User{ID: userID, Username: "progress-user", Role: "user", Permissions: account.PermissionsForRole("user")}

	response := patchMediaProgress(t, server, user, 721, `{"locationId":731,"positionSeconds":120,"durationSeconds":100,"completed":false}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var progress mediaProgressResponse
	if err := json.Unmarshal(response.Body.Bytes(), &progress); err != nil {
		t.Fatal(err)
	}
	if progress.WorkID != 701 || progress.MediaWorkID != 702 || progress.MediaItemID != 721 || progress.PositionSeconds != 100 || progress.DurationSeconds == nil || *progress.DurationSeconds != 100 {
		t.Fatalf("progress = %#v", progress)
	}
	if progress.FileSourceID == nil || *progress.FileSourceID != 711 || progress.LocationID == nil || *progress.LocationID != 731 || progress.LocationType != "remote_stream" {
		t.Fatalf("location identity = %#v", progress)
	}

	response = patchMediaProgress(t, server, user, 721, `{"locationId":731,"positionSeconds":45,"durationSeconds":100,"completed":true}`)
	if response.Code != http.StatusOK {
		t.Fatalf("completion status = %d, body = %s", response.Code, response.Body.String())
	}
	var stored struct {
		WorkID          int64
		MediaItemID     int64
		FileSourceID    int64
		LocationID      int64
		LocationType    string
		PositionSeconds float64
		Completed       bool
	}
	if err := db.QueryRow(`
		SELECT work_id, media_item_id, file_source_id, location_id, location_type,
			position_seconds, completed
		FROM user_work_playback_cursor
		WHERE user_id = ?
	`, userID).Scan(
		&stored.WorkID, &stored.MediaItemID, &stored.FileSourceID,
		&stored.LocationID, &stored.LocationType, &stored.PositionSeconds, &stored.Completed,
	); err != nil {
		t.Fatal(err)
	}
	var cursorCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_work_playback_cursor WHERE user_id = ?", userID).Scan(&cursorCount); err != nil {
		t.Fatal(err)
	}
	if cursorCount != 1 || stored.WorkID != 701 || stored.MediaItemID != 721 || stored.FileSourceID != 711 || stored.LocationID != 731 || stored.LocationType != "remote_stream" || stored.PositionSeconds != 45 || !stored.Completed {
		t.Fatalf("stored cursor = %#v", stored)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/works/702/playback-cursor", nil)
	request.SetPathValue("id", "702")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response = httptest.NewRecorder()
	server.getWorkPlaybackCursor(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("cursor status = %d, body = %s", response.Code, response.Body.String())
	}
	var cursorResponse struct {
		Cursor *workProgressSummary `json:"cursor"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &cursorResponse); err != nil {
		t.Fatal(err)
	}
	if cursorResponse.Cursor == nil || cursorResponse.Cursor.WorkID == nil || *cursorResponse.Cursor.WorkID != 701 || cursorResponse.Cursor.MediaWorkID == nil || *cursorResponse.Cursor.MediaWorkID != 702 || cursorResponse.Cursor.MediaItemID == nil || *cursorResponse.Cursor.MediaItemID != 721 || !cursorResponse.Cursor.Completed {
		t.Fatalf("cursor response = %#v", cursorResponse.Cursor)
	}
}

func TestUpdateMediaProgressRejectsLocationFromAnotherMediaItemWithoutReplacingCursor(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('location-user', 'Location User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (741, 'RJ00000002', 'Location work');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (742, 'local-test', 'Local test', 'local');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(743, 741, 'audio', 'First', 'first'),
			(744, 741, 'audio', 'Second', 'second');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(745, 743, 742, 'local', 'first.mp3', 'available'),
			(746, 744, 742, 'local', 'second.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	user := account.User{ID: userID, Username: "location-user", Role: "user", Permissions: account.PermissionsForRole("user")}

	response := patchMediaProgress(t, server, user, 743, `{"locationId":745,"positionSeconds":10,"durationSeconds":100,"completed":false}`)
	if response.Code != http.StatusOK {
		t.Fatalf("initial status = %d, body = %s", response.Code, response.Body.String())
	}
	response = patchMediaProgress(t, server, user, 743, `{"locationId":746,"positionSeconds":20,"durationSeconds":100,"completed":false}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid location status = %d, body = %s", response.Code, response.Body.String())
	}
	var locationID int64
	var position float64
	if err := db.QueryRow("SELECT location_id, position_seconds FROM user_work_playback_cursor WHERE user_id = ? AND work_id = 741", userID).Scan(&locationID, &position); err != nil {
		t.Fatal(err)
	}
	if locationID != 745 || position != 10 {
		t.Fatalf("cursor changed to location %d at %v", locationID, position)
	}
}

func TestUpdateMediaProgressReturnsNotFoundWithoutCreatingCursor(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('missing-progress-user', 'Missing Progress User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	user := account.User{ID: userID, Username: "missing-progress-user", Role: "user", Permissions: account.PermissionsForRole("user")}

	response := patchMediaProgress(t, server, user, 999, `{"positionSeconds":10,"durationSeconds":100,"completed":false}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_work_playback_cursor WHERE user_id = ?", userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("cursor rows = %d", count)
	}
}

func TestCanceledMediaProgressWriteDoesNotBlockTheNextWriter(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('cancel-progress-user', 'Cancel Progress User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (801, 'TEST-WORK-CANCEL-001', 'Cancellation work');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (802, 801, 'audio', 'Track', 'cancel-progress-track');
	`); err != nil {
		t.Fatal(err)
	}
	user := account.User{ID: userID, Username: "cancel-progress-user", Role: "user", Permissions: account.PermissionsForRole("user")}

	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(2)
	connections := make([]*sql.Conn, 2)
	for index := range connections {
		connections[index], err = db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := connections[index].ExecContext(context.Background(), "PRAGMA busy_timeout = 100"); err != nil {
			t.Fatal(err)
		}
	}
	for _, conn := range connections {
		if err := conn.Close(); err != nil {
			t.Fatal(err)
		}
	}

	blocker, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodPatch, "/api/media-items/802/progress", strings.NewReader(`{"positionSeconds":10,"durationSeconds":100,"completed":false}`))
	request.SetPathValue("id", "802")
	request = request.WithContext(context.WithValue(requestCtx, currentUserKey, user))
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		server.updateMediaProgress(response, request)
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for db.Stats().InUse < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if db.Stats().InUse < 2 {
		_ = blocker.Rollback()
		t.Fatal("progress request did not reach the blocked database write")
	}
	cancelRequest()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		_ = blocker.Rollback()
		t.Fatal("canceled progress request did not return")
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}

	next := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		next <- patchMediaProgress(t, server, user, 802, `{"positionSeconds":20,"durationSeconds":100,"completed":false}`)
	}()
	select {
	case response := <-next:
		if response.Code != http.StatusOK {
			t.Fatalf("next progress status = %d, body = %s", response.Code, response.Body.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("next progress write remained blocked after cancellation")
	}
	// On Windows, sqlite3_interrupt cleanup may finish just after the handler
	// returns. Drain the pool before TempDir attempts to remove the database.
	db.SetMaxIdleConns(0)
	closeDeadline := time.Now().Add(time.Second)
	for db.Stats().OpenConnections != 0 && time.Now().Before(closeDeadline) {
		time.Sleep(time.Millisecond)
	}
	if db.Stats().OpenConnections != 0 {
		t.Fatalf("database connections remained open after cancellation: %+v", db.Stats())
	}
}

func patchMediaProgress(t *testing.T, server *Server, user account.User, mediaItemID int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPatch, "/api/media-items/1/progress", strings.NewReader(body))
	request.SetPathValue("id", strconv.FormatInt(mediaItemID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response := httptest.NewRecorder()
	server.updateMediaProgress(response, request)
	return response
}
