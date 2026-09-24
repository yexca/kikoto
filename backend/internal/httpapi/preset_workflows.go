package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Preset workflows are system-owned, parameterized graphs. Each preset builds a
// fixed typed DAG from a small validated input set and executes it through the
// existing custom-workflow runtime, so node executors, checkpoints, retries, and
// Fetch bounds are shared with that runtime while users never author a graph.

// presetWorkflowMaxTargets bounds how many circles, series, or voice actors one
// preset run may follow; their catalogs are combined before filtering.
const presetWorkflowMaxTargets = 20

// presetWorkflowMaxTargetText bounds the raw target list before it is split.
const presetWorkflowMaxTargetText = 2000

var presetWorkflowTargetSeparator = regexp.MustCompile(`[,;\r\n，；、]+`)

// splitPresetWorkflowTargets splits a target list separated by commas,
// semicolons, or new lines, dropping blanks and duplicates in input order.
func splitPresetWorkflowTargets(value string, normalize func(string) string) []string {
	targets := []string{}
	for _, part := range presetWorkflowTargetSeparator.Split(value, -1) {
		if target := normalize(strings.TrimSpace(part)); target != "" {
			targets = append(targets, target)
		}
	}
	return uniqueStrings(targets)
}

func joinPresetWorkflowTargets(targets []string) string {
	return strings.Join(targets, ", ")
}

