package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

const customWorkflowAPIDefinitionJSON = `{
  "schemaVersion": 2,
  "command": {"enabled": true, "alias": "fetchWork"},
  "inputs": [
    {"key": "work", "label": "Work", "type": "work_code", "required": true}
  ],
  "nodes": [
    {
      "id": "work_input",
      "type": "workflow_input",
      "displayName": "Work input",
      "config": {"inputKey": "work"},
      "position": {"x": 0, "y": 40}
    },
    {
      "id": "fetch",
      "type": "fetch_works",
      "displayName": "Fetch works",
      "config": {
        "excludeExtensions": ["wav"],
        "maxWorks": 2,
        "maxFiles": 10,
        "maxBytes": 1048576
      },
      "position": {"x": 260, "y": 40}
    }
  ],
  "edges": [
    {
      "id": "work_to_fetch",
      "source": "work_input",
      "sourceHandle": "value",
      "target": "fetch",
      "targetHandle": "works"
    }
  ],
  "policy": {"requirePreview": true}
}`

func TestCustomWorkflowRunPreviewThenConfirmQueuesRecoverableGraph(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-owner")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	server := NewServer(db, config.Config{})
	actor := account.User{ID: ownerID, Permissions: []string{"workflows:run", "downloads:manage"}}

	preview := requestCustomWorkflowAPIRun(t, server, definitionID, actor, `{"mode":"preview","inputs":{"work":"rj09999991"}}`)
	if preview.Code != http.StatusOK {
		t.Fatalf("preview status = %d, body = %s", preview.Code, preview.Body.String())
	}
	var previewResult customWorkflowRunResponse
	if err := json.Unmarshal(preview.Body.Bytes(), &previewResult); err != nil {
		t.Fatal(err)
	}
	if previewResult.Mode != "preview" || previewResult.Status != "preview" || previewResult.PreviewToken == "" {
		t.Fatalf("preview result = %+v", previewResult)
	}
	if got := previewResult.NormalizedInputs["work"]; got != "RJ09999991" {
		t.Fatalf("normalized work = %#v", got)
	}
	if previewResult.Plan == nil || fmt.Sprint(previewResult.Plan.TopologicalOrder) != "[work_input fetch]" {
		t.Fatalf("preview plan = %+v", previewResult.Plan)
	}
	if fmt.Sprint(previewResult.RequiredPermissions) != "[downloads:manage workflows:run]" {
		t.Fatalf("required permissions = %v", previewResult.RequiredPermissions)
	}
	assertCustomWorkflowAPICount(t, db, "workflow_run", 0)
	assertCustomWorkflowAPICount(t, db, "work", 0)

	staleConfirm := requestCustomWorkflowAPIRun(t, server, definitionID, actor, `{"mode":"confirm","inputs":{"work":"RJ09999992"},"previewToken":"`+previewResult.PreviewToken+`"}`)
	if staleConfirm.Code != http.StatusConflict {
		t.Fatalf("stale confirm status = %d, body = %s", staleConfirm.Code, staleConfirm.Body.String())
	}
	assertCustomWorkflowAPICount(t, db, "workflow_run", 0)

	confirm := requestCustomWorkflowAPIRun(t, server, definitionID, actor, `{"mode":"confirm","inputs":{"work":"RJ09999991"},"previewToken":"`+previewResult.PreviewToken+`"}`)
	if confirm.Code != http.StatusAccepted {
		t.Fatalf("confirm status = %d, body = %s", confirm.Code, confirm.Body.String())
	}
	var confirmResult customWorkflowRunResponse
	if err := json.Unmarshal(confirm.Body.Bytes(), &confirmResult); err != nil {
		t.Fatal(err)
	}
	if confirmResult.Mode != "confirm" || confirmResult.Status != "queued" || confirmResult.RunID <= 0 {
		t.Fatalf("confirm result = %+v", confirmResult)
	}

	var runStatus, triggerType, triggerReason, inputJSON string
	if err := db.QueryRow(`SELECT status, trigger_type, trigger_reason, input_json FROM workflow_run WHERE id = ?`, confirmResult.RunID).
		Scan(&runStatus, &triggerType, &triggerReason, &inputJSON); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" || triggerType != "manual" || triggerReason != "custom_definition" || !strings.Contains(inputJSON, `"work":"RJ09999991"`) {
		t.Fatalf("run = status %s, trigger %s/%s, input %s", runStatus, triggerType, triggerReason, inputJSON)
	}
	var nodeRuns int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ? AND status = 'queued'`, confirmResult.RunID).Scan(&nodeRuns); err != nil {
		t.Fatal(err)
	}
	if nodeRuns != 2 {
		t.Fatalf("queued node runs = %d, want 2", nodeRuns)
	}
	var workerType, jobStatus, payloadJSON string
	var recoverable, progressTotal int
	if err := db.QueryRow(`SELECT worker_type, status, recoverable, progress_total, payload_json FROM workflow_job WHERE workflow_run_id = ?`, confirmResult.RunID).
		Scan(&workerType, &jobStatus, &recoverable, &progressTotal, &payloadJSON); err != nil {
		t.Fatal(err)
	}
	if workerType != "custom_workflow" || jobStatus != "queued" || recoverable != 1 || progressTotal != 2 {
		t.Fatalf("job = %s/%s recoverable=%d progressTotal=%d", workerType, jobStatus, recoverable, progressTotal)
	}
	var jobPayload customWorkflowJobPayload
	if err := json.Unmarshal([]byte(payloadJSON), &jobPayload); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(jobPayload.DefinitionJSON, `"schemaVersion": 2`) || jobPayload.UserID != ownerID {
		t.Fatalf("job payload omitted definition snapshot or actor: %+v", jobPayload)
	}
	detailResponse := requestWorkflowResource(t, server.getWorkflowRun, http.MethodGet, confirmResult.RunID, actor, "")
	if detailResponse.Code != http.StatusOK {
		t.Fatalf("run detail status = %d, body = %s", detailResponse.Code, detailResponse.Body.String())
	}
	var detail struct {
		GraphJSON string `json:"graphJson"`
	}
	if err := json.Unmarshal(detailResponse.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	var runGraph customWorkflowRunGraph
	if err := json.Unmarshal([]byte(detail.GraphJSON), &runGraph); err != nil {
		t.Fatal(err)
	}
	if runGraph.SchemaVersion != 1 || len(runGraph.Nodes) != 2 || len(runGraph.Edges) != 1 || runGraph.Edges[0].DataType != "work_candidates" {
		t.Fatalf("run graph = %+v", runGraph)
	}
	if strings.Contains(detail.GraphJSON, "excludeExtensions") || strings.Contains(detail.GraphJSON, "maxBytes") {
		t.Fatalf("run graph leaked node config: %s", detail.GraphJSON)
	}
	assertCustomWorkflowAPICount(t, db, "work", 0)
}

func TestCustomWorkflowExecutionRecordsNodeLifecycleEvents(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-lifecycle-owner")
	definitionJSON := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"input","type":"input_text","displayName":"Text input","config":{"value":"hello"},"position":{"x":0,"y":40}},
			{"id":"template","type":"template_text","displayName":"Text template","config":{"template":"{{.Value}} world"},"position":{"x":260,"y":40}}
		],
		"edges":[{"id":"input_to_template","source":"input","sourceHandle":"value","target":"template","targetHandle":"value"}],
		"policy":{"requirePreview":false}
	}`
	result, err := db.Exec(`INSERT INTO workflow_definition (code, display_name, description, definition_json, scope, editable, owner_user_id) VALUES ('lifecycle_test', 'Lifecycle test', '', ?, 'user', 1, ?)`, definitionJSON, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, _ := result.LastInsertId()
	graph, err := validateCustomWorkflowDefinition(definitionJSON)
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	runID, err := server.enqueueCustomWorkflow(context.Background(), workflowDefinitionRecord{
		ID: definitionID, Code: "lifecycle_test", DisplayName: "Lifecycle test", DefinitionJSON: definitionJSON, OwnerUserID: &ownerID,
	}, graph, ownerID, []string{"workflows:run"}, map[string]any{}, "", customWorkflowEnqueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var job workflowJobRecord
	if err := db.QueryRow(`SELECT id, workflow_run_id, COALESCE(workflow_node_run_id, 0), worker_type, payload_json, checkpoint_json FROM workflow_job WHERE workflow_run_id = ?`, runID).
		Scan(&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON, &job.CheckpointJSON); err != nil {
		t.Fatal(err)
	}
	if err := server.executeCustomWorkflowJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	var started, completed int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'custom_workflow.node_started'`, runID).Scan(&started); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'custom_workflow.node_completed'`, runID).Scan(&completed); err != nil {
		t.Fatal(err)
	}
	if started != 2 || completed != 2 {
		t.Fatalf("node lifecycle events = started:%d completed:%d", started, completed)
	}
	var runStatus string
	if err := db.QueryRow(`SELECT status FROM workflow_run WHERE id = ?`, runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" {
		t.Fatalf("run status = %s", runStatus)
	}
}

