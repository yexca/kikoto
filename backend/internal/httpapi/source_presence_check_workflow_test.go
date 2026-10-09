package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type sourcePresenceCheckFixture struct {
	db     *sql.DB
	server *Server
}

func newSourcePresenceCheckFixture(t *testing.T) sourcePresenceCheckFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	return sourcePresenceCheckFixture{db: db, server: NewServer(db, config.Config{})}
}

func (f sourcePresenceCheckFixture) exec(t *testing.T, query string, args ...any) {
	t.Helper()
	if _, err := f.db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

// addRemoteSource stores a remote source whose configured API endpoint is the
// given test server, as an administrator would configure a LAN source.
func (f sourcePresenceCheckFixture) addRemoteSource(t *testing.T, id int64, enabled bool, apiURL string) {
	t.Helper()
	suffix := string(rune('a' + id - 1))
	f.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (?, ?, ?, ?, ?)`,
		id, "example_remote_"+suffix, "Example Remote "+strings.ToUpper(suffix), sourceTypeKikoeruCompatible, enabled)
	f.exec(t, `INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, health_status) VALUES (?, ?, ?, 'unknown')`,
		id, apiURL, apiURL)
}

// addWork stores a work, available in the local library when local is set.
func (f sourcePresenceCheckFixture) addWork(t *testing.T, id int64, code string, local bool) {
	t.Helper()
	f.exec(t, `INSERT INTO work (id, primary_code, title) VALUES (?, ?, ?)`, id, code, "Work "+code)
	if local {
		f.exec(t, `INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (?, 1, 'local', 'available')`, id)
	}
}

func (f sourcePresenceCheckFixture) presence(t *testing.T, workID, sourceID int64) string {
	t.Helper()
	var availability string
	err := f.db.QueryRow(`SELECT availability FROM work_source_presence WHERE work_id = ? AND file_source_id = ? AND presence_type = ?`,
		workID, sourceID, sourcePresenceTypeRemoteSource).Scan(&availability)
	if errors.Is(err, sql.ErrNoRows) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return availability
}

func (f sourcePresenceCheckFixture) runQueued(t *testing.T, runID int64) (string, map[string]any) {
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

// presenceRemote answers health checks and knows only the listed work codes.
func presenceRemote(t *testing.T, healthy bool, codes ...string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !healthy {
			http.NotFound(w, r)
			return
		}
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case strings.HasPrefix(r.URL.Path, "/api/workInfo/"):
			code := strings.TrimPrefix(r.URL.Path, "/api/workInfo/")
			if !slices.Contains(codes, code) {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 1, SourceID: code, Title: "Remote " + code})
		case strings.HasPrefix(r.URL.Path, "/api/search/") || r.URL.Path == "/api/works":
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{}, Pagination: kikoeru.Pagination{PageSize: 100}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestSourcePresenceCheckRecordsSelectedLibraryWorksOnTheSource(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	remote := presenceRemote(t, true, "RJ00000001")
	fixture.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_local', 'Example Local', 'local', 1)`)
	fixture.addRemoteSource(t, 2, true, remote.URL)
	fixture.addRemoteSource(t, 3, false, remote.URL)
	fixture.addWork(t, 101, "RJ00000000", true)
	fixture.addWork(t, 102, "RJ00000001", true)
	fixture.addWork(t, 103, "RJ00000002", false)
	fixture.addWork(t, 104, "RJ00000003", true)
	// Another source already provides 104, so the no-remote-source filter excludes it.
	fixture.exec(t, `INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability, last_checked_at)
		VALUES (104, 3, ?, 'available', CURRENT_TIMESTAMP)`, sourcePresenceTypeRemoteSource)
	trigger := workflowRunTrigger{Type: "manual", Reason: "manual"}

	local, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), sourcePresenceCheckOptions{SourceID: 2, Filter: sourcePresenceFilterAll}, trigger)
	if err != nil {
		t.Fatal(err)
	}
	status, summary := fixture.runQueued(t, local.RunID)
	if status != "succeeded" || summary["selected_works"] != float64(3) || summary["available_works"] != float64(1) || summary["missing_works"] != float64(2) {
		t.Fatalf("local run = %s %#v; want three local works with one available", status, summary)
	}
	if encoded, _ := json.Marshal(summary); strings.Contains(string(encoded), remote.URL) {
		t.Fatalf("summary must not reveal the source endpoint: %s", encoded)
	}
	for workID, want := range map[int64]string{101: "missing", 102: "available", 103: "", 104: "missing"} {
		if got := fixture.presence(t, workID, 2); got != want {
			t.Fatalf("work %d presence = %q, want %q", workID, got, want)
		}
	}

	// All works without an available remote source, one per run: the work the
	// source has never been asked about comes before the one it reported missing.
	all, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), sourcePresenceCheckOptions{
		SourceID: 2, Library: sourcePresenceLibraryAll, Filter: sourcePresenceFilterNoRemoteSource, Limit: 1,
	}, trigger)
	if err != nil {
		t.Fatal(err)
	}
	status, summary = fixture.runQueued(t, all.RunID)
	if status != "succeeded" || summary["selected_works"] != float64(1) || summary["missing_works"] != float64(1) {
		t.Fatalf("limited run = %s %#v; want one checked work", status, summary)
	}
	if got := fixture.presence(t, 103, 2); got != "missing" {
		t.Fatalf("unchecked work 103 presence = %q, want missing", got)
	}
}