func normalizeSeriesID(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

const (
	presetWorkflowMaxWorksLimit  = 500
	presetWorkflowDefaultWorks   = 25
	presetWorkflowMaxCatalogSize = 5000
)

var presetWorkflowTagTokens = []string{"date", "target"}

// presetWorkflowLegacyInputs are inputs of the follow presets before they were
// reduced to input, filter, and actions. A stored trigger that still carries one
// must be reconfigured rather than silently reinterpreted.
var presetWorkflowLegacyInputs = map[string]bool{
	"newWorks": true, "existing": true, "action": true, "sourceId": true, "metadataRefresh": true,
	"excludeExtensions": true, "maxFiles": true, "maxGiB": true, "minFreeGiB": true,
}

type presetWorkflowParameter struct {
	Key      string   `json:"key"`
	Kind     string   `json:"kind"`
	Group    string   `json:"group"`
	Required bool     `json:"required"`
	Default  any      `json:"default,omitempty"`
	Options  []string `json:"options,omitempty"`
	Minimum  int64    `json:"minimum,omitempty"`
	Maximum  int64    `json:"maximum,omitempty"`
	Tokens   []string `json:"tokens,omitempty"`
}

type presetWorkflowSpec struct {
	Code               string
	DisplayName        string
	Description        string
	Target             string
	DefaultTagTemplate string
	Parameters         []presetWorkflowParameter
	DisplayNodes       []map[string]string
}

type presetWorkflowRecord struct {
	Code               string                    `json:"code"`
	DisplayName        string                    `json:"displayName"`
	Description        string                    `json:"description"`
	Target             string                    `json:"target"`
	DefaultTagTemplate string                    `json:"defaultTagTemplate"`
	Parameters         []presetWorkflowParameter `json:"parameters"`
}

// presetWorkflowInputs is one normalized follow run: the input selects and
// refreshes a catalog, the filter narrows the catalog works that lack metadata,
// and the actions sync their metadata, tag them, or check remote sources.
type presetWorkflowInputs struct {
	CircleID string
	SeriesID string
	PersonID int64
	// VoiceName is the resolved display name of PersonID for tag templates.
	VoiceName string
	// SourceIDs are the voice catalog sources; CheckSourceIDs are the sources
	// the circle source check matches.
	SourceIDs      []int64
	CheckSourceIDs []int64
	// CatalogRefresh is incremental or full. A voice detail refresh may also
	// use stored to refresh only known-work metadata.
	CatalogRefresh string
	ReleaseFrom    string
	ReleaseTo      string
	// MaxWorks is zero when the run has no work limit.
	MaxWorks        int
	Metadata        bool
	TagNameTemplate string
	// KnownMetadata refreshes the metadata of a voice actor's known works that
	// lack it. Only a voice detail refresh sets it; it is not a preset input.
	KnownMetadata bool
}

type presetWorkflowRunRequest struct {
	Inputs map[string]any `json:"inputs"`
}

type presetWorkflowRunResponse struct {
	RunID        int64          `json:"runId"`
	Status       string         `json:"status"`
	WorkflowCode string         `json:"workflowCode"`
	TagName      string         `json:"tagName"`
	Inputs       map[string]any `json:"inputs"`
}

type presetWorkflowTriggerConfig struct {
	UserID int64          `json:"userId"`
	Inputs map[string]any `json:"inputs"`
}

type presetWorkflowPlan struct {
	Spec           presetWorkflowSpec
	Inputs         presetWorkflowInputs
	TagName        string
	Definition     workflowGraphDefinition
	DefinitionJSON string
	Graph          workflowGraph
	Permissions    []string
}

func presetCatalogRefreshParameter() presetWorkflowParameter {
	return presetWorkflowParameter{Key: "catalogRefresh", Kind: "select", Group: "input", Default: "incremental", Options: []string{"incremental", "full"}}
}

// presetFilterParameters are off unless supplied: without a release bound or a
// work limit every catalog work that lacks metadata reaches the actions.
func presetFilterParameters() []presetWorkflowParameter {
	return []presetWorkflowParameter{
		{Key: "releaseFrom", Kind: "date", Group: "filter"},
		{Key: "releaseTo", Kind: "date", Group: "filter"},
		{Key: "maxWorks", Kind: "integer", Group: "filter", Default: presetWorkflowDefaultWorks, Minimum: 1, Maximum: presetWorkflowMaxWorksLimit},
	}
}

func presetMetadataParameter() presetWorkflowParameter {
	return presetWorkflowParameter{Key: "metadata", Kind: "boolean", Group: "action", Default: true}
}

func presetTagParameter() presetWorkflowParameter {
	return presetWorkflowParameter{Key: "tagNameTemplate", Kind: "text_template", Group: "action", Tokens: presetWorkflowTagTokens}
}

func presetParameters(groups ...[]presetWorkflowParameter) []presetWorkflowParameter {
	result := []presetWorkflowParameter{}
	for _, group := range groups {
		result = append(result, group...)
	}
	return result
}

var presetWorkflowSpecs = []presetWorkflowSpec{
	{
		Code:               "circle_follow",
		DisplayName:        "Follow a circle",
		Description:        "Refresh a circle catalog, then sync metadata for the catalog works that lack it, tag them, and optionally check remote sources.",
		Target:             "circle",
		DefaultTagTemplate: "{date}_circle_{target}",
		Parameters: presetParameters(
			[]presetWorkflowParameter{{Key: "circleId", Kind: "circle_id", Group: "input", Required: true}, presetCatalogRefreshParameter()},
			presetFilterParameters(),
			[]presetWorkflowParameter{presetMetadataParameter(), presetTagParameter(), {Key: "checkSourceIds", Kind: "source_ids", Group: "action"}},
		),
		DisplayNodes: []map[string]string{
			{"id": "discover", "type": "circle_catalog", "displayName": "Circle catalog"},
			{"id": "sources", "type": "circle_sources", "displayName": "Check circle sources"},
			{"id": "filter", "type": "filter_works", "displayName": "Filter works without metadata"},
			{"id": "action", "type": "metadata_sync", "displayName": "Sync metadata"},
			{"id": "tag", "type": "tag_works", "displayName": "Add user tag"},
		},
	},
	{
		Code:               "series_follow",
		DisplayName:        "Follow a series",
		Description:        "Read the stored works of a provider series, then sync metadata for the works that lack it and tag them.",
		Target:             "series",
		DefaultTagTemplate: "{date}_series_{target}",
		Parameters: presetParameters(
			[]presetWorkflowParameter{{Key: "seriesId", Kind: "series_id", Group: "input", Required: true}},
			presetFilterParameters(),
			[]presetWorkflowParameter{presetMetadataParameter(), presetTagParameter()},
		),
		DisplayNodes: []map[string]string{
			{"id": "discover", "type": "series_catalog", "displayName": "Series catalog"},
			{"id": "filter", "type": "filter_works", "displayName": "Filter works without metadata"},
			{"id": "action", "type": "metadata_sync", "displayName": "Sync metadata"},
			{"id": "tag", "type": "tag_works", "displayName": "Add user tag"},
		},
	},
	{
		Code:               "voice_follow",
		DisplayName:        "Follow a voice actor",
		Description:        "Refresh a voice actor catalog on the selected remote sources, then sync metadata for the catalog works that lack it and tag them.",
		Target:             "voice",
		DefaultTagTemplate: "{date}_voice_{target}",
		Parameters: presetParameters(
			[]presetWorkflowParameter{
				{Key: "personId", Kind: "voice_person", Group: "input", Required: true},
				{Key: "sourceIds", Kind: "source_ids", Group: "input"},
				presetCatalogRefreshParameter(),
			},
			presetFilterParameters(),
			[]presetWorkflowParameter{presetMetadataParameter(), presetTagParameter()},
		),
		DisplayNodes: []map[string]string{
			{"id": "discover", "type": "voice_catalog", "displayName": "Voice actor catalog"},
			{"id": "filter", "type": "filter_works", "displayName": "Filter works without metadata"},
			{"id": "action", "type": "metadata_sync", "displayName": "Sync metadata"},
			{"id": "tag", "type": "tag_works", "displayName": "Add user tag"},
		},
	},
}

func presetWorkflowSpecByCode(code string) (presetWorkflowSpec, bool) {
	for _, spec := range presetWorkflowSpecs {
		if spec.Code == code {
			return spec, true
		}
	}
	return presetWorkflowSpec{}, false
}

func isPresetWorkflowCode(code string) bool {
	_, ok := presetWorkflowSpecByCode(code)
	return ok
}

func presetWorkflowCodes() []string {
	codes := make([]string, 0, len(presetWorkflowSpecs))
	for _, spec := range presetWorkflowSpecs {
		codes = append(codes, spec.Code)
	}
	sort.Strings(codes)
	return codes
}

func presetSystemWorkflowSpecs() []systemWorkflowSpec {
	result := make([]systemWorkflowSpec, 0, len(presetWorkflowSpecs))
	for _, spec := range presetWorkflowSpecs {
		result = append(result, systemWorkflowSpec{Code: spec.Code, Name: spec.DisplayName, Description: spec.Description, Nodes: spec.DisplayNodes})
	}
	return result
}

func presetWorkflowRecords() []presetWorkflowRecord {
	result := make([]presetWorkflowRecord, 0, len(presetWorkflowSpecs))
	for _, spec := range presetWorkflowSpecs {
		result = append(result, presetWorkflowRecord{
			Code: spec.Code, DisplayName: spec.DisplayName, Description: spec.Description, Target: spec.Target,
			DefaultTagTemplate: spec.DefaultTagTemplate, Parameters: append([]presetWorkflowParameter{}, spec.Parameters...),
		})
	}
	return result
}

func (s *Server) listWorkflowPresets(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	writeJSON(w, http.StatusOK, presetWorkflowRecords())
}

func (s *Server) runWorkflowPreset(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	spec, found := presetWorkflowSpecByCode(strings.TrimSpace(r.PathValue("code")))
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow preset not found"})
		return
	}
	var request presetWorkflowRunRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	plan, err := s.planPresetWorkflow(r.Context(), spec, request.Inputs, time.Now(), false)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if missing := missingWorkflowGraphPermission(actor.Permissions, plan.Permissions); missing != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied", "permission": missing})
		return
	}
	definition, err := s.loadWorkflowDefinitionByCode(r.Context(), spec.Code)
	if err != nil {
		writeError(w, err)
		return
	}
	runID, err := s.enqueueWorkflowGraph(r.Context(), definition, plan.Graph, actor.ID, actor.Permissions, plan.Inputs.public(), workflowGraphEnqueueOptions{
		TriggerType: "manual", TriggerReason: "workflow_preset", DefinitionJSON: plan.DefinitionJSON,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, presetWorkflowRunResponse{
		RunID: runID, Status: "queued", WorkflowCode: spec.Code, TagName: plan.TagName, Inputs: plan.Inputs.public(),
	})
}

