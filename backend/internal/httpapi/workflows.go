package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

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
	nodeType("select_ranking", "target", "Configure ranking", "Choose a provider ranking period and release scope.", false, schemaObject("period", "releaseWindow", "year"), schemaObject(), schemaObject("period", "releaseWindow", "year")),

	nodeType("discover_local_files", "discover", "Discover local files", "Scan local folders and detect work files.", true, schemaObject("includeExisting", "markMissing"), schemaObject("sourceId", "path"), schemaObject("files", "detectedWorks")),
	nodeType("discover_remote_works", "discover", "Discover remote works", "Find remote works or remote matches.", true, schemaObject("query", "pageSize"), schemaObject("sourceIds", "codes"), schemaObject("remoteWorks")),
	nodeType("discover_remote_collection", "discover", "Discover remote collection", "Fetch a named source collection such as popular works.", true, schemaObject("collectionKind", "pageSize"), schemaObject("sourceId"), schemaObject("works", "pagination")),
	nodeType("discover_provider_ranking", "discover", "Discover provider ranking", "Fetch an ordered provider ranking without creating file-source presence.", false, schemaObject("provider", "period", "releaseWindow", "year"), schemaObject(), schemaObject("codes")),
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
	nodeType("forget_unlinked_work", "commit", "Forget unlinked work", "Remove a logical work family only when no available source remains.", true, schemaObject(), schemaObject("workIds"), schemaObject("forgottenWorkIds", "skipped")),
	nodeType("dispatch_child_workflows", "execute", "Dispatch child workflows", "Run child workflows from a parent workflow.", false, schemaObject("workflowCode", "mode"), schemaObject("codes", "action"), schemaObject("childRuns")),

	nodeType("verify_files", "verify", "Verify files", "Validate materialized file outputs.", true, schemaObject("checkSize", "checkHash"), schemaObject("paths", "expected"), schemaObject("verified", "failed")),

	nodeType("sync_file_locations", "commit", "Sync file locations", "Persist local, remote, or cache file locations.", true, schemaObject("locationType", "markMissing"), schemaObject("workId", "locations"), schemaObject("syncedLocations")),
	nodeType("sync_metadata", "commit", "Sync metadata", "Persist metadata snapshots and normalized work fields.", true, schemaObject("provider", "language", "forceRefresh"), schemaObject("workIds", "codes"), schemaObject("syncedWorks", "skippedWorks", "failedWorks")),
	nodeType("sync_tracked_presence", "commit", "Sync tracked presence", "Persist selected remote works as tracked source presence.", true, schemaObject("presenceType"), schemaObject("works", "sourceId"), schemaObject("tracked")),
	nodeType("assign_user_tags", "commit", "Assign user tags", "Append user-owned tags to synchronized works.", false, schemaObject("tagName"), schemaObject("workIds", "userId"), schemaObject("tagged")),
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
	writeJSON(w, http.StatusOK, mergedWorkflowNodeTypeRecords())
}

func mergedWorkflowNodeTypeRecords() []workflowNodeTypeRecord {
	nodeTypes := append([]workflowNodeTypeRecord{}, workflowNodeTypeRegistry...)
	indexByType := make(map[string]int, len(nodeTypes))
	for index, record := range nodeTypes {
		indexByType[record.Type] = index
	}
	for _, record := range customWorkflowNodeTypeRecords() {
		if index, exists := indexByType[record.Type]; exists {
			nodeTypes[index] = record
			continue
		}
		indexByType[record.Type] = len(nodeTypes)
		nodeTypes = append(nodeTypes, record)
	}
	return nodeTypes
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
		Name:        "Availability Watch",
		Description: "Monitor a shared pool of work codes and dispatch configured actions when a remote source becomes available.",
		Nodes: []map[string]string{
			{"id": "targets", "type": "select_works", "displayName": "Monitoring pool"},
			{"id": "check", "type": "check_source_availability", "displayName": "Check source availability"},
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
	if err := ensureWorkflowCommandAliasAvailableFrom(r.Context(), tx, actor.ID, 0, payload.DefinitionJSON); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}

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
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
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
	if !canManageWorkflowDefinition(actor, current) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "workflow definition belongs to another user"})
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
	if err := s.validateWorkflowDefinitionTriggerUpdate(r.Context(), current, payload.DefinitionJSON); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	ownerID := actor.ID
	if current.OwnerUserID != nil {
		ownerID = *current.OwnerUserID
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := updateWorkflowDefinitionTx(r.Context(), tx, current.ID, ownerID, payload); err != nil {
		var aliasErr *workflowCommandAliasConflictError
		if errors.As(err, &aliasErr) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
			return
		}
		writeError(w, err)
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
	writeJSON(w, http.StatusOK, definition)
}

