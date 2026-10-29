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
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

// availabilityWatchDLsiteClient serves the given products and reports every
// other code as absent from DLsite.
type availabilityWatchDLsiteClient struct {
	products map[string]dlsite.Product
	requests []string
}

func (c *availabilityWatchDLsiteClient) FetchProduct(_ context.Context, code string) (dlsite.Product, error) {
	c.requests = append(c.requests, code)
	if product, ok := c.products[code]; ok {
		return product, nil
	}
	return dlsite.Product{}, dlsite.ErrNoProduct
}

func (*availabilityWatchDLsiteClient) DownloadCover(context.Context, dlsite.Product, string) (string, error) {
	return "", nil
}

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
	server.dlsiteClient = &availabilityWatchDLsiteClient{}
	queued, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}

	var state, lastStatus string
	if err := db.QueryRow(`SELECT state, last_status FROM availability_watch_target WHERE id = 1`).Scan(&state, &lastStatus); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || lastStatus != "available" {
		t.Fatalf("target = state %q, status %q", state, lastStatus)
	}
	// The watch only monitors: an available work starts no other run.
	var works, runs, succeededNodes, notifications int
	if err := db.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM work),
			(SELECT COUNT(*) FROM workflow_run),
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
	server.dlsiteClient = &availabilityWatchDLsiteClient{}
	queued, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
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
	server.dlsiteClient = &availabilityWatchDLsiteClient{}
	queued, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
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
	if err := server.persistAvailabilityWatchTargets(context.Background(), 2, []string{"RJ00000000", "RJ00000002"}, true); err != nil {
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

// Availability Watch has no trigger of its own: the subscription refresh
// queues it with the account that configured the watch.
func TestSubscriptionRefreshQueuesAvailabilityWatchWithItsConfiguringAccount(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-scheduler', 'admin')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO availability_watch (id, configured_by_user_id, action) VALUES (1, 1, 'monitor')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO availability_watch_target (watch_id, work_code, state) VALUES (1, 'RJ00000000', 'monitoring')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	var definitionID int64
	if err := db.QueryRow(`SELECT id FROM workflow_definition WHERE code = 'availability_watch'`).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	actor := account.User{ID: 1, Role: "admin", Permissions: account.PermissionsForRole("admin")}
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(mustJSON(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": "Availability interval", "triggerType": "schedule",
		"enabled": true, "scheduleJson": `{"intervalMinutes":60}`, "configJson": `{}`,
	})))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	server.createWorkflowTrigger(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("Availability Watch trigger = %d, body = %s", response.Code, response.Body.String())
	}

	execution := &creatorSubscriptionExecution{result: creatorSubscriptionRunResult{Failures: []string{}}}
	server.dispatchSubscriptionAvailabilityWatch(context.Background(), 42, execution)
	if execution.watch != "queued" || execution.result.WatchRunID == 0 {
		t.Fatalf("watch dispatch = %q run %d failures %v", execution.watch, execution.result.WatchRunID, execution.result.Failures)
	}
	var runType, runReason string
	var requester int64
	if err := db.QueryRow(`
		SELECT trigger_type, trigger_reason, CAST(json_extract(input_json, '$.requested_by_user_id') AS INTEGER)
		FROM workflow_run WHERE id = ?
	`, execution.result.WatchRunID).Scan(&runType, &runReason, &requester); err != nil {
		t.Fatal(err)
	}
	if runType != "follow_up" || runReason != "subscription_refresh:42" || requester != 1 {
		t.Fatalf("queued watch run = type %q reason %q requester %d", runType, runReason, requester)
	}

	// A configuring account that lost the watch permissions stops the check.
	if _, err := db.Exec(`UPDATE workflow_run SET status = 'succeeded' WHERE id = ?`, execution.result.WatchRunID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE user_account SET role = 'user' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	revoked := &creatorSubscriptionExecution{result: creatorSubscriptionRunResult{Failures: []string{}}}
	server.dispatchSubscriptionAvailabilityWatch(context.Background(), 43, revoked)
	if revoked.watch != "failed" || len(revoked.failures["watch"]) != 1 {
		t.Fatalf("watch dispatch with revoked owner = %q %v", revoked.watch, revoked.failures)
	}

}