func (s *Server) loadWorkflowDefinitionByCode(ctx context.Context, code string) (workflowDefinitionRecord, error) {
	var id int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM workflow_definition WHERE code = ? AND scope = 'system'", code).Scan(&id); err != nil {
		return workflowDefinitionRecord{}, err
	}
	return s.loadWorkflowDefinition(ctx, id)
}

// planPresetWorkflow validates inputs, checks the configured sources, renders
// the tag template for this dispatch, and builds the validated typed graph.
func (s *Server) planPresetWorkflow(ctx context.Context, spec presetWorkflowSpec, raw map[string]any, now time.Time, automated bool) (presetWorkflowPlan, error) {
	inputs, err := normalizePresetWorkflowInputs(spec, raw)
	if err != nil {
		return presetWorkflowPlan{}, err
	}
	return s.planPresetWorkflowInputs(ctx, spec, inputs, now, automated)
}

// planPresetWorkflowInputs builds the graph for already normalized inputs.
func (s *Server) planPresetWorkflowInputs(ctx context.Context, spec presetWorkflowSpec, inputs presetWorkflowInputs, now time.Time, automated bool) (presetWorkflowPlan, error) {
	if automated && inputs.CatalogRefresh == "full" {
		return presetWorkflowPlan{}, fmt.Errorf("automated runs support incremental catalog refresh only")
	}
	for _, sourceID := range append(append([]int64{}, inputs.SourceIDs...), inputs.CheckSourceIDs...) {
		if err := s.validatePresetWorkflowSource(ctx, sourceID); err != nil {
			return presetWorkflowPlan{}, err
		}
	}
	if spec.Target == "voice" {
		name, err := s.loadPersonName(ctx, inputs.PersonID)
		if errors.Is(err, sql.ErrNoRows) {
			return presetWorkflowPlan{}, fmt.Errorf("voice actor not found")
		}
		if err != nil {
			return presetWorkflowPlan{}, err
		}
		inputs.VoiceName = name
	}
	tagName := ""
	if inputs.TagNameTemplate != "" {
		rendered, err := renderWorkflowTagNameTemplate(inputs.TagNameTemplate, presetWorkflowTagValues(spec, inputs, now))
		if err != nil {
			return presetWorkflowPlan{}, err
		}
		tagName = rendered
	}
	definition := buildPresetWorkflowDefinition(spec, inputs, tagName)
	encoded, err := json.Marshal(definition)
	if err != nil {
		return presetWorkflowPlan{}, err
	}
	graph, err := validateWorkflowGraphDefinition(string(encoded))
	if err != nil {
		return presetWorkflowPlan{}, fmt.Errorf("preset workflow graph is invalid: %w", err)
	}
	permissions := append([]string{"workflows:run"}, workflowGraphRequiredPermissions(graph)...)
	return presetWorkflowPlan{Spec: spec, Inputs: inputs, TagName: tagName, Definition: definition, DefinitionJSON: string(encoded), Graph: graph, Permissions: uniqueStrings(permissions)}, nil
}