type workflowCommandAliasConflictError struct{ err error }

func (e *workflowCommandAliasConflictError) Error() string { return e.err.Error() }
func (e *workflowCommandAliasConflictError) Unwrap() error { return e.err }

func updateWorkflowDefinitionTx(ctx context.Context, tx *sql.Tx, definitionID, ownerID int64, payload workflowDefinitionPayload) error {
	if err := ensureWorkflowCommandAliasAvailableFrom(ctx, tx, ownerID, definitionID, payload.DefinitionJSON); err != nil {
		return &workflowCommandAliasConflictError{err: err}
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_definition
		SET display_name = ?, description = ?, definition_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND editable = 1
	`, payload.DisplayName, payload.Description, payload.DefinitionJSON, definitionID)
	return err
}

func (s *Server) deleteWorkflowDefinition(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
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
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "editable workflow definition not found"})
			return
		}
		writeError(w, err)
		return
	}
	if !current.Editable || !canManageWorkflowDefinition(actor, current) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "workflow definition cannot be deleted"})
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
	return current, currentDefinition, nil
}

func (s *Server) prepareWorkflowTriggerUpdate(ctx context.Context, actor currentUser, id int64, current workflowTriggerRecord, currentDefinition workflowDefinitionRecord, payload workflowTriggerPayload) (workflowTriggerRecord, preparedWorkflowTrigger, bool, error) {
	if current.TriggerType == "filesystem_event" && !isFixedFilesystemTriggerUpdate(currentDefinition, current, payload) {
		return workflowTriggerRecord{}, preparedWorkflowTrigger{}, false, workflowTriggerUpdateHTTPErrorf(http.StatusConflict, "the local library filesystem trigger only supports enable and pause")
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

func isFixedFilesystemTriggerUpdate(definition workflowDefinitionRecord, current workflowTriggerRecord, payload workflowTriggerPayload) bool {
	return definition.Code == "local_library_scan" && payload.WorkflowDefinitionID == current.WorkflowDefinitionID &&
		payload.TriggerType == current.TriggerType && payload.DisplayName == current.DisplayName &&
		payload.ScheduleJSON == current.ScheduleJSON && payload.ConfigJSON == current.ConfigJSON
}

func (s *Server) persistWorkflowTriggerUpdate(ctx context.Context, id int64, current workflowTriggerRecord, payload workflowTriggerPayload, prepared preparedWorkflowTrigger, enabled bool) error {
	result, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET workflow_definition_id = ?, trigger_type = ?, display_name = ?, enabled = ?,
			schedule_json = ?, config_json = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, payload.WorkflowDefinitionID, payload.TriggerType, payload.DisplayName, enabled, payload.ScheduleJSON, prepared.ConfigJSON, prepared.NextRunAt, id)
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

func (s *Server) getWorkflowRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
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
	graphJSON, err := s.customWorkflowRunGraphJSON(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	detail.GraphJSON = graphJSON
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) listWorkflowRunEvents(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
		return
	}
	afterID := int64(0)
	if value := strings.TrimSpace(r.URL.Query().Get("afterId")); value != "" {
		afterID, err = strconv.ParseInt(value, 10, 64)
		if err != nil || afterID < 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow event cursor"})
			return
		}
	}
	events, err := s.workflowStore.ListEventsAfter(r.Context(), id, afterID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) listWorkflowRunCandidates(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
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
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow candidate id"})
		return
	}
	payload, err := decodeWorkflowCandidateUpdate(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
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
	if !requireWorkflowRunAccessFrom(w, r, tx, actor, runID) {
		return
	}
	if candidateType == remoteOriginBlockedCandidateType {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "update the remote source outbound policy, then retry the workflow run"})
		return
	}
	if err := updateWorkflowCandidateReview(r.Context(), tx, id, payload, runID, nodeRunID, candidateType, externalKey); err != nil {
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

func decodeWorkflowCandidateUpdate(r *http.Request) (workflowCandidateUpdatePayload, error) {
	var payload workflowCandidateUpdatePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return workflowCandidateUpdatePayload{}, errors.New("invalid JSON body")
	}
	payload.Status = strings.TrimSpace(payload.Status)
	payload.DecisionJSON = strings.TrimSpace(payload.DecisionJSON)
	if payload.DecisionJSON == "" {
		payload.DecisionJSON = "{}"
	}
	if !allowedCandidateReviewStatus(payload.Status) {
		return workflowCandidateUpdatePayload{}, errors.New("unsupported candidate status")
	}
	if !json.Valid([]byte(payload.DecisionJSON)) {
		return workflowCandidateUpdatePayload{}, errors.New("decision JSON is invalid")
	}
	return payload, nil
}

func updateWorkflowCandidateReview(ctx context.Context, tx *sql.Tx, candidateID int64, payload workflowCandidateUpdatePayload, runID int64, nodeRunID sql.NullInt64, candidateType, externalKey string) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_candidate
		SET status = ?, decision_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, payload.Status, payload.DecisionJSON, candidateID); err != nil {
		return err
	}
	return workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		NodeRunID: nullableInt64Value(nodeRunID), Level: "info", Type: "candidate.reviewed",
		Message: "Candidate " + payload.Status,
		Detail:  map[string]any{"candidate_id": candidateID, "candidate_type": candidateType, "external_key": externalKey, "status": payload.Status},
	})
}

func (s *Server) cleanupLocalWorkflowCandidate(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
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
	if !s.requireWorkflowCandidateAccess(w, r, actor, id) {
		return
	}
	result, err := s.runLocalCandidateCleanup(r.Context(), id, payload.Action, payload.LocationIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type archivedFetchRoot struct {
	FolderID     int64  `json:"folder_id"`
	OriginalPath string `json:"original_path"`
	ArchivePath  string `json:"archive_path"`
}

type archivedFetchReviewRequest struct {
	Action  string `json:"action"`
	Confirm string `json:"confirm"`
}

func (s *Server) reviewArchivedFetchRoots(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow candidate id"})
		return
	}
	request, err := decodeArchivedFetchReviewRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !s.requireWorkflowCandidateAccess(w, r, actor, id) {
		return
	}
	candidate, err := s.loadWorkflowCandidateForCleanup(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	if candidate.Type != "local_fetch_merge_cleanup" || !candidateNeedsResolution(candidate.Status) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "candidate is not an unresolved Fetch archive review"})
		return
	}
	archivedRoots, err := archivedFetchRootsFromCandidate(candidate.PayloadJSON)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "candidate has no archived roots"})
		return
	}
	if request.Action == "delete_archived" {
		if err := s.deleteArchivedFetchRoots(archivedRoots); err != nil {
			var pathErr *archivedFetchRootPathError
			if errors.As(err, &pathErr) {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
				return
			}
			writeError(w, err)
			return
		}
	}
	if err := s.resolveArchivedFetchReview(r.Context(), id, candidate.RunID, request.Action, archivedRoots); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"candidateId": id, "status": "resolved", "action": request.Action})
}

func decodeArchivedFetchReviewRequest(r *http.Request) (archivedFetchReviewRequest, error) {
	var request archivedFetchReviewRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		return request, errors.New("invalid JSON body")
	}
	request.Action = strings.TrimSpace(request.Action)
	if request.Action != "keep_archived" && request.Action != "delete_archived" {
		return request, errors.New("action must be keep_archived or delete_archived")
	}
	if request.Action == "delete_archived" && request.Confirm != "DELETE" {
		return request, errors.New("permanent deletion requires DELETE confirmation")
	}
	return request, nil
}

func archivedFetchRootsFromCandidate(raw string) ([]archivedFetchRoot, error) {
	var payload struct {
		ArchivedRoots []archivedFetchRoot `json:"archived_roots"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil || len(payload.ArchivedRoots) == 0 {
		return nil, errors.New("candidate has no archived roots")
	}
	return payload.ArchivedRoots, nil
}

type archivedFetchRootPathError struct{}

func (err *archivedFetchRootPathError) Error() string {
	return "archived root is outside the Fetch trash area"
}

func (s *Server) deleteArchivedFetchRoots(roots []archivedFetchRoot) error {
	for _, root := range roots {
		archive := filepath.ToSlash(strings.Trim(root.ArchivePath, "/"))
		if !strings.HasPrefix(archive, ".kikoto-trash/fetch/") {
			return &archivedFetchRootPathError{}
		}
		if _, err := safeDataPath(s.cfg.DataRoot, archive); err != nil {
			return err
		}
		if _, err := removeDestructiveTree(s.cfg.DataRoot, archive); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) resolveArchivedFetchReview(ctx context.Context, candidateID, runID int64, action string, roots []archivedFetchRoot) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, root := range roots {
		if action == "delete_archived" {
			if _, err := tx.ExecContext(ctx, "DELETE FROM work_folder_location WHERE id = ? AND state = 'pending_cleanup' AND cleanup_run_id = ?", root.FolderID, runID); err != nil {
				return err
			}
		} else if _, err := tx.ExecContext(ctx, "UPDATE work_folder_location SET state = 'ignored', cleanup_run_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'pending_cleanup' AND cleanup_run_id = ?", root.FolderID, runID); err != nil {
			return err
		}
	}
	decision := map[string]any{"action": action, "archived_roots": len(roots)}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_candidate SET status = 'resolved', decision_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(decision), candidateID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		Level: "info", Type: "candidate.fetch_archive_reviewed", Message: "Fetch archive " + action, Detail: decision,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func candidateNeedsResolution(status string) bool {
	status = strings.TrimSpace(status)
	return status != "accepted" && status != "rejected" && status != "ignored" && status != "resolved"
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

	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
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
		NodeRunID: cleanupNodeID, WorkerType: "local_location_cleanup", Status: "running", ResourceKey: "media:cleanup", Payload: input,
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
		var err error
		deleted, _, err = removeDestructiveFile(s.cfg.DataRoot, relPath)
		if err != nil {
			return false, false, err
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
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	tx, err := beginTxWithDatabaseBusyRetry(r.Context(), s.db)
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
	allowed, err := canManageWorkflowRun(r.Context(), tx, actor, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	if run.Status != "queued" && run.Status != "running" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "only queued or running workflow runs can be cancelled"})
		return
	}
	changed, err := s.cancelWorkflowRunTx(r.Context(), tx, run, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if !changed {
		_ = tx.Rollback()
		writeJSON(w, http.StatusConflict, map[string]string{"error": "workflow run has already finished"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	s.cancelActiveWorkflowJob(id)
	writeJSON(w, http.StatusOK, workflowRunActionResult{RunID: id, Status: "cancelled", Message: "run cancelled"})
}

func (s *Server) cancelWorkflowRunTx(ctx context.Context, tx *sql.Tx, run workflowRunRecord, runID int64) (bool, error) {
	summary := mergeJSONObjects(run.SummaryJSON, map[string]any{"cancelled": true, "cancel_reason": "manual"})
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'cancelled',
			error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
			AND status IN ('queued', 'running')
	`, runID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'cancelled',
			error_message = CASE WHEN error_message <> '' THEN error_message ELSE 'cancelled manually' END,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ?
			AND status IN ('queued', 'running')
	`, runID); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'cancelled', summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, mustJSON(summary), runID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil || affected == 0 {
		return affected > 0, err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		Level: "warn", Type: "run.cancelled", Message: "Run cancelled manually",
		Detail: map[string]any{"previous_status": run.Status},
	}); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Server) retryWorkflowRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
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
	allowed, err := canManageWorkflowRun(r.Context(), s.db, actor, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	if run.Status == "queued" || run.Status == "running" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "running workflow runs cannot be retried"})
		return
	}
	dispatch, err := s.dispatchWorkflowRetry(r.Context(), actor, run, id)
	if errors.Is(err, errWorkflowRetryPermission) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	if errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "this workflow has no recoverable failed job"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	detail := map[string]any{"new_run_id": dispatch.NewRunID}
	if dispatch.ResumedExistingRun {
		detail = map[string]any{"resumed_run_id": id}
	}
	if err := s.recordWorkflowRunEvent(r.Context(), id, "info", "run.retry_requested", "Retry started", detail); err != nil {
		writeError(w, err)
		return
	}
	result := workflowRunActionResult{RunID: id, Status: "retried", Message: "retry started"}
	if !dispatch.ResumedExistingRun {
		result.NewRunID = &dispatch.NewRunID
	}
	writeJSON(w, http.StatusAccepted, result)
}