func TestCustomWorkflowRunEnforcesCapabilityPermissionAndOwnership(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-owner-permission")
	otherID := insertCustomWorkflowAPIUser(t, db, "workflow-other")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	server := NewServer(db, config.Config{})

	missingPermission := requestCustomWorkflowAPIRun(t, server, definitionID,
		account.User{ID: ownerID, Permissions: []string{"workflows:run"}},
		`{"mode":"preview","inputs":{"work":"RJ09999991"}}`)
	if missingPermission.Code != http.StatusForbidden || !strings.Contains(missingPermission.Body.String(), `"permission":"downloads:manage"`) {
		t.Fatalf("missing permission response = %d, %s", missingPermission.Code, missingPermission.Body.String())
	}

	wrongOwner := requestCustomWorkflowAPIRun(t, server, definitionID,
		account.User{ID: otherID, Permissions: []string{"workflows:run", "downloads:manage"}},
		`{"mode":"preview","inputs":{"work":"RJ09999991"}}`)
	if wrongOwner.Code != http.StatusForbidden {
		t.Fatalf("wrong owner response = %d, %s", wrongOwner.Code, wrongOwner.Body.String())
	}

	administrator := requestCustomWorkflowAPIRun(t, server, definitionID,
		account.User{ID: otherID, Permissions: []string{"system:admin", "workflows:run"}},
		`{"mode":"preview","inputs":{"work":"RJ09999991"}}`)
	if administrator.Code != http.StatusOK {
		t.Fatalf("administrator response = %d, %s", administrator.Code, administrator.Body.String())
	}
	if _, err := db.Exec("UPDATE workflow_definition SET owner_user_id = NULL WHERE id = ?", definitionID); err != nil {
		t.Fatal(err)
	}
	ownerless := requestCustomWorkflowAPIRun(t, server, definitionID,
		account.User{ID: ownerID, Permissions: []string{"workflows:run", "downloads:manage"}},
		`{"mode":"preview","inputs":{"work":"RJ09999991"}}`)
	if ownerless.Code != http.StatusForbidden {
		t.Fatalf("ownerless definition response = %d, %s", ownerless.Code, ownerless.Body.String())
	}
	assertCustomWorkflowAPICount(t, db, "workflow_run", 0)
}

