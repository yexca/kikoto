package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
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
	nodeType("stage_fetch_result", "execute", "Stage fetch result", "Assemble the complete result tree outside scanner-visible library roots.", true, schemaObject("stagingRoot"), schemaObject("plan"), schemaObject("staged")),
	nodeType("publish_staged_fetch", "commit", "Publish staged fetch", "Atomically publish a verified staging tree and retain a recoverable backup until registration.", true, schemaObject("targetRoot"), schemaObject("stagingRoot"), schemaObject("published")),
	nodeType("materialize_save", "execute", "Materialize save", "Compatibility node for older save workflows.", false, schemaObject("overwrite", "dryRun"), schemaObject("items", "saveRoot"), schemaObject("saved", "skipped", "downloaded", "copiedFromCache")),
	nodeType("promote_cache_to_local", "execute", "Promote cache to local", "Move cached media into the local library.", true, schemaObject("mode", "overwrite"), schemaObject("cachePath", "targetPath"), schemaObject("localPath", "moved")),
	nodeType("cleanup_cache", "execute", "Cleanup cache", "Delete cached files or clear cache-related state.", true, schemaObject("deleteFiles", "clearState"), schemaObject("locationIds", "cachePath"), schemaObject("deleted", "cleared")),
	nodeType("cleanup_local_locations", "execute", "Cleanup local locations", "Mark selected local locations unavailable and optionally delete their files.", true, schemaObject("deleteFiles"), schemaObject("locationIds"), schemaObject("deleted", "marked")),
	nodeType("delete_local_media", "execute", "Delete local media", "Delete local media files and mark their locations unavailable.", true, schemaObject(), schemaObject("locationIds"), schemaObject("deleted")),
	nodeType("cleanup_media_locations", "execute", "Cleanup media locations", "Delete selected cache or local files and mark their locations unavailable.", true, schemaObject(), schemaObject("targets"), schemaObject("deleted")),
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

type localCandidateCleanupPayload struct {
	Action      string  `json:"action"`
	LocationIDs []int64 `json:"locationIds"`
}

type localLocationCleanupJobPayload struct {
	CandidateID int64   `json:"candidate_id"`
	Action      string  `json:"action"`
	LocationIDs []int64 `json:"location_ids"`
}

