package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

var workflowCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

var allowedWorkflowNodeTypes = map[string]bool{
	"select_local_source":   true,
	"discover_local_files":  true,
	"select_remote_source":  true,
	"discover_remote_works": true,
	"select_works":          true,
	"select_media_items":    true,
	"filter_candidates":     true,
	"match_works":           true,
	"sync_file_locations":   true,
	"sync_metadata":         true,
	"materialize_cache":     true,
	"materialize_save":      true,
}

var allowedScheduledTriggerTypes = map[string]bool{
	"startup":          true,
	"schedule":         true,
	"filesystem_event": true,
	"source_poll":      true,
}

type workflowDefinitionPayload struct {
	Code           string `json:"code"`
	DisplayName    string `json:"displayName"`
	Description    string `json:"description"`
	DefinitionJSON string `json:"definitionJson"`
}

type workflowTriggerPayload struct {
	WorkflowDefinitionID int64   `json:"workflowDefinitionId"`
	DisplayName          string  `json:"displayName"`
	TriggerType          string  `json:"triggerType"`
	Enabled              *bool   `json:"enabled"`
	ScheduleJSON         string  `json:"scheduleJson"`
	ConfigJSON           string  `json:"configJson"`
	NextRunAt            *string `json:"nextRunAt"`
}

func (s *Server) createWorkflowDefinition(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	payload, ok := decodeWorkflowDefinitionPayload(w, r)
	if !ok {
		return
	}
	if err := validateWorkflowDefinitionPayload(payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	id, err := insertAndID(r.Context(), tx, `
		INSERT INTO workflow_definition (
			code,
			display_name,
			description,
			definition_json,
			scope,
			editable,
			owner_user_id,
			created_by_user_id
		)
		VALUES (?, ?, ?, ?, 'user', 1, ?, ?)
	`, payload.Code, payload.DisplayName, payload.Description, payload.DefinitionJSON, actor.ID, actor.ID)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "workflow code already exists"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	definition, err := s.loadWorkflowDefinition(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, definition)
}

func (s *Server) updateWorkflowDefinition(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow definition id"})
		return
	}
	current, err := s.loadWorkflowDefinition(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow definition not found"})
			return
		}
		writeError(w, err)
		return
	}
	if !current.Editable {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "system workflow definitions cannot be edited"})
		return
	}

	payload, ok := decodeWorkflowDefinitionPayload(w, r)
	if !ok {
		return
	}
	payload.Code = current.Code
	if err := validateWorkflowDefinitionPayload(payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	if _, err := s.db.ExecContext(r.Context(), `
		UPDATE workflow_definition
		SET display_name = ?, description = ?, definition_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND editable = 1
	`, payload.DisplayName, payload.Description, payload.DefinitionJSON, id); err != nil {
		writeError(w, err)
		return
	}
	definition, err := s.loadWorkflowDefinition(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, definition)
}

func (s *Server) deleteWorkflowDefinition(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow definition id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM workflow_definition WHERE id = ? AND editable = 1", id)
	if err != nil {
		writeError(w, err)
		return
	}
	rows, err := result.RowsAffected()
	if err != nil {
		writeError(w, err)
		return
	}
	if rows == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "editable workflow definition not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) createWorkflowTrigger(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	payload, ok := decodeWorkflowTriggerPayload(w, r)
	if !ok {
		return
	}
	if err := validateWorkflowTriggerPayload(payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if _, err := s.loadWorkflowDefinition(r.Context(), payload.WorkflowDefinitionID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workflow definition not found"})
			return
		}
		writeError(w, err)
		return
	}
	enabled := true
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	nextRunAt := normalizeOptionalString(payload.NextRunAt)
	id, err := insertAndIDNoTx(r.Context(), s.db, `
		INSERT INTO workflow_trigger (
			workflow_definition_id,
			trigger_type,
			display_name,
			enabled,
			schedule_json,
			config_json,
			next_run_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, payload.WorkflowDefinitionID, payload.TriggerType, payload.DisplayName, enabled, payload.ScheduleJSON, payload.ConfigJSON, nextRunAt)
	if err != nil {
		writeError(w, err)
		return
	}
	trigger, err := s.loadWorkflowTrigger(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, trigger)
}

func (s *Server) updateWorkflowTrigger(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow trigger id"})
		return
	}
	payload, ok := decodeWorkflowTriggerPayload(w, r)
	if !ok {
		return
	}
	if err := validateWorkflowTriggerPayload(payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if _, err := s.loadWorkflowDefinition(r.Context(), payload.WorkflowDefinitionID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workflow definition not found"})
			return
		}
		writeError(w, err)
		return
	}
	enabled := true
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	nextRunAt := normalizeOptionalString(payload.NextRunAt)
	result, err := s.db.ExecContext(r.Context(), `
		UPDATE workflow_trigger
		SET workflow_definition_id = ?,
			trigger_type = ?,
			display_name = ?,
			enabled = ?,
			schedule_json = ?,
			config_json = ?,
			next_run_at = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, payload.WorkflowDefinitionID, payload.TriggerType, payload.DisplayName, enabled, payload.ScheduleJSON, payload.ConfigJSON, nextRunAt, id)
	if err != nil {
		writeError(w, err)
		return
	}
	rows, err := result.RowsAffected()
	if err != nil {
		writeError(w, err)
		return
	}
	if rows == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow trigger not found"})
		return
	}
	trigger, err := s.loadWorkflowTrigger(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, trigger)
}

