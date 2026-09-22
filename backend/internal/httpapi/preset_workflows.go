package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Preset workflows are system-owned, parameterized graphs. Each preset builds a
// fixed typed DAG from a small validated input set and executes it through the
// existing custom-workflow runtime, so node executors, checkpoints, retries, and
// Fetch bounds are shared with that runtime while users never author a graph.

const (
	presetWorkflowMaxWorksLimit  = 100
	presetWorkflowMaxFilesLimit  = 50000
	presetWorkflowMaxGiBLimit    = 2048
	presetWorkflowMinFreeLimit   = 1024
	presetWorkflowDefaultWorks   = 25
	presetWorkflowDefaultFiles   = 10000
	presetWorkflowDefaultGiB     = 100
	presetWorkflowDefaultMinFree = 2
	presetWorkflowMaxExtensions  = 32
	presetWorkflowMaxCatalogSize = 5000
)

var presetWorkflowTagTokens = []string{"date", "target", "action"}

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

type presetWorkflowInputs struct {
	CircleID          string
	SeriesID          string
	VoiceName         string
	SourceID          int64
	CatalogRefresh    string
	Existing          string
	ReleaseFrom       string
	MaxWorks          int
	Action            string
	ExcludeExtensions []string
	MaxFiles          int
	MaxGiB            int64
	MinFreeGiB        int64
	TagNameTemplate   string
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
	Definition     customWorkflowDefinition
	DefinitionJSON string
	Graph          customWorkflowGraph
	Permissions    []string
}

func presetActionParameters() []presetWorkflowParameter {
	return []presetWorkflowParameter{
		{Key: "existing", Kind: "select", Group: "filter", Default: "unknown", Options: []string{"unknown", "any"}},
		{Key: "releaseFrom", Kind: "date", Group: "filter"},
		{Key: "maxWorks", Kind: "integer", Group: "filter", Default: presetWorkflowDefaultWorks, Minimum: 1, Maximum: presetWorkflowMaxWorksLimit},
		{Key: "action", Kind: "select", Group: "action", Default: "metadata", Options: []string{"metadata", "track", "fetch"}},
		{Key: "sourceId", Kind: "source_id", Group: "action"},
		{Key: "excludeExtensions", Kind: "extensions", Group: "fetch"},
		{Key: "maxFiles", Kind: "integer", Group: "fetch", Default: presetWorkflowDefaultFiles, Minimum: 1, Maximum: presetWorkflowMaxFilesLimit},
		{Key: "maxGiB", Kind: "integer", Group: "fetch", Default: presetWorkflowDefaultGiB, Minimum: 1, Maximum: presetWorkflowMaxGiBLimit},
		{Key: "minFreeGiB", Kind: "integer", Group: "fetch", Default: presetWorkflowDefaultMinFree, Minimum: 1, Maximum: presetWorkflowMinFreeLimit},
		{Key: "tagNameTemplate", Kind: "text_template", Group: "tag", Tokens: presetWorkflowTagTokens},
	}
}

var presetWorkflowSpecs = []presetWorkflowSpec{
	{
		Code:               "circle_follow",
		DisplayName:        "Follow a circle",
		Description:        "Read a circle catalog, filter new works, then synchronize metadata, track, or fetch them and append a user tag.",
		Target:             "circle",
		DefaultTagTemplate: "{date}_circle_{target}",
		Parameters: append([]presetWorkflowParameter{
			{Key: "circleId", Kind: "circle_id", Group: "target", Required: true},
			{Key: "catalogRefresh", Kind: "select", Group: "target", Default: "incremental", Options: []string{"stored", "incremental", "full"}},
		}, presetActionParameters()...),
		DisplayNodes: []map[string]string{
			{"id": "discover", "type": "circle_catalog", "displayName": "Circle catalog"},
			{"id": "filter", "type": "filter_works", "displayName": "Filter new works"},
			{"id": "action", "type": "track_works", "displayName": "Sync, track, or fetch"},
			{"id": "tag", "type": "tag_works", "displayName": "Add user tag"},
		},
	},
	{
		Code:               "series_follow",
		DisplayName:        "Follow a series",
		Description:        "Read the stored works of a provider series, filter new works, then synchronize metadata, track, or fetch them and append a user tag.",
		Target:             "series",
		DefaultTagTemplate: "{date}_series_{target}",
		Parameters: append([]presetWorkflowParameter{
			{Key: "seriesId", Kind: "series_id", Group: "target", Required: true},
		}, presetActionParameters()...),
		DisplayNodes: []map[string]string{
			{"id": "discover", "type": "series_catalog", "displayName": "Series catalog"},
			{"id": "filter", "type": "filter_works", "displayName": "Filter new works"},
			{"id": "action", "type": "track_works", "displayName": "Sync, track, or fetch"},
			{"id": "tag", "type": "tag_works", "displayName": "Add user tag"},
		},
	},
	{
		Code:               "voice_follow",
		DisplayName:        "Follow a voice actor",
		Description:        "Search one compatible remote source for a voice actor, filter new works, then synchronize metadata, track, or fetch them and append a user tag.",
		Target:             "voice",
		DefaultTagTemplate: "{date}_voice_{target}",
		Parameters: append([]presetWorkflowParameter{
			{Key: "voiceName", Kind: "voice_name", Group: "target", Required: true},
			{Key: "sourceId", Kind: "source_id", Group: "target", Required: true},
		}, filterPresetParameters(presetActionParameters(), "sourceId")...),
		DisplayNodes: []map[string]string{
			{"id": "discover", "type": "voice_source_works", "displayName": "Voice works from source"},
			{"id": "filter", "type": "filter_works", "displayName": "Filter new works"},
			{"id": "action", "type": "track_works", "displayName": "Sync, track, or fetch"},
			{"id": "tag", "type": "tag_works", "displayName": "Add user tag"},
		},
	},
}

