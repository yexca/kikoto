package httpapi

// System workflow definitions and trigger CRUD.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

var allowedScheduledTriggerTypes = map[string]bool{
	"startup":          true,
	"schedule":         true,
	"filesystem_event": true,
	"source_poll":      true,
}

func (s *Server) ensureSystemWorkflowDefinitions(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, spec := range append(append([]systemWorkflowSpec{}, systemWorkflowSpecs...), presetSystemWorkflowSpecs()...) {
		definitionJSON, err := json.Marshal(map[string]any{"nodes": spec.Nodes})
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workflow_definition (code, display_name, description, definition_json, scope, editable)
			VALUES (?, ?, ?, ?, 'system', 0)
			ON CONFLICT(code) DO UPDATE SET
				display_name = excluded.display_name,
				description = excluded.description,
				definition_json = excluded.definition_json,
				updated_at = CURRENT_TIMESTAMP
		`, spec.Code, spec.Name, spec.Description, string(definitionJSON)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type systemWorkflowSpec struct {
	Code        string
	Name        string
	Description string
	Nodes       []map[string]string
}

var systemWorkflowSpecs = []systemWorkflowSpec{
	{
		Code:        "availability_watch",
		Name:        availabilityWatchDisplayName,
		Description: "Monitor a shared pool of work codes and dispatch configured actions when a remote source becomes available.",
		Nodes: []map[string]string{
			{"id": "targets", "type": "select_works", "displayName": "Monitoring pool"},
			{"id": "metadata", "type": "sync_metadata", "displayName": "Refresh family metadata"},
			{"id": "check", "type": "check_source_availability", "displayName": "Check family availability"},
			{"id": "ready", "type": "filter_candidates", "displayName": "Ready pool"},
			{"id": "dispatch", "type": "dispatch_child_workflows", "displayName": "Dispatch configured action"},
		},
	},
	{
		Code:        "local_library_scan",
		Name:        "Scan local library",
		Description: "Discover local works and synchronize local source presence.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_local_source", "displayName": "Select local source"},
			{"id": "discover", "type": "discover_local_files", "displayName": "Discover files"},
			{"id": "match", "type": "match_works", "displayName": "Match works"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync locations"},
		},
	},
	{
		Code:        localMediaIndexWorkflowCode,
		Name:        localMediaIndexDisplayName,
		Description: localMediaIndexDescription,
		Nodes:       localMediaIndexNodes,
	},
	{
		Code:        "metadata_sync",
		Name:        "Sync work metadata",
		Description: "Select works and sync normalized metadata snapshots. This workflow can be run manually by administrators.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_works", "displayName": "Select works"},
			{"id": "sync", "type": "sync_metadata", "displayName": "Sync metadata"},
		},
	},
	{
		Code:        genreNameWorkflowCode,
		Name:        genreNameDisplayName,
		Description: genreNameDescription,
		Nodes:       genreNameNodes,
	},
	{
		Code:        "remote_source_sync",
		Name:        "Sync remote source",
		Description: "Fetch remote work metadata and file locations when a source work is fetched or marked.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote source"},
			{"id": "discover", "type": "discover_remote_works", "displayName": "Discover remote work"},
			{"id": "filter", "type": "filter_candidates", "displayName": "Filter candidates"},
			{"id": "match", "type": "match_works", "displayName": "Match work"},
			{"id": "metadata", "type": "sync_metadata", "displayName": "Sync metadata"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync remote locations"},
		},
	},
	{
		Code:        "remote_popular_collection",
		Name:        "Collect popular remote works",
		Description: "Discover popular works from a selected compatible source, track or fetch them, and append a user tag.",
		Nodes: []map[string]string{
			{"id": "configure", "type": "select_remote_source", "displayName": "Configure remote collection"},
			{"id": "discover", "type": "discover_remote_collection", "displayName": "Discover popular works"},
			{"id": "filter", "type": "filter_candidates", "displayName": "Filter collection candidates"},
			{"id": "dispatch", "type": "dispatch_child_workflows", "displayName": "Dispatch accepted works"},
			{"id": "tag", "type": "assign_user_tags", "displayName": "Add user tag"},
		},
	},
	{
		Code:        "dlsite_popular_collection",
		Name:        "Collect DLsite popular voice works",
		Description: "Discover a DLsite voice ranking, synchronize work metadata, and append a run tag for the current user.",
		Nodes: []map[string]string{
			{"id": "configure", "type": "select_ranking", "displayName": "Configure ranking"},
			{"id": "discover", "type": "discover_provider_ranking", "displayName": "Discover ranking"},
			{"id": "metadata", "type": "sync_metadata", "displayName": "Sync metadata"},
			{"id": "tag", "type": "assign_user_tags", "displayName": "Add user tag"},
		},
	},
	{
		Code:        "media_cache",
		Name:        "Cache media",
		Description: "Cache remote media while playing when remote cache is enabled. Triggered by playback.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_media_items", "displayName": "Select media item"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync remote location"},
			{"id": "filter", "type": "filter_candidates", "displayName": "Filter cache miss"},
			{"id": "cache", "type": "materialize_cache", "displayName": "Materialize cache file"},
		},
	},
	{
		Code:        "media_cache_cleanup",
		Name:        "Clean media cache",
		Description: "Delete cached media files and mark cache locations unavailable.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_media_items", "displayName": "Select cached media"},
			{"id": "cleanup", "type": "cleanup_cache", "displayName": "Delete cache file"},
		},
	},
	{
		Code:        "media_location_cleanup",
		Name:        "Clean media locations",
		Description: "Delete selected cache or local files and mark their locations unavailable.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_media_items", "displayName": "Select media locations"},
			{"id": "cleanup", "type": "cleanup_media_locations", "displayName": "Delete media files"},
		},
	},
	{
		Code:        "media_cleanup_forget_work",
		Name:        "Delete media and forget work",
		Description: "Delete selected files, then remove an unlinked logical work family and its personal state.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_media_items", "displayName": "Select media locations"},
			{"id": "cleanup", "type": "cleanup_media_locations", "displayName": "Delete media files"},
			{"id": "forget", "type": "forget_unlinked_work", "displayName": "Forget unlinked work"},
		},
	},
	{
		Code:        "remote_work_fetch",
		Name:        "Fetch remote work",
		Description: "Fetch selected remote files into the local library through cache-backed staging and verified publication.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote source"},
			{"id": "tree", "type": "fetch_remote_tree", "displayName": "Fetch remote tree"},
			{"id": "plan", "type": "plan_save", "displayName": "Plan save"},
			{"id": "cache", "type": "materialize_cache", "displayName": "Cache selected files"},
			{"id": "stage", "type": "stage_fetch_result", "displayName": "Assemble staging directory"},
			{"id": "verify", "type": "verify_files", "displayName": "Verify files"},
			{"id": "promote", "type": "publish_staged_fetch", "displayName": "Publish staged result"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync local locations"},
			{"id": "cleanup", "type": "cleanup_cache", "displayName": "Remove promoted cache files"},
		},
	},
	{
		Code:        "source_availability_check",
		Name:        "Check source availability",
		Description: "Check which configured remote sources can provide a work and record source-level results.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote sources"},
			{"id": "discover", "type": "discover_remote_works", "displayName": "Discover remote works"},
			{"id": "filter", "type": "filter_candidates", "displayName": "Filter available sources"},
			{"id": "match", "type": "match_works", "displayName": "Match local and cached availability"},
		},
	},
	{
		Code:        "unlinked_work_source_check",
		Name:        "Check unlinked work sources",
		Description: "Check configured remote sources for selected database works that have no currently available source.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_works", "displayName": "Select unlinked works"},
			{"id": "check", "type": "check_source_availability", "displayName": "Check source availability"},
		},
	},
	{
		Code:        sourcePresenceCheckWorkflowCode,
		Name:        sourcePresenceCheckDisplayName,
		Description: sourcePresenceCheckDescription,
		Nodes:       sourcePresenceCheckNodes,
	},
}

func (s *Server) createWorkflowTrigger(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
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
	definition, err := s.loadWorkflowDefinition(r.Context(), payload.WorkflowDefinitionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workflow definition not found"})
			return
		}
		writeError(w, err)
		return
	}
	if !canUseWorkflowDefinition(actor, definition) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "workflow definition belongs to another user"})
		return
	}
	if err := s.ensureAvailabilityWatchSchedule(r.Context(), definition, 0, payload.TriggerType); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err := s.ensureUniqueWorkflowStartupTrigger(r.Context(), payload.WorkflowDefinitionID, 0, payload.TriggerType); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	prepared, err := s.prepareWorkflowTrigger(r.Context(), actor, definition, payload, time.Now().UTC(), nil)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	enabled := true
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	id, err := sqlutil.InsertID(r.Context(), s.db, `
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
	`, payload.WorkflowDefinitionID, payload.TriggerType, payload.DisplayName, enabled, payload.ScheduleJSON, prepared.ConfigJSON, prepared.NextRunAt)
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
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow trigger id"})
		return
	}
	current, currentDefinition, err := s.loadWorkflowTriggerUpdateContext(r.Context(), actor, id)
	if err != nil {
		writeWorkflowTriggerUpdateError(w, err)
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
	current, prepared, enabled, err := s.prepareWorkflowTriggerUpdate(r.Context(), actor, id, current, currentDefinition, payload)
	if err != nil {
		writeWorkflowTriggerUpdateError(w, err)
		return
	}
	if err := s.persistWorkflowTriggerUpdate(r.Context(), id, current, payload, prepared, enabled); err != nil {
		writeWorkflowTriggerUpdateError(w, err)
		return
	}
	trigger, err := s.loadWorkflowTrigger(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, trigger)
}

type workflowTriggerUpdateHTTPError struct {
	status  int
	message string
}

func (err *workflowTriggerUpdateHTTPError) Error() string { return err.message }

func writeWorkflowTriggerUpdateError(w http.ResponseWriter, err error) {
	var httpErr *workflowTriggerUpdateHTTPError
	if errors.As(err, &httpErr) {
		writeJSON(w, httpErr.status, map[string]string{"error": httpErr.message})
		return
	}
	writeError(w, err)
}

func workflowTriggerUpdateHTTPErrorf(status int, format string, args ...any) error {
	return &workflowTriggerUpdateHTTPError{status: status, message: fmt.Sprintf(format, args...)}
}

func (s *Server) loadWorkflowTriggerUpdateContext(ctx context.Context, actor currentUser, id int64) (workflowTriggerRecord, workflowDefinitionRecord, error) {
	current, err := s.loadWorkflowTrigger(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowTriggerRecord{}, workflowDefinitionRecord{}, workflowTriggerUpdateHTTPErrorf(http.StatusNotFound, "workflow trigger not found")
		}
		return workflowTriggerRecord{}, workflowDefinitionRecord{}, err
	}
	currentDefinition, err := s.loadWorkflowDefinition(ctx, current.WorkflowDefinitionID)
	if err != nil {
		return workflowTriggerRecord{}, workflowDefinitionRecord{}, err
	}
	if !canUseWorkflowDefinition(actor, currentDefinition) {
		return workflowTriggerRecord{}, workflowDefinitionRecord{}, workflowTriggerUpdateHTTPErrorf(http.StatusForbidden, "workflow trigger belongs to another user")
	}
	if missing := missingWorkflowGraphPermission(actor.Permissions, s.storedWorkflowTriggerPermissions(ctx, currentDefinition, current)); missing != "" {
		return workflowTriggerRecord{}, workflowDefinitionRecord{}, workflowTriggerUpdateHTTPErrorf(http.StatusForbidden, "permission denied")
	}
	return current, currentDefinition, nil
}

func (s *Server) prepareWorkflowTriggerUpdate(ctx context.Context, actor currentUser, id int64, current workflowTriggerRecord, currentDefinition workflowDefinitionRecord, payload workflowTriggerPayload) (workflowTriggerRecord, preparedWorkflowTrigger, bool, error) {
	if current.TriggerType == "filesystem_event" && !isFixedFilesystemTriggerUpdate(currentDefinition, current, payload) {
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusConflict, "the local library filesystem trigger only supports pause and scan-mode changes")
	}
	// Pausing only stops future runs, so it never depends on whether the
	// trigger's options could still run: a trigger whose source was disabled
	// or removed can always be switched off.
	if isWorkflowTriggerPause(current, payload) {
		return current, preparedWorkflowTrigger{ConfigJSON: current.ConfigJSON}, false, nil
	}
	definition, err := s.loadWorkflowDefinition(ctx, payload.WorkflowDefinitionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusBadRequest, "workflow definition not found")
		}
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, err
	}
	if !canUseWorkflowDefinition(actor, definition) {
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusForbidden, "workflow definition belongs to another user")
	}
	if err := s.ensureAvailabilityWatchSchedule(ctx, definition, id, payload.TriggerType); err != nil {
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusConflict, "%s", err)
	}
	if payload.TriggerType == "filesystem_event" && current.TriggerType != "filesystem_event" {
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusConflict, "filesystem watching is a fixed trigger for the local library scan")
	}
	if err := s.ensureUniqueWorkflowStartupTrigger(ctx, payload.WorkflowDefinitionID, id, payload.TriggerType); err != nil {
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusConflict, "%s", err)
	}
	prepared, err := s.prepareWorkflowTrigger(ctx, actor, definition, payload, time.Now().UTC(), &current)
	if err != nil {
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusBadRequest, "%s", err)
	}
	enabled := payload.Enabled == nil || *payload.Enabled
	return current, prepared, enabled, nil
}

// isWorkflowTriggerPause reports whether the update switches the trigger off
// and changes nothing else about it.
func isWorkflowTriggerPause(current workflowTriggerRecord, payload workflowTriggerPayload) bool {
	return payload.Enabled != nil && !*payload.Enabled &&
		payload.WorkflowDefinitionID == current.WorkflowDefinitionID &&
		payload.TriggerType == current.TriggerType &&
		payload.DisplayName == strings.TrimSpace(current.DisplayName) &&
		sameJSONDocument(payload.ScheduleJSON, current.ScheduleJSON) &&
		sameJSONDocument(payload.ConfigJSON, current.ConfigJSON)
}

// sameJSONDocument compares two JSON documents by value, so formatting and key
// order do not make equal documents differ. An empty document is "{}".
func sameJSONDocument(left string, right string) bool {
	decode := func(raw string) (any, bool) {
		if strings.TrimSpace(raw) == "" {
			raw = "{}"
		}
		var value any
		if err := json.Unmarshal([]byte(raw), &value); err != nil {
			return nil, false
		}
		return value, true
	}
	leftValue, leftOK := decode(left)
	rightValue, rightOK := decode(right)
	return leftOK && rightOK && reflect.DeepEqual(leftValue, rightValue)
}

func isFixedFilesystemTriggerUpdate(definition workflowDefinitionRecord, current workflowTriggerRecord, payload workflowTriggerPayload) bool {
	return definition.Code == "local_library_scan" && payload.WorkflowDefinitionID == current.WorkflowDefinitionID &&
		payload.TriggerType == current.TriggerType && payload.DisplayName == current.DisplayName &&
		payload.ScheduleJSON == current.ScheduleJSON
}

func (s *Server) persistWorkflowTriggerUpdate(ctx context.Context, id int64, current workflowTriggerRecord, payload workflowTriggerPayload, prepared preparedWorkflowTrigger, enabled bool) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET workflow_definition_id = ?, trigger_type = ?, display_name = ?, enabled = ?,
			schedule_json = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP,
			-- A reconfigured trigger no longer reports the error of its old options.
			last_error_message = CASE WHEN config_json = ? THEN last_error_message ELSE '' END,
			config_json = ?
		WHERE id = ?
	`, payload.WorkflowDefinitionID, payload.TriggerType, payload.DisplayName, enabled, payload.ScheduleJSON, prepared.NextRunAt, prepared.ConfigJSON, prepared.ConfigJSON, id)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows == 0 {
		return workflowTriggerUpdateHTTPErrorf(http.StatusNotFound, "workflow trigger not found")
	}
	if current.TriggerType == "filesystem_event" && !enabled {
		if _, err := s.db.ExecContext(ctx, `
			UPDATE filesystem_trigger_state
			SET last_event_at = NULL, updated_at = CURRENT_TIMESTAMP
			WHERE trigger_id = ?
		`, id); err != nil {
			return err
		}
	}
	if current.TriggerType == "filesystem_event" {
		s.notifyFilesystemTriggerConfigChanged()
	}
	return nil
}

func (s *Server) deleteWorkflowTrigger(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow trigger id"})
		return
	}
	current, err := s.loadWorkflowTrigger(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow trigger not found"})
			return
		}
		writeError(w, err)
		return
	}
	definition, err := s.loadWorkflowDefinition(r.Context(), current.WorkflowDefinitionID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !canUseWorkflowDefinition(actor, definition) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "workflow trigger belongs to another user"})
		return
	}
	if missing := missingWorkflowGraphPermission(actor.Permissions, s.storedWorkflowTriggerPermissions(r.Context(), definition, current)); missing != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	if current.TriggerType == "filesystem_event" && definition.Code == "local_library_scan" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "the local library filesystem trigger cannot be deleted"})
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