type localLocationCleanupCheckpoint struct {
	CompletedLocationIDs []int64                     `json:"completedLocationIds"`
	Result               localCandidateCleanupResult `json:"result"`
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
		Code:        "media_location_cleanup",
		Name:        "Clean media locations",
		Description: "Delete selected cache or local files and mark their locations unavailable.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_media_items", "displayName": "Select media locations"},
			{"id": "cleanup", "type": "cleanup_media_locations", "displayName": "Delete media files"},
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
	detail, err := s.workflowStore.LoadRunDetail(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
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
	events, err := s.workflowStore.ListEvents(r.Context(), id)
	if err != nil {
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
	return s.workflowStore.ListCandidates(ctx, runID)
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

func (s *Server) cleanupLocalWorkflowCandidate(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow candidate id"})
		return
	}
	var payload localCandidateCleanupPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	payload.Action = strings.TrimSpace(payload.Action)
	if payload.Action == "" {
		payload.Action = "mark_unavailable"
	}
	if payload.Action != "mark_unavailable" && payload.Action != "delete_files" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be mark_unavailable or delete_files"})
		return
	}
	result, err := s.runLocalCandidateCleanup(r.Context(), id, payload.Action, payload.LocationIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) runLocalCandidateCleanup(ctx context.Context, candidateID int64, action string, requestedLocationIDs []int64) (localCandidateCleanupResult, error) {
	candidate, err := s.loadWorkflowCandidateForCleanup(ctx, candidateID)
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	if candidate.Type != "local_fetch_merge_cleanup" && candidate.Type != "local_duplicate_work_folder" {
		return localCandidateCleanupResult{}, fmt.Errorf("candidate type %s cannot run local cleanup", candidate.Type)
	}
	allowedIDs := candidateLocalLocationIDs(candidate.PayloadJSON)
	locationIDs := intersectLocationIDs(allowedIDs, requestedLocationIDs)
	if len(locationIDs) == 0 {
		return localCandidateCleanupResult{}, fmt.Errorf("no cleanup locations selected")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_location_cleanup", "Clean up local locations", "Mark reviewed local locations unavailable and optionally delete the files.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "cleanup", "type": "cleanup_local_locations"},
			{"id": "review", "type": "filter_candidates"},
		},
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	input := map[string]any{"candidate_id": candidateID, "action": action, "location_ids": locationIDs}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "local_location_cleanup", "Clean up local locations", "running", "manual", action, input, map[string]any{"candidate_id": candidateID, "locations": len(locationIDs)})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select local locations", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"locations": len(locationIDs)},
	}); err != nil {
		return localCandidateCleanupResult{}, err
	}
	cleanupNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cleanup", NodeType: "cleanup_local_locations", DisplayName: "Clean local files", Position: 2, Status: "running",
		Input: input, Output: nil,
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	reviewNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "review", NodeType: "filter_candidates", DisplayName: "Resolve review candidate", Position: 3, Status: "queued",
		Input: map[string]any{"candidate_id": candidateID}, Output: nil,
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	initialResult := localCandidateCleanupResult{RunID: runID, CandidateID: candidateID, Action: action, Status: "succeeded", Failures: []string{}}
	initialCheckpoint := localLocationCleanupCheckpoint{CompletedLocationIDs: []int64{}, Result: initialResult}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cleanupNodeID, WorkerType: "local_location_cleanup", Status: "running", Payload: input,
		Checkpoint: initialCheckpoint, Recoverable: true, MaxRetries: 3, ProgressCurrent: 0, ProgressTotal: len(locationIDs),
	})
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return localCandidateCleanupResult{}, err
	}
	job := workflowJobRecord{
		ID: jobID, RunID: runID, NodeRunID: cleanupNodeID,
		PayloadJSON: mustJSON(input), CheckpointJSON: mustJSON(initialCheckpoint),
	}
	jobCtx, stopHeartbeat, err := s.leaseInlineWorkflowJob(ctx, job)
	if err != nil {
		return localCandidateCleanupResult{}, err
	}
	defer stopHeartbeat()
	return s.performLocalLocationCleanupJob(jobCtx, job, reviewNodeID)
}

