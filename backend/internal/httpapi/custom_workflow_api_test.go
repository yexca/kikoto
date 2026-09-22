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
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const customWorkflowAPIDefinitionJSON = `{
  "schemaVersion": 2,
  "nodes": [
    {
      "id": "discover",
      "type": "series_catalog",
      "displayName": "Series catalog",
      "config": {"seriesId": "SRI0000001", "maxWorks": 2},
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
      "id": "discover_to_fetch",
      "source": "discover",
      "sourceHandle": "works",
      "target": "fetch",
      "targetHandle": "works"
    }
  ],
  "policy": {"requirePreview": true}
}`

func TestCustomWorkflowExecutionRecordsNodeLifecycleEvents(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-lifecycle-owner")
	definitionJSON := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"discover","type":"series_catalog","displayName":"Series catalog","config":{"seriesId":"SRI0000001","maxWorks":10},"position":{"x":0,"y":40}},
			{"id":"filter","type":"filter_works","displayName":"Filter works","config":{"limit":10},"position":{"x":260,"y":40}}
		],
		"edges":[{"id":"discover_to_filter","source":"discover","sourceHandle":"works","target":"filter","targetHandle":"works"}],
		"policy":{"requirePreview":false}
	}`
	result, err := db.Exec(`INSERT INTO workflow_definition (code, display_name, description, definition_json, scope, editable) VALUES ('lifecycle_test', 'Lifecycle test', '', ?, 'system', 0)`, definitionJSON)
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
		ID: definitionID, Code: "lifecycle_test", DisplayName: "Lifecycle test", DefinitionJSON: definitionJSON, Scope: "system",
	}, graph, ownerID, []string{"workflows:run"}, map[string]any{}, customWorkflowEnqueueOptions{})
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

func TestLocalLibraryScanAcceptsStartupAndScheduleTriggers(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "system-schedule-owner")
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := db.QueryRow("SELECT id FROM workflow_definition WHERE code = 'local_library_scan'").Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"workflowDefinitionId":%d,"displayName":"Daily startup refresh","triggerType":"schedule","enabled":true,"scheduleJson":"{\"intervalMinutes\":1440}","configJson":"{\"followUpRun\":true}"}`, definitionID)
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: []string{"workflows:run", "metadata:sync"}}))
	response := httptest.NewRecorder()
	server.createWorkflowTrigger(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("system schedule response = %d, %s", response.Code, response.Body.String())
	}
	var triggerCount, startupCount, scheduleCount int
	if err := db.QueryRow(`SELECT COUNT(*), SUM(trigger_type = 'startup'), SUM(trigger_type = 'schedule') FROM workflow_trigger WHERE workflow_definition_id = ?`, definitionID).Scan(&triggerCount, &startupCount, &scheduleCount); err != nil {
		t.Fatal(err)
	}
	if triggerCount != 3 || startupCount != 1 || scheduleCount != 1 {
		t.Fatalf("system triggers = total %d startup %d schedule %d", triggerCount, startupCount, scheduleCount)
	}
	var scheduleTriggerID int64
	var scheduleConfigJSON string
	if err := db.QueryRow("SELECT id, config_json FROM workflow_trigger WHERE workflow_definition_id = ? AND trigger_type = 'schedule'", definitionID).Scan(&scheduleTriggerID, &scheduleConfigJSON); err != nil {
		t.Fatal(err)
	}
	var scheduleConfig localScanTriggerConfig
	if err := json.Unmarshal([]byte(scheduleConfigJSON), &scheduleConfig); err != nil {
		t.Fatal(err)
	}
	if !scheduleConfig.FollowUpRun {
		t.Fatalf("local scan schedule config = %s", scheduleConfigJSON)
	}
	trigger, err := server.loadWorkflowTrigger(context.Background(), scheduleTriggerID)
	if err != nil {
		t.Fatal(err)
	}
	definition, err := server.loadWorkflowDefinition(context.Background(), definitionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.executeSystemWorkflowTrigger(context.Background(), definition, trigger, "schedule", "scheduled_interval"); err != nil {
		t.Fatal(err)
	}
	var runInputJSON string
	if err := db.QueryRow("SELECT input_json FROM workflow_run WHERE trigger_id = ? ORDER BY id DESC LIMIT 1", scheduleTriggerID).Scan(&runInputJSON); err != nil {
		t.Fatal(err)
	}
	var runInput localScanJobPayload
	if err := json.Unmarshal([]byte(runInputJSON), &runInput); err != nil {
		t.Fatal(err)
	}
	if !runInput.FollowUpRun || runInput.ScanMode != localScanModeFull {
		t.Fatalf("triggered local scan input = %s", runInputJSON)
	}
}

