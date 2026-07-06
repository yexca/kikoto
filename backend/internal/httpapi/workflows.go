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

	"github.com/yexca/kikoto/backend/internal/workflow"
)

var workflowCodePattern = regexp.MustCompile(`^[a-z][a-z0-9_]{2,63}$`)

var workflowNodeTypeRegistry = []workflowNodeTypeRecord{
	nodeType("select_local_source", "target", "Select local source", "Choose a configured local folder source.", true, schemaObject("sourceId", "scanDepth"), schemaObject(), schemaObject("sourceId", "path")),
	nodeType("select_remote_source", "target", "Select remote source", "Choose one or more configured remote sources.", true, schemaObject("sourceId", "sourceIds"), schemaObject(), schemaObject("sourceIds")),
	nodeType("select_works", "target", "Select works", "Choose known works for a workflow run.", true, schemaObject("workIds", "codes", "scope"), schemaObject(), schemaObject("workIds", "codes")),
	nodeType("select_media_items", "target", "Select media items", "Choose media items or file locations.", true, schemaObject("mediaItemIds", "locationIds", "locationType"), schemaObject(), schemaObject("mediaItemIds", "locationIds")),
	nodeType("select_remote_works", "target", "Select remote works", "Choose multiple remote works for a bulk action.", false, schemaObject("sourceId", "codes", "action"), schemaObject(), schemaObject("sourceId", "codes")),
	nodeType("select_party", "target", "Select circle", "Choose a circle or party catalog target.", false, schemaObject("externalId", "provider"), schemaObject(), schemaObject("partyId", "externalId")),

	nodeType("discover_local_files", "discover", "Discover local files", "Scan local folders and detect work files.", true, schemaObject("includeExisting", "markMissing"), schemaObject("sourceId", "path"), schemaObject("files", "detectedWorks")),
	nodeType("discover_remote_works", "discover", "Discover remote works", "Find remote works or remote matches.", true, schemaObject("query", "pageSize"), schemaObject("sourceIds", "codes"), schemaObject("remoteWorks")),
	nodeType("discover_remote_collection", "discover", "Discover remote collection", "Fetch a named source collection such as popular works.", true, schemaObject("collectionKind", "pageSize"), schemaObject("sourceId"), schemaObject("works", "pagination")),
	nodeType("fetch_remote_tree", "discover", "Fetch remote tree", "Fetch a remote work file tree.", true, schemaObject("sourceId", "code"), schemaObject("sourceId", "code"), schemaObject("tracks", "snapshotBytes")),
	nodeType("refresh_circle_catalog", "discover", "Refresh circle catalog", "Fetch and update a circle catalog.", false, schemaObject("mode", "productMode"), schemaObject("partyId", "externalId"), schemaObject("catalogWorks", "pagesFetched")),

	nodeType("filter_candidates", "filter", "Filter candidates", "Keep only candidates matching workflow rules.", true, schemaObject("rule", "status", "limit"), schemaObject("candidates"), schemaObject("candidates", "rejected")),

	nodeType("match_works", "match", "Match works", "Match candidates to known works and availability state.", true, schemaObject("strategy"), schemaObject("candidates"), schemaObject("matchedWorks", "unmatched")),
	nodeType("check_source_availability", "match", "Check source availability", "Check remote source availability for works.", false, schemaObject("sourceIds", "staleAfterDays"), schemaObject("codes", "sourceIds"), schemaObject("sources", "hasLocal", "hasCache", "hasRemote")),

	nodeType("plan_save", "plan", "Plan fetch", "Build a cache and local promotion plan for selected remote files.", true, schemaObject("saveRootTemplate", "paths"), schemaObject("tracks", "cacheState"), schemaObject("items", "summary")),

	nodeType("materialize_cache", "execute", "Materialize cache", "Download or copy media into cache.", true, schemaObject("cacheRoot", "overwrite"), schemaObject("downloadUrl", "cachePath"), schemaObject("cachePath", "bytes")),
	nodeType("materialize_save", "execute", "Materialize save", "Compatibility node for older save workflows.", false, schemaObject("overwrite", "dryRun"), schemaObject("items", "saveRoot"), schemaObject("saved", "skipped", "downloaded", "copiedFromCache")),
	nodeType("promote_cache_to_local", "execute", "Promote cache to local", "Move cached media into the local library.", true, schemaObject("mode", "overwrite"), schemaObject("cachePath", "targetPath"), schemaObject("localPath", "moved")),
	nodeType("cleanup_cache", "execute", "Cleanup cache", "Delete cached files or clear cache-related state.", true, schemaObject("deleteFiles", "clearState"), schemaObject("locationIds", "cachePath"), schemaObject("deleted", "cleared")),
	nodeType("dispatch_child_workflows", "execute", "Dispatch child workflows", "Run child workflows from a parent workflow.", false, schemaObject("workflowCode", "mode"), schemaObject("codes", "action"), schemaObject("childRuns")),

	nodeType("verify_files", "verify", "Verify files", "Validate materialized file outputs.", true, schemaObject("checkSize", "checkHash"), schemaObject("paths", "expected"), schemaObject("verified", "failed")),

	nodeType("sync_file_locations", "commit", "Sync file locations", "Persist local, remote, or cache file locations.", true, schemaObject("locationType", "markMissing"), schemaObject("workId", "locations"), schemaObject("syncedLocations")),
	nodeType("sync_metadata", "commit", "Sync metadata", "Persist metadata snapshots and normalized work fields.", true, schemaObject("provider", "language", "forceRefresh"), schemaObject("workIds", "codes"), schemaObject("syncedWorks", "skippedWorks", "failedWorks")),
	nodeType("sync_tracked_presence", "commit", "Sync tracked presence", "Persist selected remote works as tracked source presence.", true, schemaObject("presenceType"), schemaObject("works", "sourceId"), schemaObject("tracked")),
}

