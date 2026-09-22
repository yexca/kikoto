package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestPresetWorkflowBuildsValidGraphForEveryAction(t *testing.T) {
	for _, spec := range presetWorkflowSpecs {
		for _, action := range []string{"metadata", "track", "fetch"} {
			raw := map[string]any{"action": action, "sourceId": 91, "maxWorks": 10}
			switch spec.Target {
			case "circle":
				raw["circleId"] = "rg12345"
			case "series":
				raw["seriesId"] = "srs001"
			case "voice":
				raw["voiceName"] = "Example Voice"
			}
			inputs, err := normalizePresetWorkflowInputs(spec, raw)
			if err != nil {
				t.Fatalf("%s/%s normalize: %v", spec.Code, action, err)
			}
			definition := buildPresetWorkflowDefinition(spec, inputs, "250101_test")
			encoded, err := json.Marshal(definition)
			if err != nil {
				t.Fatal(err)
			}
			graph, err := validateCustomWorkflowDefinition(string(encoded))
			if err != nil {
				t.Fatalf("%s/%s graph: %v", spec.Code, action, err)
			}
			if got := strings.Join(graph.TopologicalOrder, ","); got != "discover,filter,action,tag" {
				t.Fatalf("%s/%s order = %s", spec.Code, action, got)
			}
			wantType := map[string]string{"metadata": "metadata_sync", "track": "track_works", "fetch": "fetch_works"}[action]
			if graph.NodesByID["action"].Type != wantType {
				t.Fatalf("%s/%s action node = %s", spec.Code, action, graph.NodesByID["action"].Type)
			}
			permissions := customWorkflowRequiredPermissions(graph)
			if action == "fetch" && missingCustomWorkflowPermission(permissions, []string{"downloads:manage"}) != "" {
				t.Fatalf("%s fetch permissions = %v", spec.Code, permissions)
			}
			if missingCustomWorkflowPermission(permissions, []string{"tags:write"}) != "" {
				t.Fatalf("%s tag permissions = %v", spec.Code, permissions)
			}
		}
	}
}

func TestPresetWorkflowOmitsTagNodeWithoutTemplate(t *testing.T) {
	spec, _ := presetWorkflowSpecByCode("circle_follow")
	inputs, err := normalizePresetWorkflowInputs(spec, map[string]any{"circleId": "RG12345", "tagNameTemplate": ""})
	if err != nil {
		t.Fatal(err)
	}
	if inputs.TagNameTemplate != "" {
		t.Fatalf("empty template should disable tagging, got %q", inputs.TagNameTemplate)
	}
	definition := buildPresetWorkflowDefinition(spec, inputs, "")
	if len(definition.Nodes) != 3 || len(definition.Edges) != 2 {
		t.Fatalf("untagged graph = %d nodes, %d edges", len(definition.Nodes), len(definition.Edges))
	}
}

func TestNormalizePresetWorkflowInputsRejectsInvalidValues(t *testing.T) {
	circle, _ := presetWorkflowSpecByCode("circle_follow")
	voice, _ := presetWorkflowSpecByCode("voice_follow")
	cases := []struct {
		name string
		spec presetWorkflowSpec
		raw  map[string]any
		want string
	}{
		{"invalid circle", circle, map[string]any{"circleId": "RJ123456"}, "circleId must be"},
		{"unknown key", circle, map[string]any{"circleId": "RG12345", "definitionId": 3}, "unknown preset input"},
		{"track without source", circle, map[string]any{"circleId": "RG12345", "action": "track"}, "sourceId is required"},
		{"bad action", circle, map[string]any{"circleId": "RG12345", "action": "delete"}, "action must be one of"},
		{"works over limit", circle, map[string]any{"circleId": "RG12345", "maxWorks": 500}, "maxWorks must be between"},
		{"bad date", circle, map[string]any{"circleId": "RG12345", "releaseFrom": "2025/01/01"}, "YYYY-MM-DD"},
		{"bad extension", circle, map[string]any{"circleId": "RG12345", "action": "fetch", "sourceId": 1, "excludeExtensions": []any{"a/b"}}, "invalid extension"},
		{"voice without source", voice, map[string]any{"voiceName": "Example"}, "sourceId is required"},
	}
	for _, testCase := range cases {
		_, err := normalizePresetWorkflowInputs(testCase.spec, testCase.raw)
		if err == nil || !strings.Contains(err.Error(), testCase.want) {
			t.Fatalf("%s: err = %v, want %q", testCase.name, err, testCase.want)
		}
	}
}