func TestCustomWorkflowApprovedPolicyAllowsBoundedDirectConfirm(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-auto-owner")
	automaticDefinition := strings.Replace(customWorkflowAPIDefinitionJSON, `"maxBytes": 1048576`, `"maxBytes": 1048576, "minFreeBytes": 1048576, "allowUnknownSizes": false`, 1)
	automaticDefinition = strings.Replace(automaticDefinition, `"requirePreview": true`, `"requirePreview": false`, 1)
	result, err := db.Exec(`
		INSERT INTO workflow_definition (
			code, display_name, description, definition_json, scope, editable, owner_user_id, created_by_user_id
		) VALUES ('custom_auto_test', 'Custom auto test', 'Synthetic approved workflow', ?, 'user', 1, ?, ?)
	`, automaticDefinition, ownerID, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	response := requestCustomWorkflowAPIRun(t, server, definitionID,
		account.User{ID: ownerID, Permissions: []string{"workflows:run", "downloads:manage"}},
		`{"mode":"confirm","inputs":{"work":"CC0001"}}`)
	if response.Code != http.StatusAccepted {
		t.Fatalf("direct confirm status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestWorkflowCommandAliasIsUniquePerOwner(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-alias-owner")
	otherID := insertCustomWorkflowAPIUser(t, db, "workflow-alias-other")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	server := NewServer(db, config.Config{})

	if err := server.ensureWorkflowCommandAliasAvailable(context.Background(), ownerID, 0, customWorkflowAPIDefinitionJSON); err == nil || !strings.Contains(err.Error(), "/fetchWork") {
		t.Fatalf("duplicate alias error = %v", err)
	}
	if err := server.ensureWorkflowCommandAliasAvailable(context.Background(), ownerID, definitionID, customWorkflowAPIDefinitionJSON); err != nil {
		t.Fatalf("same definition alias should be allowed: %v", err)
	}
	if err := server.ensureWorkflowCommandAliasAvailable(context.Background(), otherID, 0, customWorkflowAPIDefinitionJSON); err != nil {
		t.Fatalf("aliases are scoped to their owner: %v", err)
	}
}

func TestCustomWorkflowScheduleAcceptsBoundedDAG(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-trigger-owner")
	definition := `{
		"schemaVersion":2,
		"inputs":[{"key":"works","label":"Works","type":"work_codes","required":true}],
		"nodes":[{"id":"input","type":"workflow_input","config":{"inputKey":"works"}}],
		"edges":[],
		"policy":{"requirePreview":false}
	}`
	result, err := db.Exec(`INSERT INTO workflow_definition (code, display_name, definition_json, scope, editable, owner_user_id, created_by_user_id) VALUES ('custom_schedule_test', 'Custom schedule', ?, 'user', 1, ?, ?)`, definition, ownerID, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, _ := result.LastInsertId()
	server := NewServer(db, config.Config{})
	body := fmt.Sprintf(`{"workflowDefinitionId":%d,"displayName":"Custom schedule","triggerType":"schedule","enabled":true,"scheduleJson":"{\"intervalMinutes\":5}","configJson":"{\"inputs\":{\"works\":\"RJ09999991\"}}"}`, definitionID)
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: []string{"workflows:run"}}))
	response := httptest.NewRecorder()
	server.createWorkflowTrigger(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("custom schedule response = %d, %s", response.Code, response.Body.String())
	}
	var triggerID int64
	var nextRunAt sql.NullString
	if err := db.QueryRow("SELECT id, next_run_at FROM workflow_trigger WHERE workflow_definition_id = ?", definitionID).Scan(&triggerID, &nextRunAt); err != nil {
		t.Fatal(err)
	}
	if !nextRunAt.Valid || nextRunAt.String == "" {
		t.Fatalf("custom workflow next run = %#v", nextRunAt)
	}
	if _, err := db.Exec("UPDATE workflow_trigger SET next_run_at = '2000-01-01 00:00:00' WHERE id = ?", triggerID); err != nil {
		t.Fatal(err)
	}
	if err := server.dispatchDueCustomWorkflowTrigger(context.Background()); err != nil {
		t.Fatalf("dispatch schedule: %v", err)
	}
	var runTriggerID sql.NullInt64
	var runType, runReason string
	if err := db.QueryRow("SELECT trigger_id, trigger_type, trigger_reason FROM workflow_run WHERE workflow_definition_id = ?", definitionID).Scan(&runTriggerID, &runType, &runReason); err != nil {
		t.Fatal(err)
	}
	if !runTriggerID.Valid || runTriggerID.Int64 != triggerID || runType != "schedule" || runReason != "scheduled_interval" {
		t.Fatalf("scheduled run = trigger %#v type %s reason %s", runTriggerID, runType, runReason)
	}
}