func (s *Server) validatePresetWorkflowSource(ctx context.Context, sourceID int64) error {
	source, err := s.remoteCollectionSource(ctx, sourceID)
	if err != nil {
		return err
	}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		return fmt.Errorf("source is not an enabled compatible remote source")
	}
	return nil
}

func presetWorkflowTagValues(spec presetWorkflowSpec, inputs presetWorkflowInputs, now time.Time) map[string]string {
	target := ""
	switch spec.Target {
	case "circle":
		target = inputs.CircleID
	case "series":
		target = inputs.SeriesID
	case "voice":
		target = inputs.VoiceName
	}
	return map[string]string{"date": now.UTC().Format("060102"), "target": workflowTagFragment(target)}
}

func normalizePresetWorkflowInputs(spec presetWorkflowSpec, raw map[string]any) (presetWorkflowInputs, error) {
	if raw == nil {
		raw = map[string]any{}
	}
	allowed := map[string]bool{}
	for _, parameter := range spec.Parameters {
		allowed[parameter.Key] = true
	}
	for key := range raw {
		if presetWorkflowLegacyInputs[key] {
			return presetWorkflowInputs{}, fmt.Errorf("follow options changed; reconfigure this run (%s is no longer an input)", key)
		}
		if !allowed[key] {
			return presetWorkflowInputs{}, fmt.Errorf("unknown preset input %s", key)
		}
	}
	inputs := presetWorkflowInputs{Metadata: true, TagNameTemplate: spec.DefaultTagTemplate}
	if spec.Target != "series" {
		inputs.CatalogRefresh = "incremental"
	}
	for _, parameter := range spec.Parameters {
		value, supplied := raw[parameter.Key]
		if err := applyPresetWorkflowInput(&inputs, parameter, value, supplied); err != nil {
			return presetWorkflowInputs{}, err
		}
	}
	targets := []string{}
	switch spec.Target {
	case "circle":
		targets = splitPresetWorkflowTargets(inputs.CircleID, normalizeMakerID)
		for _, circleID := range targets {
			if !dlsiteMakerIDPattern.MatchString(circleID) {
				return presetWorkflowInputs{}, fmt.Errorf("circleId must list DLsite circle ids such as RG12345")
			}
		}
		if len(targets) == 0 {
			return presetWorkflowInputs{}, fmt.Errorf("circleId must list DLsite circle ids such as RG12345")
		}
		inputs.CircleID = joinPresetWorkflowTargets(targets)
	case "series":
		targets = splitPresetWorkflowTargets(inputs.SeriesID, normalizeSeriesID)
		if len(targets) == 0 {
			return presetWorkflowInputs{}, fmt.Errorf("seriesId is required")
		}
		inputs.SeriesID = joinPresetWorkflowTargets(targets)
		// A stored series catalog has no refresh step, so metadata is the run.
		if !inputs.Metadata {
			return presetWorkflowInputs{}, fmt.Errorf("choose at least one action")
		}
	case "voice":
		if inputs.PersonID <= 0 {
			return presetWorkflowInputs{}, fmt.Errorf("personId is required")
		}
		if len(inputs.SourceIDs) == 0 {
			return presetWorkflowInputs{}, fmt.Errorf("sourceIds is required to refresh the catalog")
		}
	}
	// Both release bounds are inclusive; either may be empty to leave that side open.
	if inputs.ReleaseFrom != "" && inputs.ReleaseTo != "" && inputs.ReleaseFrom > inputs.ReleaseTo {
		return presetWorkflowInputs{}, fmt.Errorf("releaseFrom must not be after releaseTo")
	}
	if len(targets) > presetWorkflowMaxTargets {
		return presetWorkflowInputs{}, fmt.Errorf("a preset run supports at most %d targets", presetWorkflowMaxTargets)
	}
	if !inputs.Metadata {
		// The filter narrows the works whose metadata syncs, and tagging applies
		// to those works, so both are meaningless without the metadata action.
		inputs.ReleaseFrom, inputs.ReleaseTo, inputs.MaxWorks, inputs.TagNameTemplate = "", "", 0, ""
	}
	return inputs, nil
}