func filterPresetParameters(parameters []presetWorkflowParameter, excludedKeys ...string) []presetWorkflowParameter {
	excluded := map[string]bool{}
	for _, key := range excludedKeys {
		excluded[key] = true
	}
	result := make([]presetWorkflowParameter, 0, len(parameters))
	for _, parameter := range parameters {
		if !excluded[parameter.Key] {
			result = append(result, parameter)
		}
	}
	return result
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
	if missing := missingCustomWorkflowPermission(actor.Permissions, plan.Permissions); missing != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied", "permission": missing})
		return
	}
	definition, err := s.loadWorkflowDefinitionByCode(r.Context(), spec.Code)
	if err != nil {
		writeError(w, err)
		return
	}
	runID, err := s.enqueueCustomWorkflow(r.Context(), definition, plan.Graph, actor.ID, actor.Permissions, plan.Inputs.public(), "", customWorkflowEnqueueOptions{
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

// planPresetWorkflow validates inputs, checks the configured source, renders
// the tag template for this dispatch, and builds the validated typed graph.
func (s *Server) planPresetWorkflow(ctx context.Context, spec presetWorkflowSpec, raw map[string]any, now time.Time, automated bool) (presetWorkflowPlan, error) {
	inputs, err := normalizePresetWorkflowInputs(spec, raw)
	if err != nil {
		return presetWorkflowPlan{}, err
	}
	if automated && inputs.CatalogRefresh == "full" {
		return presetWorkflowPlan{}, fmt.Errorf("automated runs support stored or incremental catalog refresh only")
	}
	if inputs.SourceID > 0 {
		if err := s.validatePresetWorkflowSource(ctx, inputs.SourceID); err != nil {
			return presetWorkflowPlan{}, err
		}
	}
	tagName := ""
	if inputs.TagNameTemplate != "" {
		tagName, err = renderWorkflowTagNameTemplate(inputs.TagNameTemplate, presetWorkflowTagValues(spec, inputs, now))
		if err != nil {
			return presetWorkflowPlan{}, err
		}
	}
	definition := buildPresetWorkflowDefinition(spec, inputs, tagName)
	encoded, err := json.Marshal(definition)
	if err != nil {
		return presetWorkflowPlan{}, err
	}
	graph, err := validateCustomWorkflowDefinition(string(encoded))
	if err != nil {
		return presetWorkflowPlan{}, fmt.Errorf("preset workflow graph is invalid: %w", err)
	}
	permissions := append([]string{"workflows:run"}, customWorkflowRequiredPermissions(graph)...)
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
	return map[string]string{
		"date": now.UTC().Format("060102"), "target": workflowTagFragment(target), "action": inputs.Action,
	}
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
		if !allowed[key] {
			return presetWorkflowInputs{}, fmt.Errorf("unknown preset input %s", key)
		}
	}
	inputs := presetWorkflowInputs{
		CatalogRefresh: "incremental", Existing: "unknown", MaxWorks: presetWorkflowDefaultWorks, Action: "metadata",
		MaxFiles: presetWorkflowDefaultFiles, MaxGiB: presetWorkflowDefaultGiB, MinFreeGiB: presetWorkflowDefaultMinFree,
		TagNameTemplate: spec.DefaultTagTemplate,
	}
	for _, parameter := range spec.Parameters {
		value, supplied := raw[parameter.Key]
		if err := applyPresetWorkflowInput(&inputs, parameter, value, supplied); err != nil {
			return presetWorkflowInputs{}, err
		}
	}
	switch spec.Target {
	case "circle":
		if !dlsiteMakerIDPattern.MatchString(inputs.CircleID) {
			return presetWorkflowInputs{}, fmt.Errorf("circleId must be a DLsite circle id such as RG12345")
		}
	case "series":
		if inputs.SeriesID == "" {
			return presetWorkflowInputs{}, fmt.Errorf("seriesId is required")
		}
	case "voice":
		if inputs.VoiceName == "" || isUnknownVoiceActorName(inputs.VoiceName) {
			return presetWorkflowInputs{}, fmt.Errorf("voiceName is required")
		}
		if inputs.SourceID <= 0 {
			return presetWorkflowInputs{}, fmt.Errorf("sourceId is required")
		}
	}
	if inputs.Action != "metadata" && inputs.SourceID <= 0 {
		return presetWorkflowInputs{}, fmt.Errorf("sourceId is required for %s", inputs.Action)
	}
	if inputs.Action != "fetch" {
		inputs.ExcludeExtensions = nil
		inputs.MaxFiles = presetWorkflowDefaultFiles
		inputs.MaxGiB = presetWorkflowDefaultGiB
		inputs.MinFreeGiB = presetWorkflowDefaultMinFree
	}
	return inputs, nil
}

func applyPresetWorkflowInput(inputs *presetWorkflowInputs, parameter presetWorkflowParameter, value any, supplied bool) error {
	switch parameter.Kind {
	case "circle_id", "series_id", "voice_name", "date", "text_template":
		text, err := presetWorkflowText(parameter, value, supplied)
		if err != nil {
			return err
		}
		switch parameter.Key {
		case "circleId":
			inputs.CircleID = normalizeMakerID(text)
		case "seriesId":
			inputs.SeriesID = strings.ToUpper(text)
		case "voiceName":
			inputs.VoiceName = text
		case "releaseFrom":
			if text != "" {
				if _, err := time.Parse("2006-01-02", text); err != nil {
					return fmt.Errorf("releaseFrom must use YYYY-MM-DD")
				}
			}
			inputs.ReleaseFrom = text
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
		switch parameter.Key {
		case "catalogRefresh":
			inputs.CatalogRefresh = text
		case "existing":
			inputs.Existing = text
		case "action":
			inputs.Action = text
		}
	case "source_id":
		if !supplied || value == nil {
			return nil
		}
		number, ok := customConfigInteger(value)
		if !ok || number < 0 {
			return fmt.Errorf("sourceId must be a source id")
		}
		inputs.SourceID = number
	case "integer":
		if !supplied || value == nil {
			return nil
		}
		number, ok := customConfigInteger(value)
		if !ok || number < parameter.Minimum || number > parameter.Maximum {
			return fmt.Errorf("%s must be between %d and %d", parameter.Key, parameter.Minimum, parameter.Maximum)
		}
		switch parameter.Key {
		case "maxWorks":
			inputs.MaxWorks = int(number)
		case "maxFiles":
			inputs.MaxFiles = int(number)
		case "maxGiB":
			inputs.MaxGiB = number
		case "minFreeGiB":
			inputs.MinFreeGiB = number
		}
	case "extensions":
		if !supplied || value == nil {
			return nil
		}
		values, err := customStringValues(value)
		if err != nil {
			return fmt.Errorf("excludeExtensions must be a list of file extensions")
		}
		extensions := []string{}
		for _, extension := range values {
			extension = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(extension), "."))
			if extension == "" {
				continue
			}
			if len(extension) > 16 || strings.ContainsAny(extension, `/\`) {
				return fmt.Errorf("excludeExtensions contains an invalid extension")
			}
			extensions = append(extensions, extension)
		}
		if len(extensions) > presetWorkflowMaxExtensions {
			return fmt.Errorf("excludeExtensions supports at most %d extensions", presetWorkflowMaxExtensions)
		}
		inputs.ExcludeExtensions = uniqueStrings(extensions)
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
	if len([]rune(text)) > 160 {
		return "", fmt.Errorf("%s must be at most 160 characters", parameter.Key)
	}
	if parameter.Required && text == "" {
		return "", fmt.Errorf("%s is required", parameter.Key)
	}
	return text, nil
}

func (inputs presetWorkflowInputs) public() map[string]any {
	result := map[string]any{
		"existing": inputs.Existing, "maxWorks": inputs.MaxWorks, "action": inputs.Action, "tagNameTemplate": inputs.TagNameTemplate,
	}
	if inputs.CircleID != "" {
		result["circleId"] = inputs.CircleID
		result["catalogRefresh"] = inputs.CatalogRefresh
	}
	if inputs.SeriesID != "" {
		result["seriesId"] = inputs.SeriesID
	}
	if inputs.VoiceName != "" {
		result["voiceName"] = inputs.VoiceName
	}
	if inputs.SourceID > 0 {
		result["sourceId"] = inputs.SourceID
	}
	if inputs.ReleaseFrom != "" {
		result["releaseFrom"] = inputs.ReleaseFrom
	}
	if inputs.Action == "fetch" {
		result["excludeExtensions"] = append([]string{}, inputs.ExcludeExtensions...)
		result["maxFiles"] = inputs.MaxFiles
		result["maxGiB"] = inputs.MaxGiB
		result["minFreeGiB"] = inputs.MinFreeGiB
	}
	return result
}

// buildPresetWorkflowDefinition composes the fixed discover -> filter -> action
// -> tag graph. Every bound is explicit so the graph is valid for both manual
// and automated dispatch; the policy flag only keeps catalog refresh available.
func buildPresetWorkflowDefinition(spec presetWorkflowSpec, inputs presetWorkflowInputs, tagName string) customWorkflowDefinition {
	requirePreview := true
	definition := customWorkflowDefinition{SchemaVersion: customWorkflowSchemaVersion, Nodes: []customWorkflowNode{}, Edges: []customWorkflowEdge{}, Policy: customWorkflowPolicy{RequirePreview: &requirePreview}}
	addNode := func(id, nodeType, displayName string, config map[string]any) {
		definition.Nodes = append(definition.Nodes, customWorkflowNode{
			ID: id, Type: nodeType, DisplayName: displayName, Config: config,
			Position: customWorkflowPosition{X: float64(len(definition.Nodes)) * 280, Y: 40},
		})
	}
	addEdge := func(source, sourceHandle, target, targetHandle string) {
		definition.Edges = append(definition.Edges, customWorkflowEdge{
			ID: source + "_" + sourceHandle + "_" + target, Source: source, SourceHandle: sourceHandle, Target: target, TargetHandle: targetHandle,
		})
	}
	switch spec.Target {
	case "circle":
		addNode("discover", "circle_catalog", "Circle catalog", map[string]any{"circleId": inputs.CircleID, "mode": inputs.CatalogRefresh, "maxWorks": presetWorkflowMaxCatalogSize})
	case "series":
		addNode("discover", "series_catalog", "Series catalog", map[string]any{"seriesId": inputs.SeriesID, "maxWorks": presetWorkflowMaxCatalogSize})
	case "voice":
		addNode("discover", "voice_source_works", "Voice works from source", map[string]any{"voiceName": inputs.VoiceName, "sourceId": inputs.SourceID, "pageSize": 48, "maxPages": 42, "maxWorks": 2000})
	}
	filterConfig := map[string]any{"existing": inputs.Existing, "limit": inputs.MaxWorks}
	if inputs.ReleaseFrom != "" {
		filterConfig["releaseFrom"] = inputs.ReleaseFrom
	}
	addNode("filter", "filter_works", "Filter new works", filterConfig)
	addEdge("discover", "works", "filter", "works")
	switch inputs.Action {
	case "track":
		addNode("action", "track_works", "Track works", map[string]any{"sourceId": inputs.SourceID, "maxWorks": inputs.MaxWorks})
	case "fetch":
		addNode("action", "fetch_works", "Fetch works", map[string]any{
			"sourceId": inputs.SourceID, "maxWorks": inputs.MaxWorks, "maxFiles": inputs.MaxFiles,
			"maxBytes": inputs.MaxGiB * 1024 * 1024 * 1024, "minFreeBytes": inputs.MinFreeGiB * 1024 * 1024 * 1024,
			"allowUnknownSizes": false, "excludeExtensions": append([]string{}, inputs.ExcludeExtensions...),
		})
	default:
		addNode("action", "metadata_sync", "Sync metadata", map[string]any{"maxWorks": inputs.MaxWorks})
	}
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
	_, err = s.enqueueCustomWorkflow(ctx, definition, plan.Graph, owner.ID, owner.Permissions, plan.Inputs.public(), "", customWorkflowEnqueueOptions{
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