func TestCustomWorkflowRunReadReviewAndCandidateAccessIsOwnerScoped(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-read-owner")
	otherID := insertCustomWorkflowAPIUser(t, db, "workflow-read-other")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)

	customRunResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason, input_json
		) VALUES (?, 'custom_fetch_test', 'Private custom run', 'succeeded', 'manual', 'custom_definition', ?)
	`, definitionID, mustJSON(map[string]any{"requested_by_user_id": ownerID}))
	if err != nil {
		t.Fatal(err)
	}
	customRunID, _ := customRunResult.LastInsertId()
	customNodeResult, err := db.Exec(`
		INSERT INTO workflow_node_run (
			workflow_run_id, node_id, node_type, display_name, position, status, input_json, output_json
		) VALUES (?, 'fetch', 'fetch_works', 'Private fetch', 1, 'succeeded', ?, ?)
	`, customRunID, `{"config":{"sourceId":91,"targetRoot":"private/<work_code>"}}`, `{"completed":{"codes":["RJ09999991"]}}`)
	if err != nil {
		t.Fatal(err)
	}
	customNodeID, _ := customNodeResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO workflow_event (workflow_run_id, workflow_node_run_id, level, event_type, message, detail_json)
		VALUES (?, ?, 'info', 'private.event', 'Private event', '{"code":"RJ09999991"}')
	`, customRunID, customNodeID); err != nil {
		t.Fatal(err)
	}
	customCandidateResult, err := db.Exec(`
		INSERT INTO workflow_candidate (
			workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json
		) VALUES (?, ?, 'synthetic_private', 'RJ09999991', 'ignored', '{"private":true}')
	`, customRunID, customNodeID)
	if err != nil {
		t.Fatal(err)
	}
	customCandidateID, _ := customCandidateResult.LastInsertId()

	systemDefinitionResult, err := db.Exec(`
		INSERT INTO workflow_definition (code, display_name, scope, editable)
		VALUES ('shared_system_audit', 'Shared system audit', 'system', 0)
	`)
	if err != nil {
		t.Fatal(err)
	}
	systemDefinitionID, _ := systemDefinitionResult.LastInsertId()
	systemRunResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason
		) VALUES (?, 'shared_system_audit', 'Shared system run', 'succeeded', 'manual', 'shared_test')
	`, systemDefinitionID)
	if err != nil {
		t.Fatal(err)
	}
	systemRunID, _ := systemRunResult.LastInsertId()
	systemNodeResult, err := db.Exec(`
		INSERT INTO workflow_node_run (
			workflow_run_id, node_id, node_type, display_name, position, status, input_json, output_json
		) VALUES (?, 'shared', 'filter_candidates', 'Shared node', 1, 'succeeded', '{}', '{}')
	`, systemRunID)
	if err != nil {
		t.Fatal(err)
	}
	systemNodeID, _ := systemNodeResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO workflow_event (workflow_run_id, workflow_node_run_id, level, event_type, message)
		VALUES (?, ?, 'info', 'shared.event', 'Shared event')
	`, systemRunID, systemNodeID); err != nil {
		t.Fatal(err)
	}
	systemCandidateResult, err := db.Exec(`
		INSERT INTO workflow_candidate (
			workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json
		) VALUES (?, ?, 'synthetic_shared', 'shared', 'ignored', '{}')
	`, systemRunID, systemNodeID)
	if err != nil {
		t.Fatal(err)
	}
	systemCandidateID, _ := systemCandidateResult.LastInsertId()

	server := NewServer(db, config.Config{})
	owner := account.User{ID: ownerID, Permissions: []string{"workflows:run"}}
	other := account.User{ID: otherID, Permissions: []string{"workflows:run"}}

	assertVisibleRunIDs := func(actor account.User, want ...int64) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/workflow-runs?pageSize=100", nil)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
		response := httptest.NewRecorder()
		server.listWorkflowRuns(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("list runs status = %d, body = %s", response.Code, response.Body.String())
		}
		var page struct {
			Runs []struct {
				ID int64 `json:"id"`
			} `json:"runs"`
			Total int64 `json:"total"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		visible := map[int64]bool{}
		for _, run := range page.Runs {
			visible[run.ID] = true
		}
		if page.Total != int64(len(want)) || len(visible) != len(want) {
			t.Fatalf("visible runs = %v, total = %d, want %v", visible, page.Total, want)
		}
		for _, runID := range want {
			if !visible[runID] {
				t.Fatalf("run %d is not visible in %v", runID, visible)
			}
		}
	}

	assertVisibleRunIDs(other, systemRunID)
	assertVisibleRunIDs(owner, customRunID, systemRunID)

	readHandlers := map[string]http.HandlerFunc{
		"detail":     server.getWorkflowRun,
		"events":     server.listWorkflowRunEvents,
		"candidates": server.listWorkflowRunCandidates,
	}
	for name, handler := range readHandlers {
		t.Run(name, func(t *testing.T) {
			if response := requestWorkflowResource(t, handler, http.MethodGet, customRunID, other, ""); response.Code != http.StatusForbidden {
				t.Fatalf("cross-owner custom read = %d, body = %s", response.Code, response.Body.String())
			}
			if response := requestWorkflowResource(t, handler, http.MethodGet, customRunID, owner, ""); response.Code != http.StatusOK {
				t.Fatalf("owner custom read = %d, body = %s", response.Code, response.Body.String())
			}
			if response := requestWorkflowResource(t, handler, http.MethodGet, systemRunID, other, ""); response.Code != http.StatusOK {
				t.Fatalf("shared system read = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}

	if response := requestWorkflowResource(t, server.reviewWorkflowRun, http.MethodPost, customRunID, other, ""); response.Code != http.StatusForbidden {
		t.Fatalf("cross-owner review = %d, body = %s", response.Code, response.Body.String())
	}
	var customReviews int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run_review WHERE workflow_run_id = ?", customRunID).Scan(&customReviews); err != nil {
		t.Fatal(err)
	}
	if customReviews != 0 {
		t.Fatalf("cross-owner review count = %d", customReviews)
	}
	if response := requestWorkflowResource(t, server.reviewWorkflowRun, http.MethodPost, customRunID, owner, ""); response.Code != http.StatusOK {
		t.Fatalf("owner review = %d, body = %s", response.Code, response.Body.String())
	}
	if response := requestWorkflowResource(t, server.reviewWorkflowRun, http.MethodPost, systemRunID, other, ""); response.Code != http.StatusOK {
		t.Fatalf("shared system review = %d, body = %s", response.Code, response.Body.String())
	}
	if response := requestWorkflowResource(t, server.cleanupLocalWorkflowCandidate, http.MethodPost, customCandidateID, other, `{"action":"mark_unavailable"}`); response.Code != http.StatusForbidden {
		t.Fatalf("cross-owner candidate cleanup = %d, body = %s", response.Code, response.Body.String())
	}
	if response := requestWorkflowResource(t, server.reviewArchivedFetchRoots, http.MethodPost, customCandidateID, other, `{"action":"keep_archived"}`); response.Code != http.StatusForbidden {
		t.Fatalf("cross-owner archive review = %d, body = %s", response.Code, response.Body.String())
	}

	updateBody := `{"status":"accepted","decisionJson":"{}"}`
	if response := requestWorkflowResource(t, server.updateWorkflowCandidate, http.MethodPatch, customCandidateID, other, updateBody); response.Code != http.StatusForbidden {
		t.Fatalf("cross-owner candidate update = %d, body = %s", response.Code, response.Body.String())
	}
	var customCandidateStatus string
	if err := db.QueryRow("SELECT status FROM workflow_candidate WHERE id = ?", customCandidateID).Scan(&customCandidateStatus); err != nil {
		t.Fatal(err)
	}
	if customCandidateStatus != "ignored" {
		t.Fatalf("cross-owner update changed candidate to %s", customCandidateStatus)
	}
	if response := requestWorkflowResource(t, server.updateWorkflowCandidate, http.MethodPatch, customCandidateID, owner, updateBody); response.Code != http.StatusOK {
		t.Fatalf("owner candidate update = %d, body = %s", response.Code, response.Body.String())
	}
	if response := requestWorkflowResource(t, server.updateWorkflowCandidate, http.MethodPatch, systemCandidateID, other, updateBody); response.Code != http.StatusOK {
		t.Fatalf("shared system candidate update = %d, body = %s", response.Code, response.Body.String())
	}

	if _, err := db.Exec("DELETE FROM workflow_definition WHERE id = ?", definitionID); err != nil {
		t.Fatal(err)
	}
	assertVisibleRunIDs(other, systemRunID)
	assertVisibleRunIDs(owner, customRunID, systemRunID)
	if response := requestWorkflowResource(t, server.getWorkflowRun, http.MethodGet, customRunID, owner, ""); response.Code != http.StatusOK {
		t.Fatalf("owner read after definition deletion = %d, body = %s", response.Code, response.Body.String())
	}
	if response := requestWorkflowResource(t, server.getWorkflowRun, http.MethodGet, customRunID, other, ""); response.Code != http.StatusForbidden {
		t.Fatalf("cross-owner read after definition deletion = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestManualStaleRecoveryPreservesOtherOwnersCustomRuns(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-recovery-owner")
	otherID := insertCustomWorkflowAPIUser(t, db, "workflow-recovery-other")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	customRunResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason, input_json
		) VALUES (?, 'custom_fetch_test', 'Private stale run', 'queued', 'manual', 'custom_definition', ?)
	`, definitionID, mustJSON(map[string]any{"requested_by_user_id": ownerID}))
	if err != nil {
		t.Fatal(err)
	}
	customRunID, _ := customRunResult.LastInsertId()
	systemDefinitionResult, err := db.Exec(`
		INSERT INTO workflow_definition (code, display_name, scope, editable)
		VALUES ('shared_stale_audit', 'Shared stale audit', 'system', 0)
	`)
	if err != nil {
		t.Fatal(err)
	}
	systemDefinitionID, _ := systemDefinitionResult.LastInsertId()
	systemRunResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason
		) VALUES (?, 'shared_stale_audit', 'Shared stale run', 'queued', 'manual', 'shared_test')
	`, systemDefinitionID)
	if err != nil {
		t.Fatal(err)
	}
	systemRunID, _ := systemRunResult.LastInsertId()

	server := NewServer(db, config.Config{})
	other := account.User{ID: otherID, Permissions: []string{"workflows:run"}}
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/recover-stale", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, other))
	response := httptest.NewRecorder()
	server.recoverStaleWorkflowRuns(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("recover stale status = %d, body = %s", response.Code, response.Body.String())
	}
	var customStatus, systemStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", customRunID).Scan(&customStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", systemRunID).Scan(&systemStatus); err != nil {
		t.Fatal(err)
	}
	if customStatus != "queued" || systemStatus != "failed" {
		t.Fatalf("stale recovery statuses = custom:%s system:%s", customStatus, systemStatus)
	}

	owner := account.User{ID: ownerID, Permissions: []string{"workflows:run"}}
	request = httptest.NewRequest(http.MethodPost, "/api/workflow-runs/recover-stale", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, owner))
	response = httptest.NewRecorder()
	server.recoverStaleWorkflowRuns(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("owner recover stale status = %d, body = %s", response.Code, response.Body.String())
	}
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", customRunID).Scan(&customStatus); err != nil {
		t.Fatal(err)
	}
	if customStatus != "failed" {
		t.Fatalf("owner stale recovery left custom run %s", customStatus)
	}
}

func TestCustomWorkflowFailureDistinguishesFailedAndPendingNodes(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-failure-owner")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	runResult, err := db.Exec(`
		INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type)
		VALUES (?, 'custom_fetch_test', 'Custom fetch test', 'running', 'manual')
	`, definitionID)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := runResult.LastInsertId()
	failedResult, err := db.Exec(`
		INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status)
		VALUES (?, 'first', 'input_work', 'First', 1, 'running')
	`, runID)
	if err != nil {
		t.Fatal(err)
	}
	failedNodeID, _ := failedResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status)
		VALUES (?, 'second', 'fetch_works', 'Second', 2, 'queued')
	`, runID); err != nil {
		t.Fatal(err)
	}
	jobResult, err := db.Exec(`
		INSERT INTO workflow_job (workflow_run_id, workflow_node_run_id, worker_type, status, recoverable)
		VALUES (?, ?, 'custom_workflow', 'running', 1)
	`, runID, failedNodeID)
	if err != nil {
		t.Fatal(err)
	}
	jobID, _ := jobResult.LastInsertId()
	server := NewServer(db, config.Config{})
	job := workflowJobRecord{ID: jobID, RunID: runID, NodeRunID: failedNodeID, WorkerType: "custom_workflow"}
	if err := server.failCustomWorkflowJob(context.Background(), job, failedNodeID, "synthetic failure"); err != nil {
		t.Fatal(err)
	}
	var failedStatus, pendingStatus string
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE id = ?", failedNodeID).Scan(&failedStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'second'", runID).Scan(&pendingStatus); err != nil {
		t.Fatal(err)
	}
	if failedStatus != "failed" || pendingStatus != "skipped" {
		t.Fatalf("node statuses = failed:%s pending:%s", failedStatus, pendingStatus)
	}
	if err := server.requeueFailedWorkflowJob(context.Background(), job, 0, "retry"); err != nil {
		t.Fatal(err)
	}
	var queued int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ? AND status = 'queued'", runID).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 2 {
		t.Fatalf("queued nodes after retry = %d, want 2", queued)
	}
}

