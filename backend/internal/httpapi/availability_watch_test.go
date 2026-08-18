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
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestAvailabilityWatchRunRecordsActivityWithoutMaterializingUnknownWork(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case "/api/search/RJ00000000":
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{{ID: 91, SourceID: "RJ00000000", Title: "Available"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-admin', 'admin')`,
		`INSERT INTO user_account (id, username, role) VALUES (2, 'watch-root', 'super_admin')`,
		`INSERT INTO user_account (id, username, role) VALUES (3, 'watch-reader', 'user')`,
		`INSERT INTO user_account (id, username, role, enabled) VALUES (4, 'watch-disabled', 'admin', 0)`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`,
		`INSERT INTO availability_watch (id, configured_by_user_id, action, source_id) VALUES (1, 1, 'monitor', 1)`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state, next_check_at) VALUES (1, 1, 'RJ00000000', 'monitoring', CURRENT_TIMESTAMP)`,
		`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	queued, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "availability-watch-test"); err != nil {
		t.Fatal(err)
	}

	var state, lastStatus string
	if err := db.QueryRow(`SELECT state, last_status FROM availability_watch_target WHERE id = 1`).Scan(&state, &lastStatus); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || lastStatus != "available" {
		t.Fatalf("target = state %q, status %q", state, lastStatus)
	}
	var works, runs, succeededNodes, notifications int
	if err := db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM work),
			(SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'availability_watch'),
			(SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ? AND status = 'succeeded'),
			(SELECT COUNT(*) FROM workflow_notification WHERE workflow_run_id = ? AND notification_type = 'availability_watch_ready')
	`, queued.RunID, queued.RunID).Scan(&works, &runs, &succeededNodes, &notifications); err != nil {
		t.Fatal(err)
	}
	if works != 0 || runs != 1 || succeededNodes != 4 || notifications != 2 {
		t.Fatalf("works=%d runs=%d succeeded nodes=%d notifications=%d", works, runs, succeededNodes, notifications)
	}
}

func TestAvailabilityWatchRunKeepsUnavailableTargetsMonitoring(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case "/api/search/RJ00000001":
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-admin', 'admin')`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`,
		`INSERT INTO availability_watch (id, configured_by_user_id, action, source_id) VALUES (1, 1, 'monitor', 1)`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state, next_check_at) VALUES (1, 1, 'RJ00000001', 'monitoring', CURRENT_TIMESTAMP)`,
		`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	queued, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "availability-watch-not-found-test"); err != nil {
		t.Fatal(err)
	}

	var state, lastStatus, runStatus, rawSummary string
	if err := db.QueryRow(`SELECT state, last_status FROM availability_watch_target WHERE id = 1`).Scan(&state, &lastStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status, summary_json FROM workflow_run WHERE id = ?`, queued.RunID).Scan(&runStatus, &rawSummary); err != nil {
		t.Fatal(err)
	}
	var summary availabilityWatchRunResult
	if err := json.Unmarshal([]byte(rawSummary), &summary); err != nil {
		t.Fatal(err)
	}
	if state != "monitoring" || lastStatus != "not_found" || runStatus != "succeeded" {
		t.Fatalf("target = %q/%q, run = %q", state, lastStatus, runStatus)
	}
	if summary.Checked != 1 || summary.Ready != 0 || len(summary.Failures) != 0 {
		t.Fatalf("summary = %+v", summary)
	}
}

func TestAvailabilityWatchRunRecordsMissingHealthySourceAsPartial(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-admin', 'admin')`,
		`INSERT INTO availability_watch (id, configured_by_user_id, action) VALUES (1, 1, 'monitor')`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state, next_check_at) VALUES (1, 1, 'RJ00000002', 'monitoring', CURRENT_TIMESTAMP)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	queued, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "availability-watch-no-source-test"); err != nil {
		t.Fatal(err)
	}

	var state, lastStatus, lastError, runStatus, rawSummary string
	if err := db.QueryRow(`SELECT state, last_status, last_error FROM availability_watch_target WHERE id = 1`).Scan(&state, &lastStatus, &lastError); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status, summary_json FROM workflow_run WHERE id = ?`, queued.RunID).Scan(&runStatus, &rawSummary); err != nil {
		t.Fatal(err)
	}
	var summary availabilityWatchRunResult
	if err := json.Unmarshal([]byte(rawSummary), &summary); err != nil {
		t.Fatal(err)
	}
	if state != "error" || lastStatus != "error" || lastError != "Remote source is unavailable" {
		t.Fatalf("target = %q/%q error %q", state, lastStatus, lastError)
	}
	if runStatus != "partial" || len(summary.Failures) != 1 || !strings.Contains(summary.Failures[0], "no healthy remote source") {
		t.Fatalf("run = %q, summary = %+v", runStatus, summary)
	}
}

func TestAvailabilityWatchTargetUpdatePreservesUnchangedReadyState(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-editor', 'admin')`,
		`INSERT INTO user_account (id, username, role) VALUES (2, 'watch-pool-editor', 'admin')`,
		`INSERT INTO availability_watch (id, configured_by_user_id) VALUES (1, 1)`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state, last_status, availability_epoch, revision) VALUES (1, 1, 'RJ00000000', 'ready', 'available', 2, 7)`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state) VALUES (2, 1, 'RJ00000001', 'monitoring')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	if err := server.persistAvailabilityWatchTargets(context.Background(), 2, []string{"RJ00000000", "RJ00000002"}); err != nil {
		t.Fatal(err)
	}
	var configuredBy int
	if err := db.QueryRow(`SELECT configured_by_user_id FROM availability_watch WHERE id = 1`).Scan(&configuredBy); err != nil {
		t.Fatal(err)
	}
	if configuredBy != 1 {
		t.Fatalf("target editor replaced configured by user %d", configuredBy)
	}
	var state, lastStatus string
	var epoch, revision int
	if err := db.QueryRow(`SELECT state, last_status, availability_epoch, revision FROM availability_watch_target WHERE id = 1`).Scan(&state, &lastStatus, &epoch, &revision); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || lastStatus != "available" || epoch != 2 || revision != 7 {
		t.Fatalf("unchanged target = %q %q epoch=%d revision=%d", state, lastStatus, epoch, revision)
	}
	var removedActive, addedActive int
	if err := db.QueryRow(`
		SELECT
			(SELECT active FROM availability_watch_target WHERE work_code = 'RJ00000001'),
			(SELECT active FROM availability_watch_target WHERE work_code = 'RJ00000002')
	`).Scan(&removedActive, &addedActive); err != nil {
		t.Fatal(err)
	}
	if removedActive != 0 || addedActive != 1 {
		t.Fatalf("removed active=%d added active=%d", removedActive, addedActive)
	}
}

func TestAvailabilityWatchUsesOneScheduleTriggerAndRecordsScheduledRuns(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-scheduler', 'admin')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO availability_watch (id, configured_by_user_id, action) VALUES (1, 1, 'monitor')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	var definitionID int64
	if err := db.QueryRow(`SELECT id FROM workflow_definition WHERE code = 'availability_watch'`).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	actor := account.User{ID: 1, Permissions: []string{"workflows:run"}}
	createTrigger := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
		response := httptest.NewRecorder()
		server.createWorkflowTrigger(response, request)
		return response
	}
	scheduleBody := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID,
		"displayName":          "Availability interval",
		"triggerType":          "schedule",
		"enabled":              true,
		"scheduleJson":         `{"intervalMinutes":60}`,
		"configJson":           `{}`,
	})
	response := createTrigger(scheduleBody)
	if response.Code != http.StatusCreated {
		t.Fatalf("create Availability Watch schedule = %d, body = %s", response.Code, response.Body.String())
	}
	var trigger workflowTriggerRecord
	if err := json.Unmarshal(response.Body.Bytes(), &trigger); err != nil {
		t.Fatal(err)
	}
	var triggerConfig systemWorkflowTriggerConfig
	if err := json.Unmarshal([]byte(trigger.ConfigJSON), &triggerConfig); err != nil {
		t.Fatal(err)
	}
	if triggerConfig.UserID != actor.ID {
		t.Fatalf("schedule owner = %d, want %d", triggerConfig.UserID, actor.ID)
	}
	if duplicate := createTrigger(scheduleBody); duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate Availability Watch schedule = %d, body = %s", duplicate.Code, duplicate.Body.String())
	}
	startupBody := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID,
		"displayName":          "Availability startup",
		"triggerType":          "startup",
		"enabled":              true,
		"scheduleJson":         `{}`,
		"configJson":           `{}`,
	})
	if startup := createTrigger(startupBody); startup.Code != http.StatusConflict {
		t.Fatalf("Availability Watch startup trigger = %d, body = %s", startup.Code, startup.Body.String())
	}
	definition, err := server.loadWorkflowDefinition(context.Background(), definitionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.executeSystemWorkflowTrigger(context.Background(), definition, trigger, "schedule", "scheduled_interval"); err != nil {
		t.Fatal(err)
	}
	var runTriggerID int64
	var runType, runReason string
	if err := db.QueryRow(`
		SELECT trigger_id, trigger_type, trigger_reason
		FROM workflow_run WHERE workflow_code = 'availability_watch'
		ORDER BY id DESC LIMIT 1
	`).Scan(&runTriggerID, &runType, &runReason); err != nil {
		t.Fatal(err)
	}
	if runTriggerID != trigger.ID || runType != "schedule" || runReason != "scheduled_interval" {
		t.Fatalf("scheduled Availability Watch run = trigger %d type %q reason %q", runTriggerID, runType, runReason)
	}
}
