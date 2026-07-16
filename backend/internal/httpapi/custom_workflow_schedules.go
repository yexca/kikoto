package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const (
	minimumCustomWorkflowIntervalMinutes = 5
	maximumCustomWorkflowIntervalMinutes = 7 * 24 * 60
)

type customWorkflowSchedule struct {
	IntervalMinutes int `json:"intervalMinutes"`
}

type customWorkflowScheduleConfig struct {
	Inputs map[string]any `json:"inputs"`
}

func (s *Server) prepareWorkflowTrigger(ctx context.Context, actor currentUser, definition workflowDefinitionRecord, payload workflowTriggerPayload, now time.Time) (any, error) {
	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if json.Unmarshal([]byte(definition.DefinitionJSON), &probe) != nil || probe.SchemaVersion != customWorkflowSchemaVersion {
		return normalizeOptionalString(payload.NextRunAt), nil
	}
	if definition.Scope != "user" || !definition.Editable {
		return nil, fmt.Errorf("scheduled DAG must be an editable user workflow")
	}
	if payload.TriggerType != "schedule" {
		return nil, fmt.Errorf("custom workflow DAGs support interval schedules only")
	}
	graph, schedule, _, err := validateCustomWorkflowSchedule(definition, payload.ScheduleJSON, payload.ConfigJSON)
	if err != nil {
		return nil, err
	}
	if missing := missingCustomWorkflowPermission(actor.Permissions, customWorkflowRequiredPermissions(graph)); missing != "" {
		return nil, fmt.Errorf("scheduled workflow requires permission %s", missing)
	}
	return formatWorkflowTimestamp(now.Add(time.Duration(schedule.IntervalMinutes) * time.Minute)), nil
}

func validateCustomWorkflowSchedule(definition workflowDefinitionRecord, scheduleJSON, configJSON string) (customWorkflowGraph, customWorkflowSchedule, map[string]any, error) {
	graph, err := validateCustomWorkflowDefinition(definition.DefinitionJSON)
	if err != nil {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, err
	}
	if customWorkflowRequiresPreview(graph.Definition) {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, fmt.Errorf("scheduled workflows must disable interactive preview")
	}
	var schedule customWorkflowSchedule
	if err := decodeStrictJSON(scheduleJSON, &schedule); err != nil {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, fmt.Errorf("schedule JSON must contain intervalMinutes")
	}
	if schedule.IntervalMinutes < minimumCustomWorkflowIntervalMinutes || schedule.IntervalMinutes > maximumCustomWorkflowIntervalMinutes {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, fmt.Errorf("intervalMinutes must be between %d and %d", minimumCustomWorkflowIntervalMinutes, maximumCustomWorkflowIntervalMinutes)
	}
	config := customWorkflowScheduleConfig{Inputs: map[string]any{}}
	if err := decodeStrictJSON(configJSON, &config); err != nil {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, fmt.Errorf("config JSON must contain only workflow inputs")
	}
	inputs, err := normalizeCustomWorkflowInputs(graph.Definition.Inputs, config.Inputs)
	if err != nil {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, err
	}
	return graph, schedule, inputs, nil
}

func (s *Server) validateWorkflowDefinitionTriggerUpdate(ctx context.Context, definition workflowDefinitionRecord, definitionJSON string) error {
	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if json.Unmarshal([]byte(definitionJSON), &probe) != nil || probe.SchemaVersion != customWorkflowSchemaVersion {
		return nil
	}
	definition.DefinitionJSON = definitionJSON
	rows, err := s.db.QueryContext(ctx, `
		SELECT trigger_type, schedule_json, config_json
		FROM workflow_trigger WHERE workflow_definition_id = ? ORDER BY id
	`, definition.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var triggerType, scheduleJSON, configJSON string
		if err := rows.Scan(&triggerType, &scheduleJSON, &configJSON); err != nil {
			return err
		}
		if triggerType != "schedule" {
			return fmt.Errorf("remove unsupported %s triggers before upgrading this workflow", triggerType)
		}
		if _, _, _, err := validateCustomWorkflowSchedule(definition, scheduleJSON, configJSON); err != nil {
			return fmt.Errorf("existing schedule is incompatible with this workflow: %w", err)
		}
	}
	return rows.Err()
}

func decodeStrictJSON(raw string, target any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("unexpected trailing JSON")
	}
	return nil
}

func (s *Server) dispatchDueCustomWorkflowTrigger(ctx context.Context) error {
	var triggerID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT trigger.id
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.enabled = 1
			AND trigger.trigger_type = 'schedule'
			AND trigger.next_run_at IS NOT NULL
			AND trigger.next_run_at <= CURRENT_TIMESTAMP
			AND definition.scope = 'user'
			AND json_extract(definition.definition_json, '$.schemaVersion') = ?
		ORDER BY trigger.next_run_at ASC, trigger.id ASC
		LIMIT 1
	`, customWorkflowSchemaVersion).Scan(&triggerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	trigger, err := s.loadWorkflowTrigger(ctx, triggerID)
	if err != nil {
		return err
	}
	definition, err := s.loadWorkflowDefinition(ctx, trigger.WorkflowDefinitionID)
	if err != nil {
		return err
	}
	if definition.OwnerUserID == nil {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "scheduled workflow owner is unavailable")
	}
	owner, err := s.accountStore.LoadByID(ctx, *definition.OwnerUserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "scheduled workflow owner is unavailable")
		}
		return err
	}
	graph, schedule, inputs, err := validateCustomWorkflowSchedule(definition, trigger.ScheduleJSON, trigger.ConfigJSON)
	if err != nil {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, err.Error())
	}
	if missing := missingCustomWorkflowPermission(owner.Permissions, customWorkflowRequiredPermissions(graph)); missing != "" {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "scheduled workflow owner no longer has required permissions")
	}
	now := time.Now().UTC()
	nextRunAt := formatWorkflowTimestamp(now.Add(time.Duration(schedule.IntervalMinutes) * time.Minute))
	var active int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_run WHERE trigger_id = ? AND status IN ('queued', 'running')", trigger.ID).Scan(&active); err != nil {
		return err
	}
	if active > 0 {
		_, err := s.db.ExecContext(ctx, "UPDATE workflow_trigger SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", nextRunAt, trigger.ID)
		return err
	}
	claim, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= CURRENT_TIMESTAMP
	`, nextRunAt, trigger.ID)
	if err != nil {
		return err
	}
	claimed, err := claim.RowsAffected()
	if err != nil || claimed == 0 {
		return err
	}
	_, err = s.enqueueCustomWorkflow(ctx, definition, graph, owner.ID, owner.Permissions, inputs, "", customWorkflowEnqueueOptions{
		TriggerID: trigger.ID, TriggerType: "schedule", TriggerReason: "scheduled_interval", DefinitionStack: []int64{definition.ID},
	})
	if err != nil {
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", "scheduled workflow could not be queued", trigger.ID)
		return err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_run_at = ?, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", formatWorkflowTimestamp(now), trigger.ID)
	return err
}

func (s *Server) disableInvalidCustomWorkflowTrigger(ctx context.Context, triggerID int64, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "scheduled workflow configuration is invalid"
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger SET enabled = 0, next_run_at = NULL, last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`, message, triggerID)
	return err
}

func formatWorkflowTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02 15:04:05")
}

func updateCustomWorkflowTriggerSuccess(ctx context.Context, tx *sql.Tx, runID int64) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET last_success_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
	`, runID)
	return err
}

func updateCustomWorkflowTriggerFailure(ctx context.Context, tx *sql.Tx, runID int64, message string) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
	`, message, runID)
	return err
}