var (
	errWorkflowRetryPermission       = errors.New("workflow retry permission denied")
	errWorkflowRetryNoRecoverableJob = errors.New("workflow has no recoverable failed job")
)

type workflowRetryDispatchResult struct {
	NewRunID           int64
	ResumedExistingRun bool
}

func (s *Server) dispatchWorkflowRetry(ctx context.Context, actor currentUser, run workflowRunRecord, runID int64) (workflowRetryDispatchResult, error) {
	switch run.WorkflowCode {
	case "local_library_scan":
		if !userHasPermission(actor, "metadata:sync") {
			return workflowRetryDispatchResult{}, errWorkflowRetryPermission
		}
		newRunID, err := s.retryLocalLibraryScan(ctx, runID)
		return workflowRetryDispatchResult{NewRunID: newRunID}, err
	case "metadata_sync":
		if !userHasPermission(actor, "metadata:sync") {
			return workflowRetryDispatchResult{}, errWorkflowRetryPermission
		}
		result, err := s.enqueueDLsiteMetadataSync(ctx, "manual", "retry_run")
		return workflowRetryDispatchResult{NewRunID: result.RunID}, err
	default:
		return s.retryCustomWorkflow(ctx, actor, runID)
	}
}

func (s *Server) retryLocalLibraryScan(ctx context.Context, runID int64) (int64, error) {
	var payload localScanJobPayload
	var inputJSON string
	if err := s.db.QueryRowContext(ctx, "SELECT input_json FROM workflow_run WHERE id = ?", runID).Scan(&inputJSON); err != nil {
		return 0, err
	}
	if err := json.Unmarshal([]byte(inputJSON), &payload); err != nil {
		return 0, err
	}
	result, err := s.enqueueLocalScanWithOptions(ctx, "manual", "retry_run", 0, payload.FollowUpRun)
	return result.RunID, err
}