func (s *Server) deleteWorkflowTrigger(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow trigger id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM workflow_trigger WHERE id = ?", id)
	if err != nil {
		writeError(w, err)
		return
	}
	rows, err := result.RowsAffected()
	if err != nil {
		writeError(w, err)
		return
	}
	if rows == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow trigger not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func decodeWorkflowDefinitionPayload(w http.ResponseWriter, r *http.Request) (workflowDefinitionPayload, bool) {
	var payload workflowDefinitionPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return payload, false
	}
	payload.Code = strings.TrimSpace(payload.Code)
	payload.DisplayName = strings.TrimSpace(payload.DisplayName)
	payload.Description = strings.TrimSpace(payload.Description)
	payload.DefinitionJSON = strings.TrimSpace(payload.DefinitionJSON)
	return payload, true
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

func validateWorkflowDefinitionPayload(payload workflowDefinitionPayload) error {
	if !workflowCodePattern.MatchString(payload.Code) {
		return fmt.Errorf("workflow code must be lowercase snake_case and 3-64 characters")
	}
	if payload.DisplayName == "" {
		return fmt.Errorf("display name is required")
	}
	if payload.DefinitionJSON == "" {
		return fmt.Errorf("definition JSON is required")
	}
	var definition struct {
		Nodes []struct {
			ID          string `json:"id"`
			Type        string `json:"type"`
			DisplayName string `json:"displayName"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal([]byte(payload.DefinitionJSON), &definition); err != nil {
		return fmt.Errorf("definition JSON is invalid")
	}
	if len(definition.Nodes) == 0 {
		return fmt.Errorf("workflow needs at least one node")
	}
	seen := map[string]bool{}
	for _, node := range definition.Nodes {
		nodeID := strings.TrimSpace(node.ID)
		nodeType := strings.TrimSpace(node.Type)
		if nodeID == "" {
			return fmt.Errorf("node id is required")
		}
		if seen[nodeID] {
			return fmt.Errorf("node id must be unique")
		}
		seen[nodeID] = true
		if !allowedWorkflowNodeTypes[nodeType] {
			return fmt.Errorf("unsupported node type: %s", nodeType)
		}
	}
	return nil
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

func (s *Server) loadWorkflowDefinition(ctx context.Context, id int64) (workflowDefinitionRecord, error) {
	var item workflowDefinitionRecord
	var ownerUserID sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT
			id,
			code,
			display_name,
			description,
			definition_json,
			scope,
			editable,
			owner_user_id,
			(
				SELECT COUNT(*)
				FROM workflow_trigger
				WHERE workflow_trigger.workflow_definition_id = workflow_definition.id
			),
			created_at,
			updated_at
		FROM workflow_definition
		WHERE id = ?
	`, id).Scan(
		&item.ID,
		&item.Code,
		&item.DisplayName,
		&item.Description,
		&item.DefinitionJSON,
		&item.Scope,
		&item.Editable,
		&ownerUserID,
		&item.TriggerCount,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	item.OwnerUserID = nullableInt64(ownerUserID)
	return item, err
}

func (s *Server) loadWorkflowTrigger(ctx context.Context, id int64) (workflowTriggerRecord, error) {
	var item workflowTriggerRecord
	var nextRunAt sql.NullString
	var lastRunAt sql.NullString
	var lastSuccessAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT
			trigger.id,
			trigger.workflow_definition_id,
			definition.code,
			trigger.display_name,
			trigger.trigger_type,
			trigger.enabled,
			trigger.schedule_json,
			trigger.config_json,
			trigger.next_run_at,
			trigger.last_run_at,
			trigger.last_success_at,
			trigger.last_error_message,
			trigger.created_at,
			trigger.updated_at
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.id = ?
	`, id).Scan(
		&item.ID,
		&item.WorkflowDefinitionID,
		&item.WorkflowCode,
		&item.DisplayName,
		&item.TriggerType,
		&item.Enabled,
		&item.ScheduleJSON,
		&item.ConfigJSON,
		&nextRunAt,
		&lastRunAt,
		&lastSuccessAt,
		&item.LastErrorMessage,
		&item.CreatedAt,
		&item.UpdatedAt,
	)
	item.NextRunAt = nullableString(nextRunAt)
	item.LastRunAt = nullableString(lastRunAt)
	item.LastSuccessAt = nullableString(lastSuccessAt)
	return item, err
}

func insertAndIDNoTx(ctx context.Context, db *sql.DB, query string, args ...any) (int64, error) {
	result, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
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
