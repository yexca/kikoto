package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"
)

type legacyWorkflowTrigger struct {
	ID       int64           `json:"id"`
	Type     string          `json:"type"`
	Name     string          `json:"name"`
	Enabled  int             `json:"enabled"`
	Schedule json.RawMessage `json:"schedule"`
	Config   json.RawMessage `json:"config"`
}

type legacyWorkflowSnapshot struct {
	ID             int64                   `json:"id"`
	Code           string                  `json:"code"`
	Name           string                  `json:"name"`
	Description    string                  `json:"description"`
	DefinitionJSON string                  `json:"definitionJson"`
	OwnerID        sql.NullInt64           `json:"-"`
	CreatorID      sql.NullInt64           `json:"-"`
	Triggers       []legacyWorkflowTrigger `json:"triggers"`
	ReviewStatus   string                  `json:"reviewStatus"`
}

type legacyWorkflowMigrationItem struct {
	ID           int64          `json:"id"`
	Name         string         `json:"name"`
	ReviewStatus string         `json:"reviewStatus"`
	Preset       string         `json:"preset,omitempty"`
	Inputs       map[string]any `json:"inputs,omitempty"`
	TriggerCount int            `json:"triggerCount"`
	CanConvert   bool           `json:"canConvert"`
	Reason       string         `json:"reason,omitempty"`
}

func (s *Server) listLegacyWorkflowMigrations(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT original_id, code, display_name, description, definition_json,
		       owner_user_id, created_by_user_id, triggers_json, review_status
		FROM legacy_workflow_snapshot ORDER BY original_id
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = rows.Close() }()
	result := []legacyWorkflowMigrationItem{}
	for rows.Next() {
		var item legacyWorkflowSnapshot
		var triggers string
		if err := rows.Scan(&item.ID, &item.Code, &item.Name, &item.Description, &item.DefinitionJSON,
			&item.OwnerID, &item.CreatorID, &triggers, &item.ReviewStatus); err != nil {
			writeError(w, err)
			return
		}
		if err := json.Unmarshal([]byte(triggers), &item.Triggers); err != nil {
			writeError(w, err)
			return
		}
		result = append(result, analyzeLegacyWorkflow(item))
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) loadLegacyWorkflow(ctx context.Context, id int64) (legacyWorkflowSnapshot, error) {
	var item legacyWorkflowSnapshot
	var triggers string
	err := s.db.QueryRowContext(ctx, `
		SELECT original_id, code, display_name, description, definition_json,
		       owner_user_id, created_by_user_id, triggers_json, review_status
		FROM legacy_workflow_snapshot WHERE original_id = ?
	`, id).Scan(&item.ID, &item.Code, &item.Name, &item.Description, &item.DefinitionJSON,
		&item.OwnerID, &item.CreatorID, &triggers, &item.ReviewStatus)
	if err != nil {
		return item, err
	}
	err = json.Unmarshal([]byte(triggers), &item.Triggers)
	return item, err
}