func TestSourcePresenceCheckUnavailableSourceLeavesWorksUnrecorded(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	fixture.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_local', 'Example Local', 'local', 1)`)
	fixture.addRemoteSource(t, 2, true, presenceRemote(t, false).URL)
	fixture.addWork(t, 101, "RJ00000000", true)

	queued, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), sourcePresenceCheckOptions{SourceID: 2}, workflowRunTrigger{Type: "manual", Reason: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	status, summary := fixture.runQueued(t, queued.RunID)
	if status != "failed" || summary["selected_works"] != float64(1) || summary["checked_works"] != float64(0) {
		t.Fatalf("run = %s %#v; want a failed run that checked no works", status, summary)
	}
	if got := fixture.presence(t, 101, 2); got != "" {
		t.Fatalf("unreachable source recorded presence %q", got)
	}
	var health, checkNode string
	if err := fixture.db.QueryRow("SELECT health_status FROM file_source_endpoint WHERE file_source_id = 2").Scan(&health); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT status FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = ?", queued.RunID, sourcePresenceCheckCheckNodeID).
		Scan(&checkNode); err != nil {
		t.Fatal(err)
	}
	if health != "unavailable" || checkNode != "skipped" {
		t.Fatalf("health = %s, check node = %s; want unavailable and skipped", health, checkNode)
	}
}

func TestSourcePresenceCheckValidatesOptionsAndKeepsOneRunPerSource(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	remote := presenceRemote(t, true)
	fixture.addRemoteSource(t, 1, true, remote.URL)
	fixture.addRemoteSource(t, 2, true, remote.URL)
	fixture.addRemoteSource(t, 3, false, remote.URL)
	trigger := workflowRunTrigger{Type: "manual", Reason: "manual"}

	for name, options := range map[string]sourcePresenceCheckOptions{
		"missing source":  {},
		"unknown library": {SourceID: 1, Library: "remote"},
		"unknown filter":  {SourceID: 1, Filter: "tracked"},
		"limit too large": {SourceID: 1, Limit: sourcePresenceCheckMaxLimit + 1},
		"disabled source": {SourceID: 3},
		"unknown source":  {SourceID: 9},
	} {
		var inputErr sourcePresenceCheckInputError
		if _, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), options, trigger); !errors.As(err, &inputErr) {
			t.Fatalf("%s: error = %v, want an input error", name, err)
		}
	}
	first, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), sourcePresenceCheckOptions{SourceID: 1}, trigger)
	if err != nil {
		t.Fatal(err)
	}
	again, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), sourcePresenceCheckOptions{SourceID: 1, Limit: 10}, trigger)
	if err != nil {
		t.Fatal(err)
	}
	other, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), sourcePresenceCheckOptions{SourceID: 2}, trigger)
	if err != nil {
		t.Fatal(err)
	}
	if !again.Existing || again.RunID != first.RunID || other.Existing || other.RunID == first.RunID {
		t.Fatalf("first %#v, same source %#v, other source %#v; want one active run per source", first, again, other)
	}
}

func TestCreateSourcePresenceCheckRunRequiresSourcePermission(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	fixture.addRemoteSource(t, 1, true, presenceRemote(t, true).URL)
	post := func(body string, permissions ...string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/source-presence-check", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: 1, Permissions: permissions}))
		response := httptest.NewRecorder()
		fixture.server.createSourcePresenceCheckRun(response, request)
		return response
	}
	if response := post(`{"sourceId":1}`, "workflows:run"); response.Code != http.StatusForbidden {
		t.Fatalf("missing sources:write response = %d, want 403", response.Code)
	}
	for _, body := range []string{`{"sourceId":1,"mode":"full"}`, `{"sourceId":1,"limit":0.5}`, `{}`} {
		if response := post(body, "workflows:run", "sources:write"); response.Code != http.StatusBadRequest {
			t.Fatalf("%s response = %d, want 400", body, response.Code)
		}
	}
	if response := post(`{"sourceId":1,"library":"all","filter":"no_remote_source","limit":500}`, "workflows:run", "sources:write"); response.Code != http.StatusAccepted {
		t.Fatalf("run response = %d, %s", response.Code, response.Body.String())
	}
}

