package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	workflowTriggerSourceDisabledMessage = "automatically paused because its remote source is disabled"
	workflowTriggerSourceRemovedMessage  = "automatically paused because its remote source was removed"
)

type workflowTriggerQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// pauseWorkflowTriggersForSourceTx stops future dispatches while preserving the
// trigger's schedule and options. The update is part of the source mutation
// transaction so a scheduler cannot observe a disabled source with an enabled
// dependent trigger after the transaction commits.
func pauseWorkflowTriggersForSourceTx(ctx context.Context, tx *sql.Tx, sourceID int64, message string) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT trigger.id, definition.code, trigger.config_json
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.enabled = 1 AND definition.scope = 'system'
		ORDER BY trigger.id
	`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	type triggerDependency struct {
		id           int64
		workflowCode string
		configJSON   string
	}
	var triggers []triggerDependency
	for rows.Next() {
		var trigger triggerDependency
		if err := rows.Scan(&trigger.id, &trigger.workflowCode, &trigger.configJSON); err != nil {
			return err
		}
		triggers = append(triggers, trigger)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, trigger := range triggers {
		depends, err := workflowTriggerDependsOnSource(ctx, tx, trigger.workflowCode, trigger.configJSON, sourceID)
		if err != nil {
			return err
		}
		if !depends {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_trigger
			SET enabled = 0, next_run_at = NULL, last_error_message = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND enabled = 1
		`, message, trigger.id); err != nil {
			return err
		}
	}
	return nil
}

// pauseWorkflowTriggerIfSourceUnavailable is the scheduler-side race guard.
// Normal source updates pause triggers in their transaction, but this also
// handles an already-claimed trigger and older databases changed out of band.
func (s *Server) pauseWorkflowTriggerIfSourceUnavailable(ctx context.Context, trigger workflowTriggerRecord, definition workflowDefinitionRecord) (bool, error) {
	depends, err := workflowTriggerDependsOnSource(ctx, s.db, definition.Code, trigger.ConfigJSON, 0)
	if err != nil {
		return false, err
	}
	if !depends {
		return false, nil
	}
	sourceIDs, err := workflowTriggerSourceIDs(ctx, s.db, definition.Code, trigger.ConfigJSON)
	if err != nil {
		return false, err
	}
	for _, sourceID := range sourceIDs {
		var enabled bool
		err := s.db.QueryRowContext(ctx, "SELECT enabled FROM file_source WHERE id = ?", sourceID).Scan(&enabled)
		if errors.Is(err, sql.ErrNoRows) {
			if err := s.pauseWorkflowTrigger(ctx, trigger.ID, workflowTriggerSourceRemovedMessage); err != nil {
				return false, err
			}
			return true, nil
		}
		if err != nil {
			return false, err
		}
		if !enabled {
			if err := s.pauseWorkflowTrigger(ctx, trigger.ID, workflowTriggerSourceDisabledMessage); err != nil {
				return false, err
			}
			return true, nil
		}
	}
	return false, nil
}

func (s *Server) pauseWorkflowTrigger(ctx context.Context, triggerID int64, message string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET enabled = 0, next_run_at = NULL, last_error_message = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND enabled = 1
	`, message, triggerID)
	return err
}

// workflowTriggerDependsOnSource uses the stored workflow schema rather than
// matching arbitrary JSON text. sourceID == 0 asks only whether the trigger
// has any source dependency and is used by the scheduler guard.
func workflowTriggerDependsOnSource(ctx context.Context, q workflowTriggerQueryer, workflowCode, configJSON string, sourceID int64) (bool, error) {
	ids, err := workflowTriggerSourceIDs(ctx, q, workflowCode, configJSON)
	if err != nil {
		return false, err
	}
	if sourceID == 0 {
		return len(ids) > 0, nil
	}
	for _, id := range ids {
		if id == sourceID {
			return true, nil
		}
	}
	return false, nil
}

func workflowTriggerSourceIDs(ctx context.Context, q workflowTriggerQueryer, workflowCode, configJSON string) ([]int64, error) {
	appendID := func(ids []int64, id int64) []int64 {
		if id <= 0 {
			return ids
		}
		for _, existing := range ids {
			if existing == id {
				return ids
			}
		}
		return append(ids, id)
	}
	appendIDs := func(ids []int64, values []int64) []int64 {
		for _, id := range values {
			ids = appendID(ids, id)
		}
		return ids
	}

	var ids []int64
	switch workflowCode {
	case sourcePresenceCheckWorkflowCode:
		var config sourcePresenceCheckOptions
		if err := json.Unmarshal([]byte(configJSON), &config); err != nil {
			return nil, fmt.Errorf("source presence check trigger config is invalid: %w", err)
		}
		ids = appendID(ids, config.SourceID)
	case "metadata_sync":
		var config metadataSyncOptions
		if err := json.Unmarshal([]byte(configJSON), &config); err != nil {
			return nil, fmt.Errorf("metadata sync trigger config is invalid: %w", err)
		}
		ids = appendID(ids, config.SourceID)
		ids = appendIDs(ids, config.RemoteMetadataFallback.SourceIDs)
	case "remote_popular_collection":
		var config systemWorkflowTriggerConfig
		if err := json.Unmarshal([]byte(configJSON), &config); err != nil {
			return nil, fmt.Errorf("remote popular trigger config is invalid: %w", err)
		}
		ids = appendID(ids, config.SourceID)
	default:
		if _, found := presetWorkflowSpecByCode(workflowCode); found {
			var config presetWorkflowTriggerConfig
			if err := json.Unmarshal([]byte(configJSON), &config); err != nil {
				return nil, fmt.Errorf("preset trigger config is invalid: %w", err)
			}
			for _, key := range []string{"sourceIds", "checkSourceIds"} {
				if raw, ok := config.Inputs[key]; ok {
					values, ok := graphIntegerArray(raw)
					if !ok {
						return nil, fmt.Errorf("preset trigger config %s is invalid", key)
					}
					ids = appendIDs(ids, values)
				}
			}
		}
	}

	if workflowCode == "availability_watch" {
		var sourceID sql.NullInt64
		err := q.QueryRowContext(ctx, "SELECT source_id FROM availability_watch WHERE id = ?", availabilityWatchID).Scan(&sourceID)
		if errors.Is(err, sql.ErrNoRows) {
			return ids, nil
		}
		if err != nil {
			return nil, err
		}
		if sourceID.Valid {
			ids = appendID(ids, sourceID.Int64)
		}
	}
	return ids, nil
}