func analyzeLegacyWorkflow(item legacyWorkflowSnapshot) legacyWorkflowMigrationItem {
	result := legacyWorkflowMigrationItem{ID: item.ID, Name: item.Name, ReviewStatus: item.ReviewStatus,
		TriggerCount: len(item.Triggers), Reason: "This graph needs manual review; its behavior cannot be mapped exactly to a current preset."}
	var graph workflowGraphDefinition
	if err := json.Unmarshal([]byte(item.DefinitionJSON), &graph); err != nil || graph.SchemaVersion != workflowGraphSchemaVersion {
		return result
	}
	var discover *workflowGraphNode
	nodes := map[string]workflowGraphNode{}
	for _, node := range graph.Nodes {
		if _, duplicate := nodes[node.Type]; duplicate {
			return result
		}
		nodes[node.Type] = node
		if node.Type == "circle_catalog" || node.Type == "series_catalog" || node.Type == "voice_catalog" {
			if discover != nil {
				return result
			}
			copy := node
			discover = &copy
		}
	}
	if discover == nil {
		return result
	}
	code := map[string]string{"circle_catalog": "circle_catalog_sync", "series_catalog": "series_catalog_sync", "voice_catalog": "voice_catalog_sync"}[discover.Type]
	spec, ok := presetWorkflowSpecByCode(code)
	if !ok {
		return result
	}
	raw := map[string]any{"metadata": false, "tagNameTemplate": ""}
	switch discover.Type {
	case "circle_catalog":
		raw["circleId"] = discover.Config["circleId"]
	case "series_catalog":
		raw["seriesId"] = discover.Config["seriesId"]
	case "voice_catalog":
		raw["personId"] = discover.Config["personId"]
		if sourceIDs, ok := discover.Config["sourceIds"]; ok {
			raw["sourceIds"] = sourceIDs
		}
	}
	if mode, ok := discover.Config["mode"]; ok {
		raw["catalogRefresh"] = mode
	}
	if filter, ok := nodes["filter_works"]; ok {
		if filter.Config["existing"] != "missing_metadata" {
			return result
		}
		if limit, ok := filter.Config["limit"].(float64); ok && int(limit) != presetWorkflowMaxCatalogSize {
			raw["maxWorks"] = limit
		}
		for _, key := range []string{"releaseFrom", "releaseTo"} {
			if value, ok := filter.Config[key]; ok {
				raw[key] = value
			}
		}
	}
	if _, ok := nodes["metadata_sync"]; ok {
		raw["metadata"] = true
	}
	if tag, ok := nodes["tag_works"]; ok {
		raw["tagNameTemplate"] = tag.Config["tagName"]
	}
	if sources, ok := nodes["circle_sources"]; ok {
		raw["checkSourceIds"] = sources.Config["sourceIds"]
	}
	inputs, err := normalizePresetWorkflowInputs(spec, raw)
	if err != nil {
		return result
	}
	generated := buildPresetWorkflowDefinition(spec, inputs, inputs.TagNameTemplate)
	if !sameLegacyPresetGraph(graph, generated) {
		return result
	}
	result.Preset = code
	result.Inputs = inputs.public()
	result.Reason = ""
	if len(item.Triggers) == 0 {
		result.Reason = "This workflow has no trigger. Use the suggested preset inputs to run it manually."
		return result
	}
	for _, trigger := range item.Triggers {
		if trigger.Type != "startup" && trigger.Type != "schedule" {
			result.Reason = "A trigger type needs manual reconfiguration."
			return result
		}
	}
	result.CanConvert = true
	return result
}

func sameLegacyPresetGraph(left, right workflowGraphDefinition) bool {
	if len(left.Nodes) != len(right.Nodes) || len(left.Edges) != len(right.Edges) || !sameJSONValue(left.Policy, right.Policy) {
		return false
	}
	byType := map[string]workflowGraphNode{}
	for _, node := range right.Nodes {
		byType[node.Type] = node
	}
	leftTypes := map[string]string{}
	rightTypes := map[string]string{}
	for _, node := range left.Nodes {
		matched, ok := byType[node.Type]
		if !ok || !sameJSONValue(node.Config, matched.Config) {
			return false
		}
		leftTypes[node.ID] = node.Type
	}
	for _, node := range right.Nodes {
		rightTypes[node.ID] = node.Type
	}
	edges := func(graph workflowGraphDefinition, types map[string]string) []string {
		result := make([]string, 0, len(graph.Edges))
		for _, edge := range graph.Edges {
			result = append(result, types[edge.Source]+":"+edge.SourceHandle+">"+types[edge.Target]+":"+edge.TargetHandle)
		}
		sort.Strings(result)
		return result
	}
	return sameJSONValue(edges(left, leftTypes), edges(right, rightTypes))
}

func sameJSONValue(left, right any) bool {
	a, errA := json.Marshal(left)
	b, errB := json.Marshal(right)
	return errA == nil && errB == nil && string(a) == string(b)
}