func applyPresetWorkflowInput(inputs *presetWorkflowInputs, parameter presetWorkflowParameter, value any, supplied bool) error {
	switch parameter.Kind {
	case "boolean":
		if !supplied || value == nil {
			return nil
		}
		enabled, ok := value.(bool)
		if !ok {
			return fmt.Errorf("%s must be true or false", parameter.Key)
		}
		if parameter.Key == "metadata" {
			inputs.Metadata = enabled
		}
	case "voice_person":
		if !supplied || value == nil {
			return nil
		}
		number, ok := graphConfigInteger(value)
		if !ok || number <= 0 {
			return fmt.Errorf("personId must be a voice actor id")
		}
		inputs.PersonID = number
	case "source_ids":
		if !supplied || value == nil {
			return nil
		}
		values, ok := graphIntegerArray(value)
		if !ok {
			return fmt.Errorf("%s must be a list of source ids", parameter.Key)
		}
		ids := []int64{}
		seen := map[int64]bool{}
		for _, id := range values {
			if id <= 0 {
				return fmt.Errorf("%s must be a list of source ids", parameter.Key)
			}
			if !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
		if len(ids) > presetWorkflowMaxTargets {
			return fmt.Errorf("%s supports at most %d sources", parameter.Key, presetWorkflowMaxTargets)
		}
		if parameter.Key == "checkSourceIds" {
			inputs.CheckSourceIDs = ids
		} else {
			inputs.SourceIDs = ids
		}
	case "circle_id", "series_id", "date", "text_template":
		text, err := presetWorkflowText(parameter, value, supplied)
		if err != nil {
			return err
		}
		switch parameter.Key {
		case "circleId":
			inputs.CircleID = text
		case "seriesId":
			inputs.SeriesID = text
		case "releaseFrom", "releaseTo":
			if text != "" {
				if _, err := time.Parse("2006-01-02", text); err != nil {
					return fmt.Errorf("%s must use YYYY-MM-DD", parameter.Key)
				}
			}
			if parameter.Key == "releaseFrom" {
				inputs.ReleaseFrom = text
			} else {
				inputs.ReleaseTo = text
			}
		case "tagNameTemplate":
			if supplied {
				inputs.TagNameTemplate = text
			}
		}
	case "select":
		text, err := presetWorkflowText(parameter, value, supplied)
		if err != nil {
			return err
		}
		if text == "" {
			text, _ = parameter.Default.(string)
		}
		text = strings.ToLower(text)
		valid := false
		for _, option := range parameter.Options {
			valid = valid || option == text
		}
		if !valid {
			return fmt.Errorf("%s must be one of %s", parameter.Key, strings.Join(parameter.Options, ", "))
		}
		if parameter.Key == "catalogRefresh" {
			inputs.CatalogRefresh = text
		}
	case "integer":
		if !supplied || value == nil {
			return nil
		}
		number, ok := graphConfigInteger(value)
		if !ok || number < parameter.Minimum || number > parameter.Maximum {
			return fmt.Errorf("%s must be between %d and %d", parameter.Key, parameter.Minimum, parameter.Maximum)
		}
		if parameter.Key == "maxWorks" {
			inputs.MaxWorks = int(number)
		}
	default:
		return fmt.Errorf("unsupported preset parameter kind %s", parameter.Kind)
	}
	return nil
}

func presetWorkflowText(parameter presetWorkflowParameter, value any, supplied bool) (string, error) {
	if !supplied || value == nil {
		if parameter.Required {
			return "", fmt.Errorf("%s is required", parameter.Key)
		}
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be text", parameter.Key)
	}
	text = strings.TrimSpace(text)
	limit := 160
	switch parameter.Kind {
	case "circle_id", "series_id":
		limit = presetWorkflowMaxTargetText
	}
	if len([]rune(text)) > limit {
		return "", fmt.Errorf("%s must be at most %d characters", parameter.Key, limit)
	}
	if parameter.Required && text == "" {
		return "", fmt.Errorf("%s is required", parameter.Key)
	}
	return text, nil
}

func (inputs presetWorkflowInputs) public() map[string]any {
	result := map[string]any{"metadata": inputs.Metadata}
	if inputs.Metadata {
		result["tagNameTemplate"] = inputs.TagNameTemplate
	}
	if inputs.CatalogRefresh != "" {
		result["catalogRefresh"] = inputs.CatalogRefresh
	}
	if inputs.CircleID != "" {
		result["circleId"] = inputs.CircleID
	}
	if inputs.SeriesID != "" {
		result["seriesId"] = inputs.SeriesID
	}
	if inputs.PersonID > 0 {
		result["personId"] = inputs.PersonID
		result["sourceIds"] = append([]int64{}, inputs.SourceIDs...)
	}
	if len(inputs.CheckSourceIDs) > 0 {
		result["checkSourceIds"] = append([]int64{}, inputs.CheckSourceIDs...)
	}
	if inputs.ReleaseFrom != "" {
		result["releaseFrom"] = inputs.ReleaseFrom
	}
	if inputs.ReleaseTo != "" {
		result["releaseTo"] = inputs.ReleaseTo
	}
	if inputs.MaxWorks > 0 {
		result["maxWorks"] = inputs.MaxWorks
	}
	if inputs.KnownMetadata {
		result["knownMetadata"] = true
	}
	return result
}

// buildPresetWorkflowDefinition composes the preset graph:
// discover -> sources, then discover -> filter -> metadata -> tag. The filter
// keeps catalog works that lack metadata; without a work limit it still stops
// at the catalog bound. Every bound is explicit so the graph is valid for both
// manual and automated dispatch.
func buildPresetWorkflowDefinition(spec presetWorkflowSpec, inputs presetWorkflowInputs, tagName string) workflowGraphDefinition {
	requirePreview := true
	definition := workflowGraphDefinition{SchemaVersion: workflowGraphSchemaVersion, Nodes: []workflowGraphNode{}, Edges: []workflowGraphEdge{}, Policy: workflowGraphPolicy{RequirePreview: &requirePreview}}
	addNode := func(id, nodeType, displayName string, config map[string]any) {
		definition.Nodes = append(definition.Nodes, workflowGraphNode{
			ID: id, Type: nodeType, DisplayName: displayName, Config: config,
			Position: workflowGraphPosition{X: float64(len(definition.Nodes)) * 280, Y: 40},
		})
	}
	addEdge := func(source, sourceHandle, target, targetHandle string) {
		definition.Edges = append(definition.Edges, workflowGraphEdge{
			ID: source + "_" + sourceHandle + "_" + target, Source: source, SourceHandle: sourceHandle, Target: target, TargetHandle: targetHandle,
		})
	}
	discover := inputs.Metadata || inputs.CatalogRefresh != "stored"
	switch spec.Target {
	case "circle":
		addNode("discover", "circle_catalog", "Circle catalog", map[string]any{"circleId": inputs.CircleID, "mode": inputs.CatalogRefresh, "maxWorks": presetWorkflowMaxCatalogSize})
		if len(inputs.CheckSourceIDs) > 0 {
			mode := "incremental"
			if inputs.CatalogRefresh == "full" {
				mode = "full"
			}
			addNode("sources", "circle_sources", "Check circle sources", map[string]any{"circleId": inputs.CircleID, "sourceIds": append([]int64{}, inputs.CheckSourceIDs...), "mode": mode})
		}
	case "series":
		addNode("discover", "series_catalog", "Series catalog", map[string]any{"seriesId": inputs.SeriesID, "maxWorks": presetWorkflowMaxCatalogSize})
	case "voice":
		if discover {
			addNode("discover", "voice_catalog", "Voice actor catalog", map[string]any{"personId": inputs.PersonID, "sourceIds": append([]int64{}, inputs.SourceIDs...), "mode": inputs.CatalogRefresh, "maxWorks": presetWorkflowMaxCatalogSize})
		}
		if inputs.KnownMetadata {
			addNode("metadata", "voice_metadata", "Refresh known-work metadata", map[string]any{"personId": inputs.PersonID, "mode": "incremental"})
		}
	}
	if !inputs.Metadata {
		return definition
	}
	limit := inputs.MaxWorks
	if limit <= 0 {
		limit = presetWorkflowMaxCatalogSize
	}
	filterConfig := map[string]any{"existing": "missing_metadata", "limit": limit}
	if inputs.ReleaseFrom != "" {
		filterConfig["releaseFrom"] = inputs.ReleaseFrom
	}
	if inputs.ReleaseTo != "" {
		filterConfig["releaseTo"] = inputs.ReleaseTo
	}
	addNode("filter", "filter_works", "Filter works without metadata", filterConfig)
	addEdge("discover", "works", "filter", "works")
	addNode("action", "metadata_sync", "Sync metadata", map[string]any{"maxWorks": limit})
	addEdge("filter", "accepted", "action", "works")
	if tagName != "" {
		addNode("tag", "tag_works", "Add user tag", map[string]any{"tagName": tagName})
		addEdge("action", "completed", "tag", "works")
	}
	return definition
}

// Trigger integration: presets are system definitions whose startup and
// interval triggers store the configuring user and the validated inputs.

func (s *Server) normalizePresetWorkflowTriggerConfig(ctx context.Context, actor currentUser, spec presetWorkflowSpec, raw string, existing *workflowTriggerRecord, now time.Time) (presetWorkflowTriggerConfig, []string, error) {
	config := presetWorkflowTriggerConfig{Inputs: map[string]any{}}
	if strings.TrimSpace(raw) != "" {
		if err := decodeStrictJSON(raw, &config); err != nil {
			return presetWorkflowTriggerConfig{}, nil, fmt.Errorf("config JSON must contain the preset inputs")
		}
	}
	plan, err := s.planPresetWorkflow(ctx, spec, config.Inputs, now, true)
	if err != nil {
		return presetWorkflowTriggerConfig{}, nil, err
	}
	config.UserID = workflowTriggerOwnerID(actor, existing)
	config.Inputs = plan.Inputs.public()
	return config, plan.Permissions, nil
}

func (s *Server) executePresetSystemTrigger(ctx context.Context, definition workflowDefinitionRecord, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	spec, found := presetWorkflowSpecByCode(definition.Code)
	if !found {
		return "", nil, fmt.Errorf("workflow preset not found")
	}
	var config presetWorkflowTriggerConfig
	if err := decodeStrictJSON(trigger.ConfigJSON, &config); err != nil {
		return "", nil, fmt.Errorf("preset trigger config is invalid")
	}
	plan, err := s.planPresetWorkflow(ctx, spec, config.Inputs, time.Now(), true)
	if err != nil {
		return "", nil, err
	}
	owner, err := s.loadSystemWorkflowTriggerOwner(ctx, config.UserID, plan.Permissions)
	if err != nil {
		return "", nil, err
	}
	_, err = s.enqueueWorkflowGraph(ctx, definition, plan.Graph, owner.ID, owner.Permissions, plan.Inputs.public(), workflowGraphEnqueueOptions{
		TriggerID: trigger.ID, TriggerType: triggerType, TriggerReason: triggerReason, DefinitionJSON: plan.DefinitionJSON,
	})
	return "succeeded", nil, err
}

func uniqueStrings(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}