func (s *Server) executeLocalLocationCleanupJob(ctx context.Context, job workflowJobRecord) error {
	var reviewNodeID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'review' LIMIT 1
	`, job.RunID).Scan(&reviewNodeID); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_, err := s.performLocalLocationCleanupJob(ctx, job, reviewNodeID)
	return err
}

func (s *Server) performLocalLocationCleanupJob(ctx context.Context, job workflowJobRecord, reviewNodeID int64) (localCandidateCleanupResult, error) {
	var payload localLocationCleanupJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return localCandidateCleanupResult{}, err
	}
	checkpoint := localLocationCleanupCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return localCandidateCleanupResult{}, err
	}
	result := checkpoint.Result
	if result.RunID == 0 {
		result = localCandidateCleanupResult{RunID: job.RunID, CandidateID: payload.CandidateID, Action: payload.Action, Status: "succeeded", Failures: []string{}}
	}
	completed := map[int64]bool{}
	for _, id := range checkpoint.CompletedLocationIDs {
		completed[id] = true
	}
	for index, locationID := range payload.LocationIDs {
		if completed[locationID] {
			continue
		}
		deleted, marked, cleanupErr := s.cleanupLocalLocation(ctx, locationID, payload.Action == "delete_files")
		if cleanupErr != nil {
			result.Failed++
			result.Failures = append(result.Failures, fmt.Sprintf("%d: %s", locationID, cleanupErr.Error()))
		} else {
			if deleted {
				result.Deleted++
			}
			if marked {
				result.Marked++
			}
		}
		completed[locationID] = true
		checkpoint.Result = result
		checkpoint.CompletedLocationIDs = append(checkpoint.CompletedLocationIDs, locationID)
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "cleanup", checkpoint, index+1, len(payload.LocationIDs))
	}
	result.Status = "succeeded"
	if result.Failed > 0 {
		result.Status = "partial"
	}
	if err := s.finishLocalCandidateCleanup(ctx, payload.CandidateID, job.RunID, job.NodeRunID, reviewNodeID, result); err != nil {
		return localCandidateCleanupResult{}, err
	}
	return result, nil
}

func (s *Server) loadWorkflowCandidateForCleanup(ctx context.Context, candidateID int64) (workflowCandidateRecord, error) {
	var item workflowCandidateRecord
	var nodeRunID sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `
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
		WHERE id = ?
	`, candidateID).Scan(
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
		if errors.Is(err, sql.ErrNoRows) {
			return workflowCandidateRecord{}, fmt.Errorf("workflow candidate not found")
		}
		return workflowCandidateRecord{}, err
	}
	item.NodeRunID = nullableInt64(nodeRunID)
	if item.Status == "resolved" || item.Status == "ignored" || item.Status == "rejected" {
		return workflowCandidateRecord{}, fmt.Errorf("workflow candidate is already %s", item.Status)
	}
	return item, nil
}

func candidateLocalLocationIDs(payloadJSON string) []int64 {
	var payload map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return nil
	}
	ids := int64Values(payload["candidate_location_ids"])
	if len(ids) > 0 {
		return ids
	}
	locations, _ := payload["candidate_locations"].([]any)
	for _, raw := range locations {
		location, _ := raw.(map[string]any)
		ids = append(ids, int64Values(location["location_id"])...)
	}
	return uniqueInt64s(ids)
}

func int64Values(value any) []int64 {
	switch typed := value.(type) {
	case []any:
		values := make([]int64, 0, len(typed))
		for _, raw := range typed {
			values = append(values, int64Values(raw)...)
		}
		return values
	case float64:
		if typed > 0 {
			return []int64{int64(typed)}
		}
	case int64:
		if typed > 0 {
			return []int64{typed}
		}
	case int:
		if typed > 0 {
			return []int64{int64(typed)}
		}
	}
	return nil
}

func intersectLocationIDs(allowed []int64, requested []int64) []int64 {
	allowedSet := map[int64]bool{}
	for _, id := range allowed {
		if id > 0 {
			allowedSet[id] = true
		}
	}
	if len(requested) == 0 {
		return uniqueInt64s(allowed)
	}
	result := []int64{}
	for _, id := range requested {
		if allowedSet[id] {
			result = append(result, id)
		}
	}
	return uniqueInt64s(result)
}

func uniqueInt64s(values []int64) []int64 {
	seen := map[int64]bool{}
	result := []int64{}
	for _, value := range values {
		if value <= 0 || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func (s *Server) cleanupLocalLocation(ctx context.Context, locationID int64, deleteFile bool) (bool, bool, error) {
	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(ctx, `
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, locationID).Scan(&locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, false, fmt.Errorf("local media location not found")
		}
		return false, false, err
	}
	if locationType != "local" {
		return false, false, fmt.Errorf("media location is not local")
	}
	deleted := false
	if deleteFile && availability == "available" {
		targetPath, err := safeDataPath(s.cfg.DataRoot, relPath)
		if err != nil {
			return false, false, err
		}
		info, err := os.Lstat(targetPath)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return false, false, err
			}
		} else if info.Mode()&os.ModeSymlink != 0 {
			return false, false, fmt.Errorf("refusing to delete symlink %s", filepath.ToSlash(relPath))
		} else if info.IsDir() {
			return false, false, fmt.Errorf("refusing to delete directory %s", filepath.ToSlash(relPath))
		} else if err := os.Remove(targetPath); err != nil {
			return false, false, err
		} else {
			deleted = true
		}
	}
	result, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND location_type = 'local'
			AND availability != 'unavailable'
	`, locationID)
	if err != nil {
		return deleted, false, err
	}
	markedRows, _ := result.RowsAffected()
	return deleted, markedRows > 0, nil
}

func (s *Server) finishLocalCandidateCleanup(ctx context.Context, candidateID int64, runID int64, cleanupNodeID int64, reviewNodeID int64, result localCandidateCleanupResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	status := result.Status
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(result), cleanupNodeID); err != nil {
		return err
	}
	reviewStatus := "resolved"
	if result.Failed > 0 {
		reviewStatus = "pending"
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"candidate_id": candidateID, "candidate_status": reviewStatus}), reviewNodeID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_candidate
		SET status = ?,
			decision_json = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, reviewStatus, mustJSON(result), candidateID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
	`, status, result.Deleted+result.Marked+result.Failed, result.Deleted+result.Marked+result.Failed, strings.Join(result.Failures, "; "), runID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		NodeRunID: reviewNodeID,
		Level:     eventLevelForCleanupResult(result),
		Type:      "candidate.local_cleanup",
		Message:   "Local cleanup " + status,
		Detail:    result,
	}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(result), runID); err != nil {
		return err
	}
	return tx.Commit()
}