func TestCustomWorkflowFailureDoesNotOverwriteCancellation(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-cancel-owner")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	runResult, err := db.Exec(`
		INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type, summary_json, finished_at)
		VALUES (?, 'custom_fetch_test', 'Custom fetch test', 'cancelled', 'manual', '{"cancelled":true}', CURRENT_TIMESTAMP)
	`, definitionID)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := runResult.LastInsertId()
	nodeResult, err := db.Exec(`
		INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status, error_message, finished_at)
		VALUES (?, 'first', 'fetch_works', 'First', 1, 'cancelled', 'cancelled manually', CURRENT_TIMESTAMP)
	`, runID)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, _ := nodeResult.LastInsertId()
	jobResult, err := db.Exec(`
		INSERT INTO workflow_job (workflow_run_id, workflow_node_run_id, worker_type, status, recoverable, error_message)
		VALUES (?, ?, 'custom_workflow', 'cancelled', 1, 'cancelled manually')
	`, runID, nodeID)
	if err != nil {
		t.Fatal(err)
	}
	jobID, _ := jobResult.LastInsertId()
	server := NewServer(db, config.Config{})
	job := workflowJobRecord{ID: jobID, RunID: runID, NodeRunID: nodeID, WorkerType: "custom_workflow"}
	if err := server.failCustomWorkflowJob(context.Background(), job, nodeID, "late failure"); err != nil {
		t.Fatal(err)
	}
	var runStatus, runSummary, nodeStatus, nodeError, jobStatus, jobError string
	if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", runID).Scan(&runStatus, &runSummary); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status, error_message FROM workflow_node_run WHERE id = ?", nodeID).Scan(&nodeStatus, &nodeError); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status, error_message FROM workflow_job WHERE id = ?", jobID).Scan(&jobStatus, &jobError); err != nil {
		t.Fatal(err)
	}
	if runStatus != "cancelled" || runSummary != `{"cancelled":true}` || nodeStatus != "cancelled" || nodeError != "cancelled manually" || jobStatus != "cancelled" || jobError != "cancelled manually" {
		t.Fatalf("late failure overwrote cancellation: run=%s/%s node=%s/%s job=%s/%s", runStatus, runSummary, nodeStatus, nodeError, jobStatus, jobError)
	}
}

func TestCustomWorkflowCancelRequiresRunOwner(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-cancel-action-owner")
	otherID := insertCustomWorkflowAPIUser(t, db, "workflow-cancel-action-other")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	runResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason, input_json
		) VALUES (?, 'custom_fetch_test', 'Custom fetch test', 'queued', 'manual', 'custom_definition', ?)
	`, definitionID, mustJSON(map[string]any{"requested_by_user_id": ownerID}))
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := runResult.LastInsertId()
	nodeResult, err := db.Exec(`
		INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status)
		VALUES (?, 'work_input', 'workflow_input', 'Work input', 1, 'queued')
	`, runID)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, _ := nodeResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO workflow_job (workflow_run_id, workflow_node_run_id, worker_type, status, recoverable)
		VALUES (?, ?, 'custom_workflow', 'queued', 1)
	`, runID, nodeID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	denied := requestWorkflowRunAction(t, server.cancelWorkflowRun, runID, account.User{ID: otherID, Permissions: []string{"workflows:run"}})
	if denied.Code != http.StatusForbidden {
		t.Fatalf("cross-owner cancel = %d, body = %s", denied.Code, denied.Body.String())
	}
	var runStatus, nodeStatus, jobStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE id = ?", nodeID).Scan(&nodeStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_job WHERE workflow_run_id = ?", runID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" || nodeStatus != "queued" || jobStatus != "queued" {
		t.Fatalf("denied cancel changed state: run=%s node=%s job=%s", runStatus, nodeStatus, jobStatus)
	}
	allowed := requestWorkflowRunAction(t, server.cancelWorkflowRun, runID, account.User{ID: ownerID, Permissions: []string{"workflows:run"}})
	if allowed.Code != http.StatusOK {
		t.Fatalf("owner cancel = %d, body = %s", allowed.Code, allowed.Body.String())
	}
}

func TestCustomWorkflowRetryRequiresOwnerAndCurrentPermissions(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-retry-owner")
	otherID := insertCustomWorkflowAPIUser(t, db, "workflow-retry-other")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	runResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason, input_json
		) VALUES (?, 'custom_fetch_test', 'Custom fetch test', 'failed', 'manual', 'custom_definition', ?)
	`, definitionID, mustJSON(map[string]any{"requested_by_user_id": ownerID}))
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := runResult.LastInsertId()
	nodeResult, err := db.Exec(`
		INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status)
		VALUES (?, 'work_input', 'workflow_input', 'Work input', 1, 'failed')
	`, runID)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, _ := nodeResult.LastInsertId()
	payload := customWorkflowJobPayload{
		DefinitionJSON: customWorkflowAPIDefinitionJSON,
		Inputs:         map[string]any{"work": "RJ09999991"},
		UserID:         ownerID,
		Permissions:    []string{"workflows:run", "downloads:manage"},
	}
	if _, err := db.Exec(`
		INSERT INTO workflow_job (workflow_run_id, workflow_node_run_id, worker_type, status, recoverable, payload_json)
		VALUES (?, ?, 'custom_workflow', 'failed', 1, ?)
	`, runID, nodeID, mustJSON(payload)); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	fullPermissions := []string{"workflows:run", "downloads:manage"}
	deniedOwner := requestWorkflowRunAction(t, server.retryWorkflowRun, runID, account.User{ID: otherID, Permissions: fullPermissions})
	if deniedOwner.Code != http.StatusForbidden {
		t.Fatalf("cross-owner retry = %d, body = %s", deniedOwner.Code, deniedOwner.Body.String())
	}
	deniedPermission := requestWorkflowRunAction(t, server.retryWorkflowRun, runID, account.User{ID: ownerID, Permissions: []string{"workflows:run"}})
	if deniedPermission.Code != http.StatusForbidden {
		t.Fatalf("retry without current capability = %d, body = %s", deniedPermission.Code, deniedPermission.Body.String())
	}
	var runStatus, jobStatus string
	var retryCount int
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status, retry_count FROM workflow_job WHERE workflow_run_id = ?", runID).Scan(&jobStatus, &retryCount); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || jobStatus != "failed" || retryCount != 0 {
		t.Fatalf("denied retry changed state: run=%s job=%s retry=%d", runStatus, jobStatus, retryCount)
	}
	allowed := requestWorkflowRunAction(t, server.retryWorkflowRun, runID, account.User{ID: ownerID, Permissions: fullPermissions})
	if allowed.Code != http.StatusAccepted {
		t.Fatalf("owner retry = %d, body = %s", allowed.Code, allowed.Body.String())
	}
}

