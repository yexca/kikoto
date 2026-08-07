package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

type fakeFilesystemWatcher struct {
	changes     chan struct{}
	invalidated chan struct{}
	errors      chan error
	count       int
}

func newFakeFilesystemWatcher(count int) *fakeFilesystemWatcher {
	return &fakeFilesystemWatcher{
		changes:     make(chan struct{}, 16),
		invalidated: make(chan struct{}, 1),
		errors:      make(chan error, 4),
		count:       count,
	}
}

func (w *fakeFilesystemWatcher) Changes() <-chan struct{}     { return w.changes }
func (w *fakeFilesystemWatcher) Invalidated() <-chan struct{} { return w.invalidated }
func (w *fakeFilesystemWatcher) Errors() <-chan error         { return w.errors }
func (w *fakeFilesystemWatcher) WatchedDirectoryCount() int   { return w.count }

func TestFilesystemTriggerQueuesDebouncedDirectoryEvent(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 3})
	watcher := newFakeFilesystemWatcher(7)
	startFilesystemWatcherSession(t, server, watcher, 20*time.Millisecond, 20*time.Millisecond)

	watcher.changes <- struct{}{}
	watcher.changes <- struct{}{}
	watcher.changes <- struct{}{}
	waitForFilesystemRunCount(t, db, 1)
	time.Sleep(60 * time.Millisecond)
	assertFilesystemRunCount(t, db, 1)

	var triggerType, triggerReason, inputJSON string
	if err := db.QueryRow("SELECT trigger_type, trigger_reason, input_json FROM workflow_run WHERE trigger_type = 'filesystem_event'").Scan(&triggerType, &triggerReason, &inputJSON); err != nil {
		t.Fatal(err)
	}
	if triggerType != "filesystem_event" || triggerReason != "data_directories_changed" || !strings.Contains(inputJSON, `"directory_event_at"`) || !strings.Contains(inputJSON, `"observed_directories":7`) {
		t.Fatalf("filesystem run = type %q reason %q input %s", triggerType, triggerReason, inputJSON)
	}
	if strings.Contains(inputJSON, `"follow_up_run":true`) {
		t.Fatalf("filesystem run unexpectedly enabled metadata follow-up: %s", inputJSON)
	}
}

func TestFilesystemTriggerCoalescesChangeDuringActiveRun(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 3})
	watcher := newFakeFilesystemWatcher(3)
	startFilesystemWatcherSession(t, server, watcher, 15*time.Millisecond, 15*time.Millisecond)

	watcher.changes <- struct{}{}
	waitForFilesystemRunCount(t, db, 1)
	watcher.changes <- struct{}{}
	time.Sleep(40 * time.Millisecond)
	assertFilesystemRunCount(t, db, 1)
	if _, err := db.Exec("UPDATE workflow_run SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP WHERE trigger_type = 'filesystem_event'"); err != nil {
		t.Fatal(err)
	}
	waitForFilesystemRunCount(t, db, 2)
	time.Sleep(40 * time.Millisecond)
	assertFilesystemRunCount(t, db, 2)
}

func TestFilesystemTriggerPauseDiscardsPendingAndPausedEvents(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2})
	watcher := newFakeFilesystemWatcher(2)
	startFilesystemWatcherSession(t, server, watcher, 25*time.Millisecond, 15*time.Millisecond)

	watcher.changes <- struct{}{}
	if _, err := db.Exec("UPDATE workflow_trigger SET enabled = 0 WHERE trigger_type = 'filesystem_event'"); err != nil {
		t.Fatal(err)
	}
	server.notifyFilesystemTriggerConfigChanged()
	waitForFilesystemTriggerNotification(t, server)
	time.Sleep(40 * time.Millisecond)
	assertFilesystemRunCount(t, db, 0)

	watcher.changes <- struct{}{}
	time.Sleep(40 * time.Millisecond)
	if _, err := db.Exec("UPDATE workflow_trigger SET enabled = 1 WHERE trigger_type = 'filesystem_event'"); err != nil {
		t.Fatal(err)
	}
	server.notifyFilesystemTriggerConfigChanged()
	waitForFilesystemTriggerNotification(t, server)
	time.Sleep(40 * time.Millisecond)
	assertFilesystemRunCount(t, db, 0)

	watcher.changes <- struct{}{}
	waitForFilesystemRunCount(t, db, 1)
}

