package workflow

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type NodeRunSpec struct {
	NodeID      string
	NodeType    string
	DisplayName string
	Position    int
	Status      string
	Input       any
	Output      any
	Error       string
}

type JobSpec struct {
	NodeRunID       int64
	WorkerType      string
	Status          string
	Payload         any
	ProgressCurrent int
	ProgressTotal   int
	Error           string
}

func EnsureDefinition(ctx context.Context, tx *sql.Tx, code string, displayName string, description string, definition any) (int64, error) {
	definitionJSON, err := marshal(definition)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_definition (code, display_name, description, definition_json)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(code) DO UPDATE SET
			display_name = excluded.display_name,
			description = excluded.description,
			definition_json = excluded.definition_json,
			updated_at = CURRENT_TIMESTAMP
	`, code, displayName, description, definitionJSON); err != nil {
		return 0, err
	}
	return selectID(ctx, tx, "SELECT id FROM workflow_definition WHERE code = ?", code)
}

func InsertRun(ctx context.Context, tx *sql.Tx, definitionID int64, code string, displayName string, status string, triggerType string, triggerReason string, input any, summary any) (int64, error) {
	inputJSON, err := marshal(input)
	if err != nil {
		return 0, err
	}
	summaryJSON, err := marshal(summary)
	if err != nil {
		return 0, err
	}
	return insertAndID(ctx, tx, `
		INSERT INTO workflow_run (
			workflow_definition_id,
			workflow_code,
			display_name,
			status,
			trigger_type,
			trigger_reason,
			input_json,
			summary_json,
			started_at,
			finished_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)
	`, definitionID, code, displayName, status, triggerType, triggerReason, inputJSON, summaryJSON, workflowStatusFinished(status))
}

func InsertNodeRun(ctx context.Context, tx *sql.Tx, runID int64, spec NodeRunSpec) (int64, error) {
	inputJSON, err := marshal(spec.Input)
	if err != nil {
		return 0, err
	}
	outputJSON, err := marshal(spec.Output)
	if err != nil {
		return 0, err
	}
	return insertAndID(ctx, tx, `
		INSERT INTO workflow_node_run (
			workflow_run_id,
			node_id,
			node_type,
			display_name,
			position,
			status,
			input_json,
			output_json,
			error_message,
			started_at,
			finished_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)
	`, runID, spec.NodeID, spec.NodeType, spec.DisplayName, spec.Position, spec.Status, inputJSON, outputJSON, spec.Error, workflowStatusFinished(spec.Status))
}

func InsertJob(ctx context.Context, tx *sql.Tx, runID int64, spec JobSpec) (int64, error) {
	payloadJSON, err := marshal(spec.Payload)
	if err != nil {
		return 0, err
	}
	return insertAndID(ctx, tx, `
		INSERT INTO workflow_job (
			workflow_run_id,
			workflow_node_run_id,
			worker_type,
			status,
			payload_json,
			progress_current,
			progress_total,
			error_message
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, runID, spec.NodeRunID, spec.WorkerType, spec.Status, payloadJSON, spec.ProgressCurrent, spec.ProgressTotal, spec.Error)
}

func marshal(value any) (string, error) {
	if value == nil {
		return "{}", nil
	}
	bytes, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

func workflowStatusFinished(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "partial", "cancelled", "skipped":
		return true
	default:
		return false
	}
}

func insertAndID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func selectID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	var id int64
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, sql.ErrNoRows
		}
		return 0, err
	}
	return id, nil
}