func (s *Server) retryCustomWorkflow(ctx context.Context, actor currentUser, runID int64) (workflowRetryDispatchResult, error) {
	allowed, err := s.canRetryCustomWorkflowRun(ctx, actor, runID)
	if err != nil {
		return workflowRetryDispatchResult{}, err
	}
	if !allowed {
		return workflowRetryDispatchResult{}, errWorkflowRetryPermission
	}
	if err := s.retryFailedWorkflowJob(ctx, runID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workflowRetryDispatchResult{}, errWorkflowRetryNoRecoverableJob
		}
		return workflowRetryDispatchResult{}, err
	}
	return workflowRetryDispatchResult{NewRunID: runID, ResumedExistingRun: true}, nil
}

type workflowRunOwnershipQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func canViewAllWorkflowRuns(actor currentUser) bool {
	return missingCustomWorkflowPermission(actor.Permissions, []string{"system:admin"}) == ""
}

func (s *Server) requireWorkflowRunAccess(w http.ResponseWriter, r *http.Request, actor currentUser, runID int64) bool {
	return requireWorkflowRunAccessFrom(w, r, s.db, actor, runID)
}

func requireWorkflowRunAccessFrom(w http.ResponseWriter, r *http.Request, db workflowRunOwnershipQuerier, actor currentUser, runID int64) bool {
	allowed, err := canManageWorkflowRun(r.Context(), db, actor, runID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
		return false
	}
	if err != nil {
		writeError(w, err)
		return false
	}
	if !allowed {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return false
	}
	return true
}