var allowedWorkflowNodeTypes = workflowNodeTypeMap(workflowNodeTypeRegistry)

var allowedScheduledTriggerTypes = map[string]bool{
	"startup":          true,
	"schedule":         true,
	"filesystem_event": true,
	"source_poll":      true,
}

func nodeType(nodeType string, phase string, displayName string, description string, userVisible bool, configSchema string, inputSchema string, outputSchema string) workflowNodeTypeRecord {
	return workflowNodeTypeRecord{
		Type:         nodeType,
		Phase:        phase,
		DisplayName:  displayName,
		Description:  description,
		UserVisible:  userVisible,
		ConfigSchema: configSchema,
		InputSchema:  inputSchema,
		OutputSchema: outputSchema,
	}
}

func schemaObject(fields ...string) string {
	properties := map[string]any{}
	for _, field := range fields {
		properties[field] = map[string]string{"description": field}
	}
	raw, err := json.Marshal(map[string]any{
		"type":       "object",
		"properties": properties,
	})
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func workflowNodeTypeMap(records []workflowNodeTypeRecord) map[string]bool {
	result := map[string]bool{}
	for _, record := range records {
		result[record.Type] = true
	}
	return result
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

type workflowCandidateUpdatePayload struct {
	Status       string `json:"status"`
	DecisionJSON string `json:"decisionJson"`
}

func (s *Server) ensureSystemWorkflowDefinitions(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, spec := range systemWorkflowSpecs {
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

func (s *Server) listWorkflowNodeTypes(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	writeJSON(w, http.StatusOK, workflowNodeTypeRegistry)
}

type systemWorkflowSpec struct {
	Code        string
	Name        string
	Description string
	Nodes       []map[string]string
}

var systemWorkflowSpecs = []systemWorkflowSpec{
	{
		Code:        "startup_library_refresh",
		Name:        "Startup library refresh",
		Description: "Run startup library maintenance by scanning local files and then syncing metadata.",
		Nodes: []map[string]string{
			{"id": "scan", "type": "dispatch_child_workflows", "displayName": "Run local library scan"},
			{"id": "metadata", "type": "dispatch_child_workflows", "displayName": "Run metadata sync"},
		},
	},
	{
		Code:        "local_library_scan",
		Name:        "Scan local library",
		Description: "Discover local files, match works, and sync local file locations. This workflow can be run manually.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_local_source", "displayName": "Select local source"},
			{"id": "discover", "type": "discover_local_files", "displayName": "Discover files"},
			{"id": "match", "type": "match_works", "displayName": "Match works"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync locations"},
		},
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
		Name:        "Run popular remote collection",
		Description: "Discover popular works from a configured compatible source, then track or fetch accepted works.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote source"},
			{"id": "discover", "type": "discover_remote_collection", "displayName": "Discover popular works"},
			{"id": "filter", "type": "filter_candidates", "displayName": "Filter collection candidates"},
			{"id": "dispatch", "type": "dispatch_child_workflows", "displayName": "Track or fetch works"},
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
		Code:        "remote_work_save",
		Name:        "Save remote work",
		Description: "Save selected remote files to the local library, reusing cache hits and downloading misses.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote source"},
			{"id": "tree", "type": "fetch_remote_tree", "displayName": "Fetch remote tree"},
			{"id": "plan", "type": "plan_save", "displayName": "Plan save"},
			{"id": "materialize", "type": "materialize_save", "displayName": "Materialize files"},
			{"id": "verify", "type": "verify_files", "displayName": "Verify files"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync local locations"},
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
		Code:        "source_health_check",
		Name:        "Check source health",
		Description: "Check configured remote source endpoints and fallback readiness. Not implemented as a runnable workflow yet.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote source"},
			{"id": "check", "type": "filter_candidates", "displayName": "Check endpoint"},
		},
	},
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

func (s *Server) getWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	run, err := s.loadWorkflowRun(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	nodeRows, err := s.db.QueryContext(r.Context(), `
		SELECT
			id,
			node_id,
			node_type,
			display_name,
			position,
			status,
			input_json,
			output_json,
			error_message,
			COALESCE(started_at, ''),
			COALESCE(finished_at, ''),
			created_at
		FROM workflow_node_run
		WHERE workflow_run_id = ?
		ORDER BY position ASC, id ASC
	`, id)
	if err != nil {
		writeError(w, err)
		return
	}
	defer nodeRows.Close()

	detail := workflowRunDetailRecord{workflowRunRecord: run, NodeRuns: []workflowNodeRunRecord{}}
	for nodeRows.Next() {
		var node workflowNodeRunRecord
		if err := nodeRows.Scan(
			&node.ID,
			&node.NodeID,
			&node.NodeType,
			&node.DisplayName,
			&node.Position,
			&node.Status,
			&node.InputJSON,
			&node.OutputJSON,
			&node.ErrorMessage,
			&node.StartedAt,
			&node.FinishedAt,
			&node.CreatedAt,
		); err != nil {
			writeError(w, err)
			return
		}
		detail.NodeRuns = append(detail.NodeRuns, node)
	}
	if err := nodeRows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) listWorkflowRunEvents(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if _, err := s.loadWorkflowRun(r.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			id,
			workflow_run_id,
			workflow_node_run_id,
			workflow_job_id,
			level,
			event_type,
			message,
			detail_json,
			created_at
		FROM workflow_event
		WHERE workflow_run_id = ?
		ORDER BY created_at ASC, id ASC
	`, id)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	events := []workflowEventRecord{}
	for rows.Next() {
		var item workflowEventRecord
		var nodeRunID sql.NullInt64
		var jobID sql.NullInt64
		if err := rows.Scan(
			&item.ID,
			&item.RunID,
			&nodeRunID,
			&jobID,
			&item.Level,
			&item.EventType,
			&item.Message,
			&item.DetailJSON,
			&item.CreatedAt,
		); err != nil {
			writeError(w, err)
			return
		}
		item.NodeRunID = nullableInt64(nodeRunID)
		item.JobID = nullableInt64(jobID)
		events = append(events, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) listWorkflowRunCandidates(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if _, err := s.loadWorkflowRun(r.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	candidates, err := s.loadWorkflowCandidates(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, candidates)
}

func (s *Server) loadWorkflowCandidates(ctx context.Context, runID int64) ([]workflowCandidateRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			id,
			workflow_run_id,
			workflow_node_run_id,
			candidate_type,
			external_key,
			status,
			payload_json,
			decision_json,
			created_at,
			updated_at
		FROM workflow_candidate
		WHERE workflow_run_id = ?
		ORDER BY updated_at DESC, id DESC
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	candidates := []workflowCandidateRecord{}
	for rows.Next() {
		var item workflowCandidateRecord
		var nodeRunID sql.NullInt64
		if err := rows.Scan(
			&item.ID,
			&item.RunID,
			&nodeRunID,
			&item.Type,
			&item.ExternalKey,
			&item.Status,
			&item.PayloadJSON,
			&item.DecisionJSON,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		item.NodeRunID = nullableInt64(nodeRunID)
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func (s *Server) updateWorkflowCandidate(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow candidate id"})
		return
	}
	var payload workflowCandidateUpdatePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	payload.Status = strings.TrimSpace(payload.Status)
	payload.DecisionJSON = strings.TrimSpace(payload.DecisionJSON)
	if payload.DecisionJSON == "" {
		payload.DecisionJSON = "{}"
	}
	if !allowedCandidateReviewStatus(payload.Status) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported candidate status"})
		return
	}
	if !json.Valid([]byte(payload.DecisionJSON)) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "decision JSON is invalid"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	var runID int64
	var nodeRunID sql.NullInt64
	var candidateType string
	var externalKey string
	if err := tx.QueryRowContext(r.Context(), `
		SELECT workflow_run_id, workflow_node_run_id, candidate_type, external_key
		FROM workflow_candidate
		WHERE id = ?
	`, id).Scan(&runID, &nodeRunID, &candidateType, &externalKey); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow candidate not found"})
			return
		}
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE workflow_candidate
		SET status = ?, decision_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, payload.Status, payload.DecisionJSON, id); err != nil {
		writeError(w, err)
		return
	}
	if err := workflow.InsertEvent(r.Context(), tx, runID, workflow.EventSpec{
		NodeRunID: nullableInt64Value(nodeRunID),
		Level:     "info",
		Type:      "candidate.reviewed",
		Message:   "Candidate " + payload.Status,
		Detail: map[string]any{
			"candidate_id":   id,
			"candidate_type": candidateType,
			"external_key":   externalKey,
			"status":         payload.Status,
		},
	}); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	candidates, err := s.loadWorkflowCandidates(r.Context(), runID)
	if err != nil {
		writeError(w, err)
		return
	}
	for _, candidate := range candidates {
		if candidate.ID == id {
			writeJSON(w, http.StatusOK, candidate)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) cancelWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	run, err := s.loadWorkflowRunTx(r.Context(), tx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	if run.Status != "queued" && run.Status != "running" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "only queued or running workflow runs can be cancelled"})
		return
	}
	summary := mergeJSONObjects(run.SummaryJSON, map[string]any{"cancelled": true, "cancel_reason": "manual"})
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE workflow_node_run
		SET status = 'cancelled',
			error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
			AND status IN ('queued', 'running')
	`, id); err != nil {
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE workflow_run
		SET status = 'cancelled',
			summary_json = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(summary), id); err != nil {
		writeError(w, err)
		return
	}
	if err := workflow.InsertEvent(r.Context(), tx, id, workflow.EventSpec{
		Level:   "warn",
		Type:    "run.cancelled",
		Message: "Run cancelled manually",
		Detail:  map[string]any{"previous_status": run.Status},
	}); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workflowRunActionResult{RunID: id, Status: "cancelled", Message: "run cancelled"})
}

