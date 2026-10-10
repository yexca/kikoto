package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
)

// A trigger can always be switched off, also after the source its options name
// was disabled. Changing or re-enabling it still needs options that can run.
func TestWorkflowTriggerCanBePausedAfterItsSourceIsDisabled(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	fixture.addRemoteSource(t, 1, true, presenceRemote(t, true).URL)
	ownerID := insertWorkflowGraphAPIUser(t, fixture.db, "synthetic-user")
	if err := fixture.server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	actor := account.User{ID: ownerID, Role: "admin", Permissions: account.PermissionsForRole("admin")}
	var definitionID int64
	if err := fixture.db.QueryRow("SELECT id FROM workflow_definition WHERE code = ?", sourcePresenceCheckWorkflowCode).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": "Check works", "triggerType": "schedule",
		"enabled": true, "scheduleJson": `{"intervalMinutes":60}`, "configJson": `{"sourceId":1}`,
	})
	create := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(string(body)))
	create = create.WithContext(context.WithValue(create.Context(), currentUserKey, actor))
	createResponse := httptest.NewRecorder()
	fixture.server.createWorkflowTrigger(createResponse, create)
	var trigger workflowTriggerRecord
	if err := json.Unmarshal(createResponse.Body.Bytes(), &trigger); err != nil || createResponse.Code != http.StatusCreated {
		t.Fatalf("create trigger = %d %s, %v", createResponse.Code, createResponse.Body.String(), err)
	}
	fixture.exec(t, `UPDATE file_source SET enabled = 0 WHERE id = 1`)

	update := func(enabled bool, displayName string) *httptest.ResponseRecorder {
		payload, _ := json.Marshal(map[string]any{
			"workflowDefinitionId": trigger.WorkflowDefinitionID, "displayName": displayName, "triggerType": trigger.TriggerType,
			"enabled": enabled, "scheduleJson": trigger.ScheduleJSON, "configJson": trigger.ConfigJSON,
		})
		request := httptest.NewRequest(http.MethodPatch, fmt.Sprintf("/api/workflow-triggers/%d", trigger.ID), strings.NewReader(string(payload)))
		request.SetPathValue("id", fmt.Sprint(trigger.ID))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
		response := httptest.NewRecorder()
		fixture.server.updateWorkflowTrigger(response, request)
		return response
	}

	if response := update(true, trigger.DisplayName); response.Code != http.StatusBadRequest {
		t.Fatalf("keeping a trigger enabled for a disabled source = %d %s, want 400", response.Code, response.Body.String())
	}
	if response := update(false, "Renamed"); response.Code != http.StatusBadRequest {
		t.Fatalf("editing a trigger for a disabled source = %d %s, want 400", response.Code, response.Body.String())
	}
	response := update(false, trigger.DisplayName)
	if response.Code != http.StatusOK {
		t.Fatalf("pausing a trigger for a disabled source = %d %s, want 200", response.Code, response.Body.String())
	}
	var enabled bool
	var nextRunAt *string
	var configJSON string
	if err := fixture.db.QueryRow("SELECT enabled, next_run_at, config_json FROM workflow_trigger WHERE id = ?", trigger.ID).Scan(&enabled, &nextRunAt, &configJSON); err != nil {
		t.Fatal(err)
	}
	if enabled || nextRunAt != nil || configJSON != trigger.ConfigJSON {
		t.Fatalf("paused trigger: enabled=%v next=%v config=%s, want off, unscheduled, options kept", enabled, nextRunAt, configJSON)
	}
}