func TestCustomTrackReusesCompletedChildRunAfterCheckpointGap(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-track-owner")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	parentResult, err := db.Exec(`
		INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type)
		VALUES (?, 'custom_fetch_test', 'Custom track parent', 'running', 'manual')
	`, definitionID)
	if err != nil {
		t.Fatal(err)
	}
	parentRunID, _ := parentResult.LastInsertId()
	if _, err := db.Exec(`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_source_sync', 'Track remote source')`); err != nil {
		t.Fatal(err)
	}
	requestID := customTrackRequestID(parentRunID, "track", 77, "RJ09999991")
	childResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason, input_json
		) VALUES (
			(SELECT id FROM workflow_definition WHERE code = 'remote_source_sync'),
			'remote_source_sync', 'Track remote source', 'succeeded', 'manual', ?, ?
		)
	`, requestID, mustJSON(map[string]any{"file_source_id": 77, "work_code": "RJ09999991", "requested_work_code": "RJ09999991"}))
	if err != nil {
		t.Fatal(err)
	}
	childRunID, _ := childResult.LastInsertId()
	matchResult, err := db.Exec(`
		INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status, output_json)
		VALUES (?, 'match', 'match_works', 'Match works', 1, 'succeeded', '{"work_id":91}')
	`, childRunID)
	if err != nil {
		t.Fatal(err)
	}
	matchNodeID, _ := matchResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO workflow_job (workflow_run_id, workflow_node_run_id, worker_type, status)
		VALUES (?, ?, 'kikoeru_remote_sync', 'succeeded')
	`, childRunID, matchNodeID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	node := customWorkflowNode{ID: "track", Type: "track_works", Config: map[string]any{"maxWorks": 1}}
	inputs := map[string]customPortValue{"works": {Type: "work_candidates", Candidates: []customWorkCandidate{{Code: "RJ09999991", SourceID: 77}}}}
	for attempt := 0; attempt < 2; attempt++ {
		execution, err := server.executeCustomTrackWorks(context.Background(), parentRunID, node, inputs)
		if err != nil {
			t.Fatalf("attempt %d: %v", attempt+1, err)
		}
		refs := execution.Outputs["completed"].WorkRefs
		if execution.Partial || len(refs) != 1 || refs[0].ChildRunID != childRunID || refs[0].WorkID != 91 {
			t.Fatalf("attempt %d result = %+v", attempt+1, execution)
		}
	}
	var childCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'remote_source_sync' AND trigger_reason = ?", requestID).Scan(&childCount); err != nil {
		t.Fatal(err)
	}
	if childCount != 1 {
		t.Fatalf("track child count = %d, want 1", childCount)
	}
}

