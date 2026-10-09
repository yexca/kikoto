package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

type sourceHealthCheckFixture struct {
	db     *sql.DB
	server *Server
}

func newSourceHealthCheckFixture(t *testing.T) sourceHealthCheckFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	return sourceHealthCheckFixture{db: db, server: NewServer(db, config.Config{})}
}

// addSource stores a remote source whose configured API endpoint is the
// given test server, as an administrator would configure a LAN source.
func (f sourceHealthCheckFixture) addSource(t *testing.T, id int64, sourceType string, enabled bool, apiURL string) {
	t.Helper()
	suffix := string(rune('A' + id - 1))
	if _, err := f.db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (?, ?, ?, ?, ?)`,
		id, "example_remote_"+strings.ToLower(suffix), "Example Remote "+suffix, sourceType, enabled); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, health_status, last_checked_at)
		VALUES (?, ?, ?, 'unknown', NULL)
	`, id, apiURL, apiURL); err != nil {
		t.Fatal(err)
	}
}

func (f sourceHealthCheckFixture) health(t *testing.T, id int64) (string, bool) {
	t.Helper()
	var status string
	var checkedAt sql.NullString
	if err := f.db.QueryRow(`SELECT health_status, last_checked_at FROM file_source_endpoint WHERE file_source_id = ?`, id).
		Scan(&status, &checkedAt); err != nil {
		t.Fatal(err)
	}
	return status, checkedAt.Valid
}

func (f sourceHealthCheckFixture) runQueued(t *testing.T, runID int64) (string, map[string]any) {
	t.Helper()
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, summaryJSON string
	if err := f.db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", runID).Scan(&status, &summaryJSON); err != nil {
		t.Fatal(err)
	}
	var summary map[string]any
	if err := json.Unmarshal([]byte(summaryJSON), &summary); err != nil {
		t.Fatal(err)
	}
	return status, summary
}

func healthyKikoeruServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode("ok")
	}))
	t.Cleanup(server.Close)
	return server
}