func (s *Server) retryWorkflowRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	run, err := s.loadWorkflowRun(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	if run.Status == "queued" || run.Status == "running" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "running workflow runs cannot be retried"})
		return
	}
	var newRunID int64
	switch run.WorkflowCode {
	case "local_library_scan":
		result, err := s.runLocalScan(r.Context(), "manual", "retry_run")
		if err != nil {
			writeError(w, err)
			return
		}
		newRunID = result.RunID
	case "metadata_sync":
		result, err := s.runDLsiteMetadataSync(r.Context(), "manual", "retry_run")
		if err != nil {
			writeError(w, err)
			return
		}
		newRunID = result.RunID
	default:
		writeJSON(w, http.StatusConflict, map[string]string{"error": "retry is not implemented for this workflow type yet"})
		return
	}
	if err := s.recordWorkflowRunEvent(r.Context(), id, "info", "run.retry_requested", "Retry started", map[string]any{"new_run_id": newRunID}); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, workflowRunActionResult{RunID: id, Status: "retried", Message: "retry started", NewRunID: &newRunID})
}

func (s *Server) recoverStaleWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	recovered, err := s.markStaleWorkflowRuns(r.Context(), "manual recovery")
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workflowRunActionResult{Status: "recovered", Message: "stale runs marked failed", Recovered: recovered})
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