func TestCustomFetchReusesRequestBeforeRemotePreflight(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-fetch-owner")
	definitionID := insertCustomWorkflowAPIDefinition(t, db, ownerID)
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type) VALUES
			(88, 'unreachable', 'Unavailable source', 'kikoeru'),
			(89, 'local-test', 'Local test source', 'local_folder')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (92, 'RJ09999991', 'Synthetic work')`); err != nil {
		t.Fatal(err)
	}
	parentResult, err := db.Exec(`
		INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type)
		VALUES (?, 'custom_fetch_test', 'Custom fetch parent', 'running', 'manual')
	`, definitionID)
	if err != nil {
		t.Fatal(err)
	}
	parentRunID, _ := parentResult.LastInsertId()
	if _, err := db.Exec(`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch remote work')`); err != nil {
		t.Fatal(err)
	}
	childResult, err := db.Exec(`
		INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type)
		VALUES ((SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch remote work', 'queued', 'manual')
	`)
	if err != nil {
		t.Fatal(err)
	}
	childRunID, _ := childResult.LastInsertId()
	requestID := customFetchRequestID(parentRunID, "fetch", "RJ09999991")
	manifestResult, err := db.Exec(`
		INSERT INTO remote_fetch_manifest (
			workflow_run_id, request_id, work_id, remote_source_id, local_source_id,
			edition_code, target_root, staging_root, plan_json
		) VALUES (?, ?, 92, 88, 89, 'RJ09999991', 'library/RJ09999991', 'staging/RJ09999991', '{}')
	`, childRunID, requestID)
	if err != nil {
		t.Fatal(err)
	}
	manifestID, _ := manifestResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_manifest_item (
			manifest_id, relative_path, target_path, source_kind, action, expected_size_bytes, remote_source_id
		) VALUES
			(?, 'track.mp3', 'library/RJ09999991/track.mp3', 'remote', 'cache_download', 512, 88),
			(?, 'cached.mp3', 'library/RJ09999991/cached.mp3', 'cache', 'cache_hit', 256, 88)
	`, manifestID, manifestID); err != nil {
		t.Fatal(err)
	}
	stored := remoteWorkSaveResult{RunID: childRunID, WorkID: 92, PrimaryCode: "RJ09999991", Status: "queued", RequestID: requestID}
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_request (request_id, source_id, work_code, workflow_run_id, result_json)
		VALUES (?, 88, 'RJ09999991', ?, ?)
	`, requestID, childRunID, mustJSON(stored)); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	usage, err := server.customFetchPersistedUsage(context.Background(), childRunID)
	if err != nil {
		t.Fatal(err)
	}
	if usage.Files != 2 || usage.Bytes != 768 || usage.Unknown != 0 {
		t.Fatalf("persisted fetch usage = %+v", usage)
	}
	node := customWorkflowNode{ID: "fetch", Type: "fetch_works", Config: map[string]any{"maxWorks": 1, "maxFiles": 10, "maxBytes": 1024}}
	inputs := map[string]customPortValue{"works": {Type: "work_candidates", Candidates: []customWorkCandidate{{Code: "RJ09999991", SourceID: 88}}}}
	for attempt := 0; attempt < 2; attempt++ {
		execution, err := server.executeCustomFetchWorks(context.Background(), parentRunID, node, inputs)
		if err != nil {
			t.Fatalf("attempt %d: %v", attempt+1, err)
		}
		if execution.Partial || execution.Pending == nil || len(execution.Pending.Children) != 1 || execution.Pending.Children[0].RunID != childRunID {
			t.Fatalf("attempt %d result = %+v", attempt+1, execution)
		}
	}
	if _, err := db.Exec("UPDATE workflow_run SET status = 'succeeded' WHERE id = ?", childRunID); err != nil {
		t.Fatal(err)
	}
	execution, waiting, err := server.resumeCustomPendingExecution(context.Background(), customPendingExecution{
		NodeID: "fetch", Kind: "fetch", Children: []customPendingChild{{
			RunID:     childRunID,
			Candidate: customWorkCandidate{Code: "RJ09999991", SourceID: 88},
			WorkRef:   customWorkRef{Code: "RJ09999991", WorkID: 92, SourceID: 88, ChildRunID: childRunID},
		}},
	})
	if err != nil || waiting {
		t.Fatalf("resume fetch: waiting=%t err=%v", waiting, err)
	}
	refs := execution.Outputs["completed"].WorkRefs
	if execution.Partial || len(refs) != 1 || refs[0].ChildRunID != childRunID || refs[0].WorkID != 92 {
		t.Fatalf("resumed result = %+v", execution)
	}
}