func eventLevelForCleanupResult(result localCandidateCleanupResult) string {
	if result.Failed > 0 {
		return "warn"
	}
	return "info"
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
		UPDATE workflow_job
		SET status = 'cancelled',
			error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			updated_at = CURRENT_TIMESTAMP
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
	resumedExistingRun := false
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
		if err := s.retryFailedWorkflowJob(r.Context(), id); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "this workflow has no recoverable failed job"})
				return
			}
			writeError(w, err)
			return
		}
		newRunID = id
		resumedExistingRun = true
	}
	detail := map[string]any{"new_run_id": newRunID}
	if resumedExistingRun {
		detail = map[string]any{"resumed_run_id": id}
	}
	if err := s.recordWorkflowRunEvent(r.Context(), id, "info", "run.retry_requested", "Retry started", detail); err != nil {
		writeError(w, err)
		return
	}
	result := workflowRunActionResult{RunID: id, Status: "retried", Message: "retry started"}
	if !resumedExistingRun {
		result.NewRunID = &newRunID
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) retryFailedWorkflowJob(ctx context.Context, runID int64) error {
	var job workflowJobRecord
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workflow_run_id, COALESCE(workflow_node_run_id, 0), worker_type,
			payload_json, checkpoint_json, '', resume_count, retry_count, max_retries
		FROM workflow_job
		WHERE workflow_run_id = ? AND status = 'failed' AND recoverable = 1
			AND worker_type IN (
				'remote_work_fetch', 'remote_media_cache', 'remote_popular_collection',
				'media_cache_limit_cleanup', 'media_cache_cleanup', 'local_media_delete', 'local_location_cleanup',
				'media_location_cleanup'
			)
		ORDER BY id DESC LIMIT 1
	`, runID).Scan(
		&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType,
		&job.PayloadJSON, &job.CheckpointJSON, &job.LockedBy, &job.ResumeCount, &job.RetryCount, &job.MaxRetries,
	)
	if err != nil {
		return err
	}
	return s.requeueFailedWorkflowJob(ctx, job, 0, "Manual retry requested")
}

func (s *Server) reviewWorkflowRun(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
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
	if run.PendingCandidates > 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "resolve pending candidates before marking the run reviewed"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO workflow_run_review (workflow_run_id, user_id, status, reviewed_at)
		VALUES (?, ?, 'reviewed', CURRENT_TIMESTAMP)
		ON CONFLICT(workflow_run_id, user_id) DO UPDATE SET
			status = 'reviewed',
			reviewed_at = CURRENT_TIMESTAMP
	`, id, user.ID); err != nil {
		writeError(w, err)
		return
	}
	if err := workflow.InsertEvent(r.Context(), tx, id, workflow.EventSpec{
		Level:   "info",
		Type:    "run.reviewed",
		Message: "Run marked reviewed",
		Detail:  map[string]any{"user_id": user.ID},
	}); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	next, err := s.loadWorkflowRun(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, next)
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
	writeJSON(w, http.StatusOK, workflowRunActionResult{Status: "recovered", Message: "recoverable jobs requeued; unsupported stale runs marked failed", Recovered: recovered})
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
	return s.workflowStore.LoadDefinition(ctx, id)
}

func (s *Server) loadWorkflowTrigger(ctx context.Context, id int64) (workflowTriggerRecord, error) {
	return s.workflowStore.LoadTrigger(ctx, id)
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
	return s.workflowStore.MarkStaleRuns(ctx, reason)
}