func TestAvailabilityWatchFamilyEditionSatisfiesWatchedCode(t *testing.T) {
	const origin, translation = "RJ00000010", "RJ00000011"
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case "/api/search/" + translation:
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{{ID: 92, SourceID: translation, Title: "Translation"}}})
		case "/api/search/" + origin:
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
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state, next_check_at) VALUES (1, 1, 'RJ00000010', 'monitoring', CURRENT_TIMESTAMP)`,
		`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	editions := []dlsite.LanguageEdition{
		{WorkNo: origin, DisplayOrder: 1, Label: "Japanese", Lang: "JPN"},
		{WorkNo: translation, DisplayOrder: 2, Label: "English", Lang: "ENG"},
	}
	client := &availabilityWatchDLsiteClient{products: map[string]dlsite.Product{
		origin:      {WorkNo: origin, ProductName: "Origin title", LanguageEditions: editions},
		translation: {WorkNo: translation, ProductName: "Translation title", LanguageEditions: editions},
	}}
	server := NewServer(db, config.Config{})
	server.dlsiteClient = client
	run := func() {
		t.Helper()
		if _, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"}); err != nil {
			t.Fatal(err)
		}
		if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	run()

	var state, availableCode string
	if err := db.QueryRow(`SELECT state, available_code FROM availability_watch_target WHERE id = 1`).Scan(&state, &availableCode); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || availableCode != translation {
		t.Fatalf("target = state %q, available code %q", state, availableCode)
	}
	view, err := server.loadAvailabilityWatch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	codes := []string{}
	for _, member := range view.Targets[0].Family {
		codes = append(codes, member.Code)
	}
	if strings.Join(codes, ",") != origin+","+translation || view.Targets[0].Title != "Origin title" {
		t.Fatalf("family = %+v, title %q", view.Targets[0].Family, view.Targets[0].Title)
	}

	// A fresh family is not requested from DLsite again on the next run.
	if _, err := db.Exec(`UPDATE availability_watch_target SET state = 'monitoring', last_status = '' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	requests := len(client.requests)
	run()
	if len(client.requests) != requests {
		t.Fatalf("fresh family requested again: %v", client.requests[requests:])
	}
}

func TestAvailabilityWatchAddKeepsExistingTargets(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-editor', 'admin')`,
		`INSERT INTO availability_watch (id, configured_by_user_id) VALUES (1, 1)`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state) VALUES (1, 1, 'RJ00000000', 'monitoring')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/availability-watch/targets", strings.NewReader(`{"targetCodes":["rj00000001"]}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: 1, Role: "admin", Permissions: account.PermissionsForRole("admin")}))
	response := httptest.NewRecorder()
	server.addAvailabilityWatchTargets(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("add targets = %d, body = %s", response.Code, response.Body.String())
	}
	var active int
	if err := db.QueryRow(`SELECT COUNT(*) FROM availability_watch_target WHERE active = 1 AND work_code IN ('RJ00000000', 'RJ00000001')`).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 2 {
		t.Fatalf("active targets = %d, want 2", active)
	}
}

func TestAvailabilityWatchQueuedRunRechecksMetadataPermission(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-requester', 'admin')`,
		`INSERT INTO availability_watch (id, configured_by_user_id, action) VALUES (1, 1, 'monitor')`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state) VALUES (1, 1, 'RJ00000001', 'monitoring')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	client := &availabilityWatchDLsiteClient{}
	server.dlsiteClient = client
	queued, err := server.enqueueAvailabilityWatch(context.Background(), 1, workflowRunTrigger{Type: "manual", Reason: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE user_account SET role = 'contributor' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	_ = server.runNextQueuedWorkflowJob(context.Background())
	var status string
	if err := db.QueryRow(`SELECT status FROM workflow_run WHERE id = ?`, queued.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || len(client.requests) != 0 {
		t.Fatalf("queued watch after permission loss = %q, DLsite requests=%v", status, client.requests)
	}
}