func (s *Server) loadWorkflowRun(ctx context.Context, id int64) (workflowRunRecord, error) {
	return s.loadWorkflowRunFrom(ctx, s.db, id)
}

type workflowRunQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Server) loadWorkflowRunTx(ctx context.Context, tx *sql.Tx, id int64) (workflowRunRecord, error) {
	return s.loadWorkflowRunFrom(ctx, tx, id)
}

func (s *Server) loadWorkflowRunFrom(ctx context.Context, db workflowRunQuerier, id int64) (workflowRunRecord, error) {
	var item workflowRunRecord
	var definitionID sql.NullInt64
	var triggerID sql.NullInt64
	err := db.QueryRowContext(ctx, workflowRunSelectSQL()+`
		FROM workflow_run AS run
		WHERE run.id = ?
	`, id).Scan(
		&item.ID,
		&item.WorkflowCode,
		&item.DisplayName,
		&item.Status,
		&item.TriggerType,
		&item.TriggerReason,
		&item.CreatedAt,
		&item.StartedAt,
		&item.FinishedAt,
		&item.SummaryJSON,
		&item.NodeRunCount,
		&item.CompletedNodeRuns,
		&item.FailedNodeRuns,
		&item.SkippedNodeRuns,
		&item.JobCount,
		&item.CompletedJobs,
		&item.FailedJobs,
		&item.SkippedJobs,
		&item.CandidateCount,
		&item.PendingCandidates,
		&item.AcceptedCandidates,
		&item.RejectedCandidates,
		&definitionID,
		&triggerID,
	)
	item.DefinitionID = nullableInt64(definitionID)
	item.TriggerID = nullableInt64(triggerID)
	return item, err
}