func TestSourcePresenceCheckTriggerStoresOptionsAndRequiresSourcePermission(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	fixture.addRemoteSource(t, 1, true, presenceRemote(t, true).URL)
	ownerID := insertWorkflowGraphAPIUser(t, fixture.db, "source-presence-owner")
	if err := fixture.server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := fixture.db.QueryRow("SELECT id FROM workflow_definition WHERE code = ?", sourcePresenceCheckWorkflowCode).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	create := func(triggerType, configJSON string, permissions ...string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{
			"workflowDefinitionId": definitionID, "displayName": "Check works", "triggerType": triggerType,
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
		{name: "unknown config field", triggerType: "startup", config: `{"sourceId":1,"mode":"full"}`, permissions: allowed},
		{name: "missing source", triggerType: "schedule", config: `{}`, permissions: allowed},
		{name: "disabled or unknown source", triggerType: "schedule", config: `{"sourceId":9}`, permissions: allowed},
		{name: "filesystem trigger", triggerType: "filesystem_event", config: `{"sourceId":1}`, permissions: allowed},
		{name: "missing source permission", triggerType: "schedule", config: `{"sourceId":1}`, permissions: []string{"workflows:run"}},
	} {
		if response := create(test.triggerType, test.config, test.permissions...); response.Code != http.StatusBadRequest {
			t.Fatalf("%s response = %d, %s; want 400", test.name, response.Code, response.Body.String())
		}
	}
	response := create("startup", `{"sourceId":1,"limit":250}`, allowed...)
	if response.Code != http.StatusCreated {
		t.Fatalf("startup trigger response = %d, %s", response.Code, response.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil || created.ID <= 0 {
		t.Fatalf("startup trigger body = %s, %v", response.Body.String(), err)
	}
	if err := fixture.server.dispatchStartupSystemWorkflowTrigger(context.Background(), created.ID); err != nil {
		t.Fatal(err)
	}
	var inputJSON string
	if err := fixture.db.QueryRow("SELECT input_json FROM workflow_run WHERE workflow_code = ? AND trigger_id = ?", sourcePresenceCheckWorkflowCode, created.ID).
		Scan(&inputJSON); err != nil {
		t.Fatalf("startup trigger did not queue a run: %v", err)
	}
	var input sourcePresenceCheckOptions
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input != (sourcePresenceCheckOptions{SourceID: 1, Library: sourcePresenceLibraryLocal, Filter: sourcePresenceFilterNoRemoteSource, Limit: 250}) {
		t.Fatalf("run input = %#v, want the trigger's normalized options", input)
	}
}

func TestRetireSourceHealthCheckMigrationKeepsRunHistory(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	fixture.exec(t, `INSERT INTO workflow_definition (id, code, display_name, description, definition_json, scope, editable)
		VALUES (90, 'source_health_check', 'Check source health', '', '{}', 'system', 0)`)
	fixture.exec(t, `INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, schedule_json, config_json)
		VALUES (90, 'startup', 'Check sources', '{}', '{}')`)
	fixture.exec(t, `INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type)
		VALUES (91, 90, 'source_health_check', 'Check source health', 'succeeded', 'manual')`)
	migration, err := os.ReadFile(filepath.Join("..", "..", "migrations", "064_retire_source_health_check.sql"))
	if err != nil {
		t.Fatal(err)
	}
	fixture.exec(t, string(migration))
	var definitions, triggers int
	var runCode string
	var runDefinition sql.NullInt64
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM workflow_definition WHERE code = 'source_health_check'").Scan(&definitions); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM workflow_trigger WHERE workflow_definition_id = 90").Scan(&triggers); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT workflow_code, workflow_definition_id FROM workflow_run WHERE id = 91").Scan(&runCode, &runDefinition); err != nil {
		t.Fatal(err)
	}
	if definitions != 0 || triggers != 0 || runCode != "source_health_check" || runDefinition.Valid {
		t.Fatalf("definitions %d, triggers %d, run %s/%v; want the definition and trigger gone and the run kept", definitions, triggers, runCode, runDefinition)
	}
}