func (s *Server) requireWorkflowCandidateAccess(w http.ResponseWriter, r *http.Request, actor currentUser, candidateID int64) bool {
	var runID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT workflow_run_id FROM workflow_candidate WHERE id = ?", candidateID).Scan(&runID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow candidate not found"})
			return false
		}
		writeError(w, err)
		return false
	}
	return s.requireWorkflowRunAccess(w, r, actor, runID)
}

func canManageWorkflowRun(ctx context.Context, db workflowRunOwnershipQuerier, actor currentUser, runID int64) (bool, error) {
	var scope, triggerReason string
	var ownerUserID, requestedByUserID int64
	if err := db.QueryRowContext(ctx, `
		SELECT COALESCE(definition.scope, ''),
			COALESCE(definition.owner_user_id, 0),
			COALESCE(CAST(json_extract(run.input_json, '$.requested_by_user_id') AS INTEGER), 0),
			run.trigger_reason
		FROM workflow_run AS run
		LEFT JOIN workflow_definition AS definition ON definition.id = run.workflow_definition_id
		WHERE run.id = ?
	`, runID).Scan(&scope, &ownerUserID, &requestedByUserID, &triggerReason); err != nil {
		return false, err
	}
	if canViewAllWorkflowRuns(actor) {
		return true, nil
	}
	if scope != "user" && !(scope == "" && triggerReason == "custom_definition") {
		return true, nil
	}
	return ownerUserID == actor.ID || requestedByUserID == actor.ID, nil
}