func TestSourceHealthCheckRecordsEachSourceAndReportsPartial(t *testing.T) {
	fixture := newSourceHealthCheckFixture(t)
	healthy := healthyKikoeruServer(t)
	unavailable := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(unavailable.Close)
	fixture.addSource(t, 1, sourceTypeKikoeruCompatible, true, healthy.URL)
	fixture.addSource(t, 2, sourceTypeKikoeruCompatible178, true, unavailable.URL)
	fixture.addSource(t, 3, sourceTypeKikoeruCompatible, false, healthy.URL)

	queued, err := fixture.server.enqueueSourceHealthCheck(context.Background(), workflowRunTrigger{Type: "manual", Reason: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	status, summary := fixture.runQueued(t, queued.RunID)
	if status != "partial" {
		t.Fatalf("run status = %s, want partial; summary %#v", status, summary)
	}
	if summary["checked_sources"] != float64(2) || summary["healthy_sources"] != float64(1) || summary["unavailable_sources"] != float64(1) {
		t.Fatalf("summary = %#v, want two checked sources with one unavailable", summary)
	}
	if encoded, _ := json.Marshal(summary); strings.Contains(string(encoded), unavailable.URL) || strings.Contains(string(encoded), healthy.URL) {
		t.Fatalf("summary must not reveal source endpoints: %s", encoded)
	}
	if got, checked := fixture.health(t, 1); got != "healthy" || !checked {
		t.Fatalf("healthy source = %s checked=%v", got, checked)
	}
	if got, checked := fixture.health(t, 2); got != "unavailable" || !checked {
		t.Fatalf("unavailable source = %s checked=%v", got, checked)
	}
	if got, checked := fixture.health(t, 3); got != "unknown" || checked {
		t.Fatalf("disabled source must not be checked: %s checked=%v", got, checked)
	}
}

func TestSourceHealthCheckKeepsOneActiveRunAndSucceedsWithoutSources(t *testing.T) {
	fixture := newSourceHealthCheckFixture(t)
	trigger := workflowRunTrigger{Type: "manual", Reason: "manual"}
	first, err := fixture.server.enqueueSourceHealthCheck(context.Background(), trigger)
	if err != nil {
		t.Fatal(err)
	}
	second, err := fixture.server.enqueueSourceHealthCheck(context.Background(), trigger)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Existing || second.RunID != first.RunID || second.JobID != first.JobID {
		t.Fatalf("second enqueue = %#v, want the queued run %d", second, first.RunID)
	}
	status, summary := fixture.runQueued(t, first.RunID)
	if status != "succeeded" || summary["checked_sources"] != float64(0) {
		t.Fatalf("empty run = %s %#v, want a succeeded run with no checked sources", status, summary)
	}
	third, err := fixture.server.enqueueSourceHealthCheck(context.Background(), trigger)
	if err != nil {
		t.Fatal(err)
	}
	if third.Existing || third.RunID == first.RunID {
		t.Fatalf("enqueue after completion = %#v, want a new run", third)
	}
}

func TestSourceHealthCheckTriggerRequiresEmptyConfigAndSourcePermission(t *testing.T) {
	fixture := newSourceHealthCheckFixture(t)
	fixture.addSource(t, 1, sourceTypeKikoeruCompatible, true, healthyKikoeruServer(t).URL)
	ownerID := insertWorkflowGraphAPIUser(t, fixture.db, "source-health-owner")
	if err := fixture.server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := fixture.db.QueryRow("SELECT id FROM workflow_definition WHERE code = ?", sourceHealthCheckWorkflowCode).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	create := func(triggerType, configJSON string, permissions ...string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{
			"workflowDefinitionId": definitionID, "displayName": "Check sources", "triggerType": triggerType,
			"enabled": true, "scheduleJson": `{"intervalMinutes":60}`, "configJson": configJSON,
		})
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(string(body)))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: permissions}))
		response := httptest.NewRecorder()
		fixture.server.createWorkflowTrigger(response, request)
		return response
	}
	allowed := []string{"workflows:run", "sources:write"}
	for _, test := range []struct {
		name        string
		triggerType string
		config      string
		permissions []string
	}{
		{name: "unknown config field", triggerType: "startup", config: `{"mode":"full"}`, permissions: allowed},
		{name: "filesystem trigger", triggerType: "filesystem_event", config: `{}`, permissions: allowed},
		{name: "missing source permission", triggerType: "schedule", config: `{}`, permissions: []string{"workflows:run"}},
	} {
		if response := create(test.triggerType, test.config, test.permissions...); response.Code != http.StatusBadRequest {
			t.Fatalf("%s response = %d, %s; want 400", test.name, response.Code, response.Body.String())
		}
	}
	if response := create("schedule", `{}`, allowed...); response.Code != http.StatusCreated {
		t.Fatalf("interval trigger response = %d, %s", response.Code, response.Body.String())
	}
	response := create("startup", "", allowed...)
	if response.Code != http.StatusCreated {
		t.Fatalf("startup trigger response = %d, %s", response.Code, response.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil || created.ID <= 0 {
		t.Fatalf("startup trigger body = %s, %v", response.Body.String(), err)
	}
	startupIDs, err := fixture.server.startupSystemWorkflowTriggerIDs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(startupIDs, created.ID) {
		t.Fatalf("startup trigger %d is not dispatched at startup: %v", created.ID, startupIDs)
	}
	if err := fixture.server.dispatchStartupSystemWorkflowTrigger(context.Background(), created.ID); err != nil {
		t.Fatal(err)
	}
	var runID int64
	if err := fixture.db.QueryRow("SELECT id FROM workflow_run WHERE workflow_code = ? AND trigger_id IS NOT NULL", sourceHealthCheckWorkflowCode).
		Scan(&runID); err != nil {
		t.Fatal(fmt.Errorf("startup trigger did not queue a run: %w", err))
	}
	if status, _ := fixture.runQueued(t, runID); status != "succeeded" {
		t.Fatalf("startup run status = %s, want succeeded", status)
	}
	var lastSuccess sql.NullString
	if err := fixture.db.QueryRow(`
		SELECT trigger.last_success_at FROM workflow_trigger AS trigger
		INNER JOIN workflow_run AS run ON run.trigger_id = trigger.id WHERE run.id = ?
	`, runID).Scan(&lastSuccess); err != nil {
		t.Fatal(err)
	}
	if !lastSuccess.Valid {
		t.Fatal("startup trigger did not record the successful run")
	}
}

func TestCreateSourceHealthCheckRunRequiresSourcePermission(t *testing.T) {
	fixture := newSourceHealthCheckFixture(t)
	post := func(body string, permissions ...string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/source-health-check", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: 1, Permissions: permissions}))
		response := httptest.NewRecorder()
		fixture.server.createSourceHealthCheckRun(response, request)
		return response
	}
	if response := post("", "workflows:run"); response.Code != http.StatusForbidden {
		t.Fatalf("missing sources:write response = %d, want 403", response.Code)
	}
	if response := post(`{"sourceId":1}`, "workflows:run", "sources:write"); response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field response = %d, want 400", response.Code)
	}
	if response := post("", "workflows:run", "sources:write"); response.Code != http.StatusAccepted {
		t.Fatalf("run response = %d, %s", response.Code, response.Body.String())
	}
}