func TestFilesystemWatcherErrorRecordsFailureAndQueuesRecoveryScan(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2})
	watcher := newFakeFilesystemWatcher(4)
	startFilesystemWatcherSession(t, server, watcher, 40*time.Millisecond, 15*time.Millisecond)

	watcher.errors <- errors.New("event queue overflow")
	waitForFilesystemTriggerError(t, db, filesystemTriggerErrorPrefix+"event queue overflow")
	waitForFilesystemRunCount(t, db, 1)
}

func TestFilesystemWatcherSessionRequestsReconfigureAfterScanDepthChange(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2})
	watcher := newFakeFilesystemWatcher(2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errC := make(chan error, 1)
	go func() {
		errC <- server.runFilesystemWatcherSession(ctx, watcher, 2, 20*time.Millisecond, 20*time.Millisecond)
	}()
	waitForFilesystemCondition(t, func() bool {
		var count int
		return db.QueryRow("SELECT watched_directory_count FROM filesystem_trigger_state LIMIT 1").Scan(&count) == nil && count == watcher.count
	}, "watcher session did not become ready")
	if _, err := db.Exec("INSERT INTO app_setting (key, value_json) VALUES ('local_scan_depth', '3') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"); err != nil {
		t.Fatal(err)
	}
	server.notifyFilesystemTriggerConfigChanged()
	select {
	case err := <-errC:
		if !errors.Is(err, errFilesystemWatcherReconfigure) {
			t.Fatalf("watcher session error = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("watcher session did not request reconfiguration")
	}
}

func TestFixedFilesystemTriggerCanOnlyBeToggled(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "filesystem-trigger-owner")
	server := NewServer(db, config.Config{})
	actor := account.User{ID: ownerID, Permissions: []string{"workflows:run", "metadata:sync"}}
	var triggerID, definitionID int64
	var displayName, scheduleJSON, configJSON string
	if err := db.QueryRow(`
		SELECT trigger.id, trigger.workflow_definition_id, trigger.display_name, trigger.schedule_json, trigger.config_json
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan' AND trigger.trigger_type = 'filesystem_event'
	`).Scan(&triggerID, &definitionID, &displayName, &scheduleJSON, &configJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE filesystem_trigger_state SET last_event_at = '2026-07-29 12:00:00' WHERE trigger_id = ?", triggerID); err != nil {
		t.Fatal(err)
	}
	payload := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": displayName, "triggerType": "filesystem_event", "enabled": false,
		"scheduleJson": scheduleJSON, "configJson": configJSON,
	})
	response := requestWorkflowTriggerUpdate(t, server, actor, triggerID, payload)
	if response.Code != http.StatusOK {
		t.Fatalf("toggle fixed trigger = %d, %s", response.Code, response.Body.String())
	}
	var enabled bool
	if err := db.QueryRow("SELECT enabled FROM workflow_trigger WHERE id = ?", triggerID).Scan(&enabled); err != nil {
		t.Fatal(err)
	}
	if enabled {
		t.Fatal("fixed filesystem trigger remained enabled")
	}
	var lastEventAt sql.NullString
	if err := db.QueryRow("SELECT last_event_at FROM filesystem_trigger_state WHERE trigger_id = ?", triggerID).Scan(&lastEventAt); err != nil {
		t.Fatal(err)
	}
	if lastEventAt.Valid {
		t.Fatalf("paused filesystem trigger retained last event %q", lastEventAt.String)
	}
	if len(server.filesystemTriggerConfigChanged) != 1 {
		t.Fatal("fixed trigger update did not notify the watcher coordinator")
	}

	create := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(payload))
	create = create.WithContext(context.WithValue(create.Context(), currentUserKey, actor))
	createResponse := httptest.NewRecorder()
	server.createWorkflowTrigger(createResponse, create)
	if createResponse.Code != http.StatusBadRequest {
		t.Fatalf("create fixed trigger = %d, %s", createResponse.Code, createResponse.Body.String())
	}

	convertPayload := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": displayName, "triggerType": "schedule", "enabled": true,
		"scheduleJson": `{"intervalMinutes":60}`, "configJson": configJSON,
	})
	convertResponse := requestWorkflowTriggerUpdate(t, server, actor, triggerID, convertPayload)
	if convertResponse.Code != http.StatusConflict {
		t.Fatalf("convert fixed trigger = %d, %s", convertResponse.Code, convertResponse.Body.String())
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, fmt.Sprintf("/api/workflow-triggers/%d", triggerID), nil)
	deleteRequest.SetPathValue("id", fmt.Sprint(triggerID))
	deleteRequest = deleteRequest.WithContext(context.WithValue(deleteRequest.Context(), currentUserKey, actor))
	deleteResponse := httptest.NewRecorder()
	server.deleteWorkflowTrigger(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusConflict {
		t.Fatalf("delete fixed trigger = %d, %s", deleteResponse.Code, deleteResponse.Body.String())
	}
}