func (s *Server) exportLegacyWorkflow(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_id", "Choose a saved workflow.", false)
		return
	}
	item, err := s.loadLegacyWorkflow(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "workflow_not_found", "Saved workflow not found.", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=legacy-workflow-%d.json", id))
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) skipLegacyWorkflow(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_id", "Choose a saved workflow.", false)
		return
	}
	result, err := s.db.ExecContext(r.Context(), `UPDATE legacy_workflow_snapshot SET review_status = 'skipped' WHERE original_id = ? AND review_status = 'pending'`, id)
	if err != nil {
		writeError(w, err)
		return
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		writeAPIError(w, http.StatusConflict, "workflow_already_reviewed", "This saved workflow was already reviewed.", false)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) convertLegacyWorkflow(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	if !userHasPermission(actor, "workflows:run") {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "Workflow permission is required.", false)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_id", "Choose a saved workflow.", false)
		return
	}
	item, err := s.loadLegacyWorkflow(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "workflow_not_found", "Saved workflow not found.", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	analysis := analyzeLegacyWorkflow(item)
	if !analysis.CanConvert || item.ReviewStatus == "converted" {
		writeAPIError(w, http.StatusConflict, "workflow_not_convertible", "This workflow needs manual review or was already converted.", false)
		return
	}
	spec, _ := presetWorkflowSpecByCode(analysis.Preset)
	if _, err := s.planPresetWorkflow(r.Context(), spec, analysis.Inputs, time.Now(), true); err != nil {
		writeAPIError(w, http.StatusConflict, "workflow_config_changed", "The preset inputs need manual review.", false)
		return
	}
	// Scheduled catalog sync is now a subscription: the reviewing account
	// subscribes to the workflow's targets, and each subscription takes its
	// baseline from the next successful catalog pull.
	created, err := s.subscribeLegacyWorkflowTargets(r.Context(), actor.ID, analysis.Preset, analysis.Inputs)
	if err != nil {
		writeError(w, err)
		return
	}
	result, err := s.db.ExecContext(r.Context(), `UPDATE legacy_workflow_snapshot
		SET review_status = 'converted', converted_preset_code = ? WHERE original_id = ? AND review_status IN ('pending', 'skipped')`, analysis.Preset, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		writeAPIError(w, http.StatusConflict, "workflow_already_reviewed", "This saved workflow was already reviewed.", false)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"preset": analysis.Preset, "subscriptionsCreated": created})
}

// subscribeLegacyWorkflowTargets subscribes an account to the circles,
// series, or voice actor a converted workflow followed. Targets this site
// does not know, and series its circle subscription covers, are skipped.
func (s *Server) subscribeLegacyWorkflowTargets(ctx context.Context, userID int64, preset string, inputs map[string]any) (int, error) {
	subjects := []creatorSubscriptionSubject{}
	switch preset {
	case "circle_catalog_sync":
		text, _ := inputs["circleId"].(string)
		for _, circleID := range splitPresetWorkflowTargets(text, normalizeMakerID) {
			subject, err := s.resolveCreatorSubscriptionSubject(ctx, creatorSubscriptionRequest{Kind: "circle", CircleID: circleID})
			if err == nil {
				subjects = append(subjects, subject)
			}
		}
	case "series_catalog_sync":
		text, _ := inputs["seriesId"].(string)
		for _, seriesID := range splitPresetWorkflowTargets(text, normalizeSeriesID) {
			rows, err := s.db.QueryContext(ctx, `
				SELECT DISTINCT series.party_id, COALESCE((
					SELECT external.external_id FROM party_external_id AS external
					WHERE external.party_id = series.party_id AND external.id_type = 'maker_id'
					ORDER BY external.is_primary DESC, external.id
					LIMIT 1
				), '')
				FROM party_series AS series WHERE UPPER(series.title_id) = ?
			`, seriesID)
			if err != nil {
				return 0, err
			}
			for rows.Next() {
				subject := creatorSubscriptionSubject{Kind: "series", SeriesID: seriesID}
				if err := rows.Scan(&subject.PartyID, &subject.CircleID); err != nil {
					_ = rows.Close()
					return 0, err
				}
				subject.CircleID = normalizeMakerID(subject.CircleID)
				subjects = append(subjects, subject)
			}
			if err := rows.Close(); err != nil {
				return 0, err
			}
		}
	case "voice_catalog_sync":
		if personID, ok := graphConfigInteger(inputs["personId"]); ok {
			subject, err := s.resolveCreatorSubscriptionSubject(ctx, creatorSubscriptionRequest{Kind: "voice", PersonID: personID})
			if err == nil {
				subjects = append(subjects, subject)
			}
		}
	}
	created := 0
	for _, subject := range subjects {
		_, conflict, err := s.subscribeCreator(ctx, userID, subject, false, true)
		if err != nil {
			return created, err
		}
		if conflict == nil {
			created++
		}
	}
	return created, nil
}
