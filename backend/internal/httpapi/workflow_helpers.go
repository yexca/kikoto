package httpapi

// Shared workflow persistence and payload helpers.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

func (s *Server) loadWorkflowRun(ctx context.Context, id int64) (workflowRunRecord, error) {
	return s.workflowStore.LoadRun(ctx, id)
}

func (s *Server) loadWorkflowRunTx(ctx context.Context, tx *sql.Tx, id int64) (workflowRunRecord, error) {
	return s.workflowStore.LoadRunTx(ctx, tx, id)
}

func (s *Server) recordWorkflowRunEvent(ctx context.Context, runID int64, level string, eventType string, message string, detail any) error {
	return s.workflowStore.RecordEvent(ctx, runID, level, eventType, message, detail)
}

func decodeWorkflowTriggerPayload(w http.ResponseWriter, r *http.Request) (workflowTriggerPayload, bool) {
	var payload workflowTriggerPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return payload, false
	}
	payload.DisplayName = strings.TrimSpace(payload.DisplayName)
	payload.TriggerType = strings.TrimSpace(payload.TriggerType)
	payload.ScheduleJSON = strings.TrimSpace(payload.ScheduleJSON)
	payload.ConfigJSON = strings.TrimSpace(payload.ConfigJSON)
	if payload.ScheduleJSON == "" {
		payload.ScheduleJSON = "{}"
	}
	if payload.ConfigJSON == "" {
		payload.ConfigJSON = "{}"
	}
	return payload, true
}

func validateWorkflowTriggerPayload(payload workflowTriggerPayload) error {
	if payload.WorkflowDefinitionID <= 0 {
		return fmt.Errorf("workflow definition is required")
	}
	if payload.DisplayName == "" {
		return fmt.Errorf("display name is required")
	}
	if !allowedScheduledTriggerTypes[payload.TriggerType] {
		return fmt.Errorf("unsupported trigger type")
	}
	if !json.Valid([]byte(payload.ScheduleJSON)) {
		return fmt.Errorf("schedule JSON is invalid")
	}
	if !json.Valid([]byte(payload.ConfigJSON)) {
		return fmt.Errorf("config JSON is invalid")
	}
	return nil
}

func (s *Server) ensureUniqueWorkflowStartupTrigger(ctx context.Context, definitionID, excludeTriggerID int64, triggerType string) error {
	if triggerType != "startup" {
		return nil
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM workflow_trigger
		WHERE workflow_definition_id = ? AND trigger_type = 'startup' AND id != ?
	`, definitionID, excludeTriggerID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return fmt.Errorf("workflow already has a startup trigger")
	}
	return nil
}

func allowedCandidateReviewStatus(status string) bool {
	switch status {
	case "accepted", "rejected", "ignored", "resolved":
		return true
	default:
		return false
	}
}

func nullableInt64Value(value sql.NullInt64) int64 {
	if !value.Valid {
		return 0
	}
	return value.Int64
}

func (s *Server) loadWorkflowDefinition(ctx context.Context, id int64) (workflowDefinitionRecord, error) {
	return s.workflowStore.LoadDefinition(ctx, id)
}

func (s *Server) loadWorkflowTrigger(ctx context.Context, id int64) (workflowTriggerRecord, error) {
	return s.workflowStore.LoadTrigger(ctx, id)
}

func normalizeOptionalString(value *string) any {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func mergeJSONObjects(raw string, patch map[string]any) map[string]any {
	result := map[string]any{}
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &result)
	}
	for key, value := range patch {
		result[key] = value
	}
	return result
}

// manualRecoveryIdleRunGrace keeps manual recovery away from a run whose job
// changed moments ago and may still be finishing its own result.
const manualRecoveryIdleRunGrace = time.Minute

// settleInterruptedWorkflowRuns runs at startup, before any executor holds a
// lease, so every running job was left by an earlier process.
func (s *Server) settleInterruptedWorkflowRuns(ctx context.Context, reason string) (workflow.OrphanSweepResult, error) {
	return s.workflowStore.SettleOrphans(ctx, workflow.OrphanSweep{Reason: reason, SettleIdleRuns: true, CanViewAll: true})
}