func insertPresetWorkflowSource(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (91, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (91, 'https://example.invalid', 'https://example.invalid/api')`); err != nil {
		t.Fatal(err)
	}
}

func TestRunWorkflowPresetQueuesSystemRunWithRenderedTag(t *testing.T) {
	db := openMigratedTestDB(t)
	userID := insertCustomWorkflowAPIUser(t, db, "preset-runner")
	insertPresetWorkflowSource(t, db)
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	body := `{"inputs":{"circleId":"rg12345","action":"track","sourceId":91,"maxWorks":5,"tagNameTemplate":"{date}_{target}_{action}"}}`
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-presets/circle_follow/runs", strings.NewReader(body))
	request.SetPathValue("code", "circle_follow")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: userID, Permissions: []string{"workflows:run", "metadata:sync", "tags:write"}}))
	response := httptest.NewRecorder()
	server.runWorkflowPreset(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("preset run response = %d, %s", response.Code, response.Body.String())
	}
	var result presetWorkflowRunResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(result.TagName, "_RG12345_track") || result.WorkflowCode != "circle_follow" {
		t.Fatalf("preset run result = %+v", result)
	}
	var workflowCode, status, triggerType, triggerReason string
	var definitionScope string
	if err := db.QueryRow(`
		SELECT run.workflow_code, run.status, run.trigger_type, run.trigger_reason, definition.scope
		FROM workflow_run AS run INNER JOIN workflow_definition AS definition ON definition.id = run.workflow_definition_id
		WHERE run.id = ?`, result.RunID).Scan(&workflowCode, &status, &triggerType, &triggerReason, &definitionScope); err != nil {
		t.Fatal(err)
	}
	if workflowCode != "circle_follow" || status != "queued" || triggerType != "manual" || triggerReason != "workflow_preset" || definitionScope != "system" {
		t.Fatalf("preset run row = %s %s %s %s %s", workflowCode, status, triggerType, triggerReason, definitionScope)
	}
	var payloadJSON, workerType string
	if err := db.QueryRow("SELECT worker_type, payload_json FROM workflow_job WHERE workflow_run_id = ?", result.RunID).Scan(&workerType, &payloadJSON); err != nil {
		t.Fatal(err)
	}
	var payload customWorkflowJobPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	graph, err := validateCustomWorkflowDefinition(payload.DefinitionJSON)
	if err != nil {
		t.Fatalf("queued preset graph: %v", err)
	}
	if workerType != "custom_workflow" || configString(graph.NodesByID["tag"].Config, "tagName") != result.TagName || configInt64(graph.NodesByID["action"].Config, "sourceId", 0) != 91 {
		t.Fatalf("queued preset job = %s, tag %s", workerType, configString(graph.NodesByID["tag"].Config, "tagName"))
	}
	var nodeCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ?", result.RunID).Scan(&nodeCount); err != nil {
		t.Fatal(err)
	}
	if nodeCount != 4 {
		t.Fatalf("preset node runs = %d", nodeCount)
	}
}

func TestRunWorkflowPresetRequiresCapabilityPermissions(t *testing.T) {
	db := openMigratedTestDB(t)
	userID := insertCustomWorkflowAPIUser(t, db, "preset-limited")
	insertPresetWorkflowSource(t, db)
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	run := func(body string, permissions []string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-presets/circle_follow/runs", strings.NewReader(body))
		request.SetPathValue("code", "circle_follow")
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: userID, Permissions: permissions}))
		response := httptest.NewRecorder()
		server.runWorkflowPreset(response, request)
		return response
	}
	if response := run(`{"inputs":{"circleId":"RG12345","action":"fetch","sourceId":91}}`, []string{"workflows:run", "metadata:sync", "tags:write"}); response.Code != http.StatusForbidden {
		t.Fatalf("fetch without downloads permission = %d, %s", response.Code, response.Body.String())
	}
	if response := run(`{"inputs":{"circleId":"RG12345","sourceId":404,"action":"track"}}`, []string{"workflows:run", "metadata:sync", "tags:write"}); response.Code != http.StatusBadRequest {
		t.Fatalf("unknown source = %d, %s", response.Code, response.Body.String())
	}
	if response := run(`{"inputs":{"circleId":"bad"}}`, []string{"workflows:run", "metadata:sync", "tags:write"}); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "circleId") {
		t.Fatalf("invalid circle = %d, %s", response.Code, response.Body.String())
	}
	if _, err := db.Exec("SELECT 1"); err != nil {
		t.Fatal(err)
	}
	assertCustomWorkflowAPICount(t, db, "workflow_run", 0)
}

func TestPresetWorkflowScheduleStoresOwnerAndDispatchesWithCurrentPermissions(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "preset-schedule-owner")
	insertPresetWorkflowSource(t, db)
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := db.QueryRow("SELECT id FROM workflow_definition WHERE code = 'voice_follow'").Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	body := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": "Weekly voice follow", "triggerType": "schedule", "enabled": true,
		"scheduleJson": `{"intervalMinutes":10080}`,
		"configJson":   mustJSON(map[string]any{"inputs": map[string]any{"voiceName": "Example Voice", "sourceId": 91, "action": "track"}}),
	})
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: []string{"workflows:run", "library:read", "metadata:sync", "tags:write"}}))
	response := httptest.NewRecorder()
	server.createWorkflowTrigger(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("preset schedule response = %d, %s", response.Code, response.Body.String())
	}
	var trigger workflowTriggerRecord
	if err := json.Unmarshal(response.Body.Bytes(), &trigger); err != nil {
		t.Fatal(err)
	}
	var storedConfig presetWorkflowTriggerConfig
	if err := json.Unmarshal([]byte(trigger.ConfigJSON), &storedConfig); err != nil {
		t.Fatal(err)
	}
	if storedConfig.UserID != ownerID || storedConfig.Inputs["voiceName"] != "Example Voice" || storedConfig.Inputs["tagNameTemplate"] != "{date}_voice_{target}" {
		t.Fatalf("stored preset config = %+v", storedConfig)
	}
	definition, err := server.loadWorkflowDefinition(context.Background(), definitionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.executeSystemWorkflowTrigger(context.Background(), definition, trigger, "schedule", "scheduled_interval"); err != nil {
		t.Fatal(err)
	}
	var runTriggerID sql.NullInt64
	var triggerType, inputJSON string
	if err := db.QueryRow(`SELECT trigger_id, trigger_type, input_json FROM workflow_run WHERE workflow_definition_id = ? ORDER BY id DESC LIMIT 1`, definitionID).Scan(&runTriggerID, &triggerType, &inputJSON); err != nil {
		t.Fatal(err)
	}
	if !runTriggerID.Valid || runTriggerID.Int64 != trigger.ID || triggerType != "schedule" {
		t.Fatalf("scheduled preset run = trigger %#v type %s", runTriggerID, triggerType)
	}
	var runInput struct {
		Inputs      map[string]any `json:"inputs"`
		RequestedBy int64          `json:"requested_by_user_id"`
	}
	if err := json.Unmarshal([]byte(inputJSON), &runInput); err != nil {
		t.Fatal(err)
	}
	if runInput.RequestedBy != ownerID || runInput.Inputs["voiceName"] != "Example Voice" {
		t.Fatalf("scheduled preset run input = %+v", runInput)
	}

	if _, err := db.Exec("UPDATE user_account SET role = 'user' WHERE id = ?", ownerID); err != nil {
		t.Fatal(err)
	}
	if err := server.executeSystemWorkflowTrigger(context.Background(), definition, trigger, "schedule", "scheduled_interval"); err == nil {
		t.Fatal("expected revoked owner to block the scheduled preset run")
	}
	var lastError string
	if err := db.QueryRow("SELECT last_error_message FROM workflow_trigger WHERE id = ?", trigger.ID).Scan(&lastError); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(lastError, "permission") {
		t.Fatalf("revoked owner trigger error = %q", lastError)
	}
}

func TestPresetWorkflowAutomationRejectsFullCatalogRefresh(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "preset-startup-owner")
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := db.QueryRow("SELECT id FROM workflow_definition WHERE code = 'circle_follow'").Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	body := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": "Startup circle follow", "triggerType": "startup", "enabled": true,
		"scheduleJson": `{"type":"startup"}`,
		"configJson":   mustJSON(map[string]any{"inputs": map[string]any{"circleId": "RG12345", "catalogRefresh": "full"}}),
	})
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: []string{"workflows:run", "metadata:sync", "tags:write"}}))
	response := httptest.NewRecorder()
	server.createWorkflowTrigger(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "catalog refresh") {
		t.Fatalf("full refresh automation = %d, %s", response.Code, response.Body.String())
	}
	now := time.Now()
	plan, err := server.planPresetWorkflow(context.Background(), mustPresetSpec(t, "circle_follow"), map[string]any{"circleId": "RG12345", "catalogRefresh": "full"}, now, false)
	if err != nil {
		t.Fatalf("manual full refresh should plan: %v", err)
	}
	if configString(plan.Graph.NodesByID["discover"].Config, "mode") != "full" {
		t.Fatalf("manual plan mode = %s", configString(plan.Graph.NodesByID["discover"].Config, "mode"))
	}
}

func mustPresetSpec(t *testing.T, code string) presetWorkflowSpec {
	t.Helper()
	spec, ok := presetWorkflowSpecByCode(code)
	if !ok {
		t.Fatalf("preset %s missing", code)
	}
	return spec
}