func TestCustomFilterWorksUsesNormalizedMetadataAndUserTags(t *testing.T) {
	db := openMigratedTestDB(t)
	userID := insertCustomWorkflowAPIUser(t, db, "workflow-filter-owner")
	workResult, err := db.Exec(`INSERT INTO work (primary_code, title, release_date) VALUES ('RJ09999991', 'Synthetic work', '2026-04-03')`)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	personResult, err := db.Exec(`INSERT INTO person (display_name, sort_name) VALUES ('Example Voice', 'Example Voice')`)
	if err != nil {
		t.Fatal(err)
	}
	personID, _ := personResult.LastInsertId()
	if _, err := db.Exec(`INSERT INTO work_credit (work_id, person_id, role) VALUES (?, ?, 'voice_actor')`, workID, personID); err != nil {
		t.Fatal(err)
	}
	tagResult, err := db.Exec(`INSERT INTO tag (namespace, normalized_name, display_name) VALUES ('dlsite', 'healing', 'Healing')`)
	if err != nil {
		t.Fatal(err)
	}
	tagID, _ := tagResult.LastInsertId()
	if _, err := db.Exec(`INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'dlsite')`, workID, tagID); err != nil {
		t.Fatal(err)
	}
	userTagResult, err := db.Exec(`INSERT INTO user_tag (user_id, name) VALUES (?, 'Listen later')`, userID)
	if err != nil {
		t.Fatal(err)
	}
	userTagID, _ := userTagResult.LastInsertId()
	if _, err := db.Exec(`INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (?, ?, ?)`, userID, workID, userTagID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	node := customWorkflowNode{Type: "filter_works", Config: map[string]any{
		"releaseFrom": "2026-01-01", "releaseTo": "2026-12-31",
		"voiceNames": []string{"example voice"}, "metadataTags": []string{"healing"}, "userTags": []string{"listen later"},
	}}
	inputs := map[string]customPortValue{"works": {Type: "work_candidates", Candidates: []customWorkCandidate{{Code: "RJ09999991"}}}}
	execution, err := server.executeCustomFilterWorks(context.Background(), userID, node, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if len(execution.Outputs["accepted"].Candidates) != 1 || len(execution.Outputs["rejected"].Candidates) != 0 {
		t.Fatalf("filter result = %+v", execution.Outputs)
	}
	node.Config["metadataTags"] = []string{"missing"}
	execution, err = server.executeCustomFilterWorks(context.Background(), userID, node, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if len(execution.Outputs["accepted"].Candidates) != 0 || len(execution.Outputs["rejected"].Candidates) != 1 {
		t.Fatalf("rejected filter result = %+v", execution.Outputs)
	}
}

func TestCustomSubworkflowWaitsAndCollectsTerminalWorkRefs(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-subflow-owner")
	childDefinition := `{
		"schemaVersion":2,
		"inputs":[{"key":"works","label":"Works","type":"work_codes","required":true}],
		"nodes":[
			{"id":"input","type":"workflow_input","config":{"inputKey":"works"}},
			{"id":"metadata","type":"metadata_sync","config":{"maxWorks":10}}
		],
		"edges":[{"id":"to_metadata","source":"input","sourceHandle":"value","target":"metadata","targetHandle":"works"}],
		"policy":{"requirePreview":true}
	}`
	result, err := db.Exec(`INSERT INTO workflow_definition (code, display_name, definition_json, scope, editable, owner_user_id, created_by_user_id) VALUES ('child_metadata_test', 'Child metadata', ?, 'user', 1, ?, ?)`, childDefinition, ownerID, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	childDefinitionID, _ := result.LastInsertId()
	server := NewServer(db, config.Config{})
	payload := customWorkflowJobPayload{UserID: ownerID, OwnerUserID: ownerID, Permissions: []string{"workflows:run", "metadata:sync"}, DefinitionStack: []int64{999}}
	node := customWorkflowNode{ID: "reuse", Type: "subworkflow", Config: map[string]any{"definitionId": childDefinitionID, "inputKey": "works", "maxWorks": 10}}
	inputs := map[string]customPortValue{"works": {Type: "work_candidates", Candidates: []customWorkCandidate{{Code: "RJ09999991"}}}}
	execution, err := server.executeCustomSubworkflow(context.Background(), 123, payload, node, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if execution.Pending == nil || len(execution.Pending.Children) != 1 {
		t.Fatalf("subworkflow execution = %+v", execution)
	}
	childRunID := execution.Pending.Children[0].RunID
	if _, err := db.Exec("UPDATE workflow_run SET status = 'succeeded' WHERE id = ?", childRunID); err != nil {
		t.Fatal(err)
	}
	checkpoint := customWorkflowCheckpoint{CompletedNodeIDs: []string{"input", "metadata"}, Outputs: map[string]map[string]customPortValue{
		"metadata": {"completed": {Type: "work_refs", WorkRefs: []customWorkRef{{Code: "RJ09999991", WorkID: 91}}}},
	}}
	if _, err := db.Exec("UPDATE workflow_job SET checkpoint_json = ? WHERE workflow_run_id = ?", mustJSON(map[string]any{"phase": "completed", "detail": checkpoint}), childRunID); err != nil {
		t.Fatal(err)
	}
	resumed, waiting, err := server.resumeCustomPendingExecution(context.Background(), *execution.Pending)
	if err != nil || waiting {
		t.Fatalf("resume subworkflow: waiting=%t err=%v", waiting, err)
	}
	refs := resumed.Outputs["completed"].WorkRefs
	if resumed.Partial || len(refs) != 1 || refs[0].WorkID != 91 {
		t.Fatalf("resumed subworkflow = %+v", resumed)
	}
}

func requestCustomWorkflowAPIRun(t *testing.T, server *Server, definitionID int64, actor account.User, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-definitions/"+strconv.FormatInt(definitionID, 10)+"/runs", strings.NewReader(body))
	request.SetPathValue("id", strconv.FormatInt(definitionID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	server.runCustomWorkflowDefinition(response, request)
	return response
}

func requestWorkflowRunAction(t *testing.T, handler http.HandlerFunc, runID int64, actor account.User) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/"+strconv.FormatInt(runID, 10), nil)
	request.SetPathValue("id", strconv.FormatInt(runID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func requestWorkflowResource(t *testing.T, handler http.HandlerFunc, method string, resourceID int64, actor account.User, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/api/workflow-resource/"+strconv.FormatInt(resourceID, 10), strings.NewReader(body))
	request.SetPathValue("id", strconv.FormatInt(resourceID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func insertCustomWorkflowAPIUser(t *testing.T, db *sql.DB, username string) int64 {
	t.Helper()
	result, err := db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES (?, ?, 'admin')`, username, username)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func insertCustomWorkflowAPIDefinition(t *testing.T, db *sql.DB, ownerID int64) int64 {
	t.Helper()
	result, err := db.Exec(`
		INSERT INTO workflow_definition (
			code, display_name, description, definition_json, scope, editable, owner_user_id, created_by_user_id
		) VALUES ('custom_fetch_test', 'Custom fetch test', 'Synthetic custom workflow', ?, 'user', 1, ?, ?)
	`, customWorkflowAPIDefinitionJSON, ownerID, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func assertCustomWorkflowAPICount(t *testing.T, db *sql.DB, table string, want int) {
	t.Helper()
	if table != "workflow_run" && table != "work" {
		t.Fatalf("unsupported count table: %s", table)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("%s count = %d, want %d", table, count, want)
	}
}