func TestRunStartupWorkflowsDoesNotRecreateDeletedBuiltInTrigger(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		DELETE FROM workflow_trigger
		WHERE workflow_definition_id = (
			SELECT id FROM workflow_definition WHERE code = 'local_library_scan'
		)
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	if err := server.RunStartupWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	var triggerCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan'
	`).Scan(&triggerCount); err != nil {
		t.Fatal(err)
	}
	if triggerCount != 0 {
		t.Fatalf("local scan startup triggers = %d, want 0", triggerCount)
	}
}

func TestRemotePopularSchedulePersistsTemplateAndResolvesItPerRun(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "remote-popular-schedule-owner")
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (91, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (91, 'https://example.invalid', 'https://example.invalid/api')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := db.QueryRow("SELECT id FROM workflow_definition WHERE code = 'remote_popular_collection'").Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	configJSON := mustJSON(map[string]any{
		"sourceId": 91, "action": "track", "limit": 25, "tagNameTemplate": "{date}_{remote_name}_popular",
	})
	body := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": "Daily remote popular", "triggerType": "schedule", "enabled": true,
		"scheduleJson": `{"intervalMinutes":1440}`, "configJson": configJSON,
	})
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: []string{"workflows:run", "tags:write"}}))
	response := httptest.NewRecorder()
	server.createWorkflowTrigger(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("remote popular schedule response = %d, %s", response.Code, response.Body.String())
	}
	var trigger workflowTriggerRecord
	if err := json.Unmarshal(response.Body.Bytes(), &trigger); err != nil {
		t.Fatal(err)
	}
	var storedConfig systemWorkflowTriggerConfig
	if err := json.Unmarshal([]byte(trigger.ConfigJSON), &storedConfig); err != nil {
		t.Fatal(err)
	}
	if storedConfig.UserID != ownerID || storedConfig.TagNameTemplate != "{date}_{remote_name}_popular" {
		t.Fatalf("stored schedule config = %+v", storedConfig)
	}
	definition, err := server.loadWorkflowDefinition(context.Background(), definitionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.executeSystemWorkflowTrigger(context.Background(), definition, trigger, "schedule", "scheduled_interval"); err != nil {
		t.Fatal(err)
	}
	var runTriggerID sql.NullInt64
	var triggerType, triggerReason, inputJSON string
	if err := db.QueryRow(`SELECT trigger_id, trigger_type, trigger_reason, input_json FROM workflow_run WHERE workflow_definition_id = ? ORDER BY id DESC LIMIT 1`, definitionID).Scan(&runTriggerID, &triggerType, &triggerReason, &inputJSON); err != nil {
		t.Fatal(err)
	}
	if !runTriggerID.Valid || runTriggerID.Int64 != trigger.ID || triggerType != "schedule" || triggerReason != "scheduled_interval" {
		t.Fatalf("scheduled run = trigger %#v type %s reason %s", runTriggerID, triggerType, triggerReason)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(inputJSON), &input); err != nil {
		t.Fatal(err)
	}
	tagName := fmt.Sprint(input["tag_name"])
	if strings.Contains(tagName, "{") || !strings.HasSuffix(tagName, "_Example_Remote_popular") {
		t.Fatalf("resolved scheduled tag = %q", tagName)
	}
}

func TestWorkflowTagNameTemplateRejectsUnknownTokensAndChangesByDate(t *testing.T) {
	first, err := renderWorkflowTagNameTemplate("{date}_{remote_name}_popular", map[string]string{"date": "260725", "remote_name": "Example_Remote"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := renderWorkflowTagNameTemplate("{date}_{remote_name}_popular", map[string]string{"date": "260726", "remote_name": "Example_Remote"})
	if err != nil {
		t.Fatal(err)
	}
	if first != "260725_Example_Remote_popular" || second != "260726_Example_Remote_popular" || first == second {
		t.Fatalf("rendered tags = %q and %q", first, second)
	}
	if _, err := renderWorkflowTagNameTemplate("{unknown}_popular", map[string]string{"date": "260726"}); err == nil {
		t.Fatal("unknown token should fail")
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
		VALUES (?, 'first', 'series_catalog', 'First', 1, 'running')
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

func TestCustomWorkflowRetryRequiresCurrentPermissions(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertCustomWorkflowAPIUser(t, db, "workflow-retry-owner")
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
		VALUES (?, 'discover', 'series_catalog', 'Series catalog', 1, 'failed')
	`, runID)
	if err != nil {
		t.Fatal(err)
	}
	nodeID, _ := nodeResult.LastInsertId()
	payload := customWorkflowJobPayload{
		DefinitionJSON: customWorkflowAPIDefinitionJSON,
		Inputs:         map[string]any{},
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
	requestID := customTrackRequestID(parentRunID, "track", 77, "RJ00000001")
	childResult, err := db.Exec(`
		INSERT INTO workflow_run (
			workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason, input_json
		) VALUES (
			(SELECT id FROM workflow_definition WHERE code = 'remote_source_sync'),
			'remote_source_sync', 'Track remote source', 'succeeded', 'manual', ?, ?
		)
	`, requestID, mustJSON(map[string]any{"file_source_id": 77, "work_code": "RJ00000001", "requested_work_code": "RJ00000001"}))
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
	inputs := map[string]customPortValue{"works": {Type: "work_candidates", Candidates: []customWorkCandidate{{Code: "RJ00000001", SourceID: 77}}}}
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
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (92, 'RJ00000001', 'Synthetic work')`); err != nil {
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
	requestID := customFetchRequestID(parentRunID, "fetch", "RJ00000001")
	manifestResult, err := db.Exec(`
		INSERT INTO remote_fetch_manifest (
			workflow_run_id, request_id, work_id, remote_source_id, local_source_id,
			edition_code, target_root, staging_root, plan_json
		) VALUES (?, ?, 92, 88, 89, 'RJ00000001', 'library/RJ00000001', 'staging/RJ00000001', '{}')
	`, childRunID, requestID)
	if err != nil {
		t.Fatal(err)
	}
	manifestID, _ := manifestResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_manifest_item (
			manifest_id, relative_path, target_path, source_kind, action, expected_size_bytes, remote_source_id
		) VALUES
			(?, 'track.mp3', 'library/RJ00000001/track.mp3', 'remote', 'cache_download', 512, 88),
			(?, 'cached.mp3', 'library/RJ00000001/cached.mp3', 'cache', 'cache_hit', 256, 88)
	`, manifestID, manifestID); err != nil {
		t.Fatal(err)
	}
	stored := remoteWorkSaveResult{RunID: childRunID, WorkID: 92, PrimaryCode: "RJ00000001", Status: "queued", RequestID: requestID}
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_request (request_id, source_id, work_code, workflow_run_id, result_json)
		VALUES (?, 88, 'RJ00000001', ?, ?)
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
	inputs := map[string]customPortValue{"works": {Type: "work_candidates", Candidates: []customWorkCandidate{{Code: "RJ00000001", SourceID: 88}}}}
	for attempt := 0; attempt < 2; attempt++ {
		execution, err := server.executeCustomFetchWorks(context.Background(), parentRunID, 0, workflow.JobPriorityUserInitiated, node, inputs)
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
			Candidate: customWorkCandidate{Code: "RJ00000001", SourceID: 88},
			WorkRef:   customWorkRef{Code: "RJ00000001", WorkID: 92, SourceID: 88, ChildRunID: childRunID},
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
	workResult, err := db.Exec(`INSERT INTO work (primary_code, title, release_date) VALUES ('RJ00000001', 'Synthetic work', '2026-04-03')`)
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
	inputs := map[string]customPortValue{"works": {Type: "work_candidates", Candidates: []customWorkCandidate{{Code: "RJ00000001"}}}}
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
			code, display_name, description, definition_json, scope, editable, created_by_user_id
		) VALUES ('custom_fetch_test', 'Custom fetch test', 'Synthetic preset-shaped workflow', ?, 'system', 0, ?)
	`, customWorkflowAPIDefinitionJSON, ownerID)
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