func requestWorkflowTriggerUpdate(t *testing.T, server *Server, actor account.User, triggerID int64, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPut, fmt.Sprintf("/api/workflow-triggers/%d", triggerID), strings.NewReader(body))
	request.SetPathValue("id", fmt.Sprint(triggerID))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	server.updateWorkflowTrigger(response, request)
	return response
}

func assertFilesystemRunCount(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE trigger_type = 'filesystem_event'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("filesystem run count = %d, want %d", count, want)
	}
}

func startFilesystemWatcherSession(t *testing.T, server *Server, watcher *fakeFilesystemWatcher, settleDelay, retryDelay time.Duration) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	errC := make(chan error, 1)
	go func() {
		errC <- server.runFilesystemWatcherSession(ctx, watcher, server.configuredLocalScanDepth(ctx), settleDelay, retryDelay)
	}()
	waitForFilesystemCondition(t, func() bool {
		var count int
		return server.db.QueryRow("SELECT watched_directory_count FROM filesystem_trigger_state LIMIT 1").Scan(&count) == nil && count == watcher.count
	}, "watcher session did not become ready")
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-errC:
			if !errors.Is(err, context.Canceled) {
				t.Errorf("watcher session stopped with %v", err)
			}
		case <-time.After(3 * time.Second):
			t.Error("watcher session did not stop")
		}
	})
}

func waitForFilesystemRunCount(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	waitForFilesystemCondition(t, func() bool {
		var count int
		return db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE trigger_type = 'filesystem_event'").Scan(&count) == nil && count == want
	}, fmt.Sprintf("filesystem run count did not reach %d", want))
}

func waitForFilesystemTriggerNotification(t *testing.T, server *Server) {
	t.Helper()
	waitForFilesystemCondition(t, func() bool {
		return len(server.filesystemTriggerConfigChanged) == 0
	}, "filesystem trigger notification was not consumed")
}

func waitForFilesystemTriggerError(t *testing.T, db *sql.DB, want string) {
	t.Helper()
	waitForFilesystemCondition(t, func() bool {
		var message string
		return db.QueryRow("SELECT last_error_message FROM workflow_trigger WHERE trigger_type = 'filesystem_event'").Scan(&message) == nil && message == want
	}, "filesystem watcher error was not recorded")
}

func waitForFilesystemCondition(t *testing.T, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal(message)
}