func (s *Server) recordWorkflowRunEvent(ctx context.Context, runID int64, level string, eventType string, message string, detail any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{Level: level, Type: eventType, Message: message, Detail: detail}); err != nil {
		return err
	}
	return tx.Commit()
}

func workflowRunSelectSQL() string {
	return `
		SELECT
			run.id,
			run.workflow_code,
			run.display_name,
			run.status,
			run.trigger_type,
			run.trigger_reason,
			run.created_at,
			COALESCE(run.started_at, ''),
			COALESCE(run.finished_at, ''),
			run.summary_json,
			(
				SELECT COUNT(*)
				FROM workflow_node_run
				WHERE workflow_node_run.workflow_run_id = run.id
			) AS node_run_count,
			(
				SELECT COUNT(*)
				FROM workflow_node_run
				WHERE workflow_node_run.workflow_run_id = run.id
					AND workflow_node_run.status = 'succeeded'
			) AS completed_node_runs,
			(
				SELECT COUNT(*)
				FROM workflow_node_run
				WHERE workflow_node_run.workflow_run_id = run.id
					AND workflow_node_run.status = 'failed'
			) AS failed_node_runs,
			(
				SELECT COUNT(*)
				FROM workflow_node_run
				WHERE workflow_node_run.workflow_run_id = run.id
					AND workflow_node_run.status = 'skipped'
			) AS skipped_node_runs,
			(
				SELECT COUNT(*)
				FROM workflow_job
				WHERE workflow_job.workflow_run_id = run.id
			) AS job_count,
			(
				SELECT COUNT(*)
				FROM workflow_job
				WHERE workflow_job.workflow_run_id = run.id
					AND workflow_job.status = 'succeeded'
			) AS completed_jobs,
			(
				SELECT COUNT(*)
				FROM workflow_job
				WHERE workflow_job.workflow_run_id = run.id
					AND workflow_job.status = 'failed'
			) AS failed_jobs,
			(
				SELECT COUNT(*)
				FROM workflow_job
				WHERE workflow_job.workflow_run_id = run.id
					AND workflow_job.status = 'skipped'
			) AS skipped_jobs,
			(
				SELECT COUNT(*)
				FROM workflow_candidate
				WHERE workflow_candidate.workflow_run_id = run.id
			) AS candidate_count,
			(
				SELECT COUNT(*)
				FROM workflow_candidate
				WHERE workflow_candidate.workflow_run_id = run.id
					AND workflow_candidate.status NOT IN ('accepted', 'rejected', 'ignored', 'resolved')
			) AS pending_candidates,
			(
				SELECT COUNT(*)
				FROM workflow_candidate
				WHERE workflow_candidate.workflow_run_id = run.id
					AND workflow_candidate.status = 'accepted'
			) AS accepted_candidates,
			(
				SELECT COUNT(*)
				FROM workflow_candidate
				WHERE workflow_candidate.workflow_run_id = run.id
					AND workflow_candidate.status = 'rejected'
			) AS rejected_candidates,
			run.workflow_definition_id,
			run.trigger_id
	`
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
			Config      any    `json:"config"`
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
		if node.Config != nil {
			if _, ok := node.Config.(map[string]any); !ok {
				return fmt.Errorf("node config must be an object")
			}
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

func (s *Server) markStaleWorkflowRuns(ctx context.Context, reason string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `
		SELECT id, display_name, status
		FROM workflow_run
		WHERE status IN ('queued', 'running')
		ORDER BY created_at ASC, id ASC
	`)
	if err != nil {
		return 0, err
	}
	type staleRun struct {
		id          int64
		displayName string
		status      string
	}
	staleRuns := []staleRun{}
	for rows.Next() {
		var run staleRun
		if err := rows.Scan(&run.id, &run.displayName, &run.status); err != nil {
			_ = rows.Close()
			return 0, err
		}
		staleRuns = append(staleRuns, run)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, run := range staleRuns {
		summary := mustJSON(map[string]any{"error": reason, "recovered_stale": true})
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = 'failed',
				error_message = CASE WHEN error_message <> '' THEN error_message ELSE ? END,
				finished_at = CURRENT_TIMESTAMP
			WHERE workflow_run_id = ?
				AND status IN ('queued', 'running')
		`, reason, run.id); err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_run
			SET status = 'failed',
				summary_json = ?,
				finished_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, summary, run.id); err != nil {
			return 0, err
		}
		if err := workflow.InsertEvent(ctx, tx, run.id, workflow.EventSpec{
			Level:   "warn",
			Type:    "run.recovered_stale",
			Message: "Stale run marked failed",
			Detail:  map[string]any{"previous_status": run.status, "reason": reason},
		}); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int64(len(staleRuns)), nil
}