func (s *Server) canRetryCustomWorkflowRun(ctx context.Context, actor currentUser, runID int64) (bool, error) {
	if missingCustomWorkflowPermission(actor.Permissions, []string{"system:admin"}) == "" {
		return true, nil
	}
	var payloadJSON string
	err := s.db.QueryRowContext(ctx, `
		SELECT payload_json
		FROM workflow_job
		WHERE workflow_run_id = ? AND status = 'failed' AND recoverable = 1 AND worker_type = 'custom_workflow'
		ORDER BY id DESC
		LIMIT 1
	`, runID).Scan(&payloadJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	var payload customWorkflowJobPayload
	if err := decodeWorkflowJobPayload(payloadJSON, &payload); err != nil {
		return false, err
	}
	if payload.UserID != actor.ID {
		return false, nil
	}
	graph, err := validateCustomWorkflowDefinition(payload.DefinitionJSON)
	if err != nil {
		return false, err
	}
	return missingCustomWorkflowPermission(actor.Permissions, customWorkflowRequiredPermissions(graph)) == "", nil
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
				'media_location_cleanup', 'metadata_family_sync', 'voice_catalog_refresh', 'custom_workflow'
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
	if !s.requireWorkflowRunAccess(w, r, user, id) {
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
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	recovered, err := s.workflowStore.MarkStaleRunsVisibleTo(r.Context(), "manual recovery", actor.ID, canViewAllWorkflowRuns(actor))
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
	if err := validateWorkflowDefinitionMetadata(payload); err != nil {
		return err
	}
	var versionProbe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal([]byte(payload.DefinitionJSON), &versionProbe); err != nil {
		return fmt.Errorf("definition JSON is invalid")
	}
	if versionProbe.SchemaVersion == customWorkflowSchemaVersion {
		_, err := validateCustomWorkflowDefinition(payload.DefinitionJSON)
		return err
	}
	if versionProbe.SchemaVersion != 0 {
		return fmt.Errorf("unsupported workflow schemaVersion: %d", versionProbe.SchemaVersion)
	}
	return validateLegacyWorkflowDefinition(payload.DefinitionJSON)
}

func validateWorkflowDefinitionMetadata(payload workflowDefinitionPayload) error {
	if !workflowCodePattern.MatchString(payload.Code) {
		return fmt.Errorf("workflow code must be lowercase snake_case and 3-64 characters")
	}
	if payload.DisplayName == "" {
		return fmt.Errorf("display name is required")
	}
	if payload.DefinitionJSON == "" {
		return fmt.Errorf("definition JSON is required")
	}
	return nil
}

type legacyWorkflowNodePayload struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	DisplayName string `json:"displayName"`
	Config      any    `json:"config"`
}

type legacyWorkflowDefinitionPayload struct {
	Nodes []legacyWorkflowNodePayload `json:"nodes"`
}

func validateLegacyWorkflowDefinition(raw string) error {
	var definition legacyWorkflowDefinitionPayload
	if err := json.Unmarshal([]byte(raw), &definition); err != nil {
		return fmt.Errorf("definition JSON is invalid")
	}
	if len(definition.Nodes) == 0 {
		return fmt.Errorf("workflow needs at least one node")
	}
	seen := map[string]bool{}
	for _, node := range definition.Nodes {
		if err := validateLegacyWorkflowNode(node, seen); err != nil {
			return err
		}
	}
	return nil
}

func validateLegacyWorkflowNode(node legacyWorkflowNodePayload, seen map[string]bool) error {
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
