package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLegacyWorkflowConversionRequiresExactPresetBehavior(t *testing.T) {
	spec, ok := presetWorkflowSpecByCode("circle_catalog_sync")
	if !ok {
		t.Fatal("circle preset missing")
	}
	inputs, err := normalizePresetWorkflowInputs(spec, map[string]any{"circleId": "RG12345", "metadata": true})
	if err != nil {
		t.Fatal(err)
	}
	graph := buildPresetWorkflowDefinition(spec, inputs, inputs.TagNameTemplate)
	encoded, err := json.Marshal(graph)
	if err != nil {
		t.Fatal(err)
	}
	item := legacyWorkflowSnapshot{ID: 1, Name: "Example workflow", DefinitionJSON: string(encoded),
		Triggers: []legacyWorkflowTrigger{{ID: 1, Type: "startup", Name: "On startup", Enabled: 1, Schedule: json.RawMessage(`{}`), Config: json.RawMessage(`{}`)}}}
	analysis := analyzeLegacyWorkflow(item)
	if !analysis.CanConvert || analysis.Preset != "circle_catalog_sync" {
		t.Fatalf("exact preset was not recognized: %+v", analysis)
	}
	graph.Policy.RequirePreview = nil
	encoded, err = json.Marshal(graph)
	if err != nil {
		t.Fatal(err)
	}
	item.DefinitionJSON = string(encoded)
	if changed := analyzeLegacyWorkflow(item); changed.CanConvert {
		t.Fatalf("different execution policy was accepted: %+v", changed)
	}
}

// A graph run saved with a step no preset builds fails at startup with a
// public reason instead of waiting in the queue, and cannot be retried. A
// runnable graph run stays queued.
func TestStartupFailsGraphRunsWithUnrunnableSteps(t *testing.T) {
	db := openMigratedTestDB(t)
	ownerID := insertWorkflowGraphAPIUser(t, db, "workflow-unrunnable-owner")
	definitionID := insertWorkflowGraphAPIDefinition(t, db, ownerID)
	unrunnable := `{"schemaVersion":2,"nodes":[
		{"id":"discover","type":"series_catalog","displayName":"Series catalog","config":{"seriesId":"SRI0000001","maxWorks":2}},
		{"id":"fetch","type":"fetch_works","displayName":"Fetch works","config":{"maxWorks":2}}],
		"edges":[{"id":"discover_to_fetch","source":"discover","sourceHandle":"works","target":"fetch","targetHandle":"works"}],
		"policy":{"requirePreview":true}}`
	insertGraphRun := func(runID int64, jobStatus, definitionJSON string, nodes [][2]string) {
		t.Helper()
		execFetchTestStatements(t, db, `INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type, trigger_reason, input_json)
			VALUES (`+itoa64(runID)+`, `+itoa64(definitionID)+`, 'custom_fetch_test', 'Custom fetch test', 'queued', 'manual', 'workflow_preset', '{"requested_by_user_id":`+itoa64(ownerID)+`}')`)
		for position, node := range nodes {
			execFetchTestStatements(t, db, `INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, position, status)
				VALUES (`+itoa64(runID)+`, '`+node[0]+`', '`+node[1]+`', '`+node[0]+`', `+itoa64(int64(position+1))+`, '`+map[bool]string{true: "succeeded", false: "queued"}[position == 0]+`')`)
		}
		payload := mustJSON(workflowGraphJobPayload{DefinitionJSON: definitionJSON, Inputs: map[string]any{}, UserID: ownerID, Permissions: account.PermissionsForRole("admin")})
		if _, err := db.Exec(`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status, recoverable, payload_json, locked_by, checkpoint_json)
			VALUES (?, ?, 'custom_workflow', ?, 1, ?, CASE WHEN ? = 'running' THEN 'earlier-process' ELSE '' END, '{}')`,
			runID, runID, jobStatus, payload, jobStatus); err != nil {
			t.Fatal(err)
		}
	}
	insertGraphRun(1, "running", unrunnable, [][2]string{{"discover", "series_catalog"}, {"fetch", "fetch_works"}})
	insertGraphRun(2, "queued", workflowGraphAPIDefinitionJSON, [][2]string{{"discover", "series_catalog"}, {"action", "metadata_sync"}})
	server := NewServer(db, config.Config{DataRoot: t.TempDir()})

	if err := server.RecoverInterruptedWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}

	var runStatus, jobStatus, jobError string
	var recoverable bool
	if err := db.QueryRow(`SELECT run.status, job.status, job.error_message, job.recoverable FROM workflow_run AS run
		JOIN workflow_job AS job ON job.workflow_run_id = run.id WHERE run.id = 1`).Scan(&runStatus, &jobStatus, &jobError, &recoverable); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || jobStatus != "failed" || jobError != unrunnableWorkflowGraphMessage || recoverable {
		t.Fatalf("unrunnable run = %s, job = %s %q recoverable=%v", runStatus, jobStatus, jobError, recoverable)
	}
	nodes := map[string]string{}
	rows, err := db.Query(`SELECT node_id, status || ':' || error_message FROM workflow_node_run WHERE workflow_run_id = 1`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var nodeID, state string
		if err := rows.Scan(&nodeID, &state); err != nil {
			t.Fatal(err)
		}
		nodes[nodeID] = state
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	if nodes["discover"] != "succeeded:" || nodes["fetch"] != "failed:"+unrunnableWorkflowGraphMessage {
		t.Fatalf("unrunnable nodes = %v", nodes)
	}
	var runnable string
	if err := db.QueryRow(`SELECT status FROM workflow_run WHERE id = 2`).Scan(&runnable); err != nil || runnable != "queued" {
		t.Fatalf("runnable run = %q, %v; want it still queued", runnable, err)
	}
	retry := requestWorkflowRunAction(t, server.retryWorkflowRun, 1, account.User{ID: ownerID, Role: "admin", Permissions: account.PermissionsForRole("admin")})
	if retry.Code != http.StatusConflict {
		t.Fatalf("retry of the unrunnable run = %d %s, want conflict", retry.Code, retry.Body.String())
	}
}

func itoa64(value int64) string {
	return strconv.FormatInt(value, 10)
}
