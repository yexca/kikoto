package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const customWorkflowSchemaVersion = 2

var (
	customWorkflowIDPattern       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	customWorkflowWorkCodePattern = regexp.MustCompile(`(?i)^(RJ|BJ|VJ|CC)[0-9]{5,8}$`)
)

type customWorkflowDefinition struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Nodes         []customWorkflowNode `json:"nodes"`
	Edges         []customWorkflowEdge `json:"edges"`
	Policy        customWorkflowPolicy `json:"policy,omitempty"`
}

type customWorkflowPolicy struct {
	RequirePreview *bool `json:"requirePreview,omitempty"`
}

type customWorkflowNode struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	DisplayName string                 `json:"displayName"`
	Config      map[string]any         `json:"config"`
	Position    customWorkflowPosition `json:"position"`
}

type customWorkflowPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type customWorkflowEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	SourceHandle string `json:"sourceHandle"`
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
}

type customWorkflowGraph struct {
	Definition       customWorkflowDefinition
	NodesByID        map[string]customWorkflowNode
	IncomingByNode   map[string][]customWorkflowEdge
	TopologicalOrder []string
}

type customWorkflowEdgeState struct {
	edgeIDs     map[string]bool
	targetPorts map[string]bool
	incoming    map[string][]customWorkflowEdge
	adjacency   map[string][]string
	indegree    map[string]int
}

type customWorkflowRunGraph struct {
	SchemaVersion int                          `json:"schemaVersion"`
	Nodes         []customWorkflowRunGraphNode `json:"nodes"`
	Edges         []customWorkflowRunGraphEdge `json:"edges"`
}

type customWorkflowRunGraphNode struct {
	ID          string                       `json:"id"`
	Type        string                       `json:"type"`
	DisplayName string                       `json:"displayName"`
	Position    customWorkflowPosition       `json:"position"`
	Inputs      []customWorkflowRunGraphPort `json:"inputs"`
	Outputs     []customWorkflowRunGraphPort `json:"outputs"`
}

type customWorkflowRunGraphPort struct {
	ID       string `json:"id"`
	DataType string `json:"dataType"`
}

type customWorkflowRunGraphEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	SourceHandle string `json:"sourceHandle"`
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
	DataType     string `json:"dataType"`
}

type customWorkflowPort struct {
	ID       string
	DataType string
	Required bool
}

type customWorkflowCapability struct {
	Type        string
	Phase       string
	DisplayName string
	Description string
	Inputs      []customWorkflowPort
	Outputs     []customWorkflowPort
	Permissions []string
	Composite   bool
	ConfigKeys  []string
}

var customWorkflowCapabilities = map[string]customWorkflowCapability{
	"circle_catalog": {
		Type: "circle_catalog", Phase: "discover", DisplayName: "Circle catalog",
		Description: "Read or refresh a circle catalog without materializing every discovered work.",
		Inputs:      []customWorkflowPort{{ID: "circle", DataType: "circle_id", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "works", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"circleId", "mode", "maxWorks"},
	},
	"series_catalog": {
		Type: "series_catalog", Phase: "discover", DisplayName: "Series catalog",
		Description: "Read stored work codes for one provider series without creating works.",
		Inputs:      []customWorkflowPort{{ID: "series", DataType: "series_id", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "works", DataType: "work_candidates"}}, Composite: true,
		ConfigKeys: []string{"seriesId", "circleExternalId", "maxWorks"},
	},
	"voice_source_works": {
		Type: "voice_source_works", Phase: "discover", DisplayName: "Voice works from source",
		Description: "Page through one compatible remote source for a voice actor without importing results.",
		Inputs:      []customWorkflowPort{{ID: "voice", DataType: "voice_name", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "works", DataType: "work_candidates"}},
		Permissions: []string{"library:read"}, Composite: true, ConfigKeys: []string{"voiceName", "sourceId", "pageSize", "maxPages", "maxWorks"},
	},
	"filter_works": {
		Type: "filter_works", Phase: "filter", DisplayName: "Filter works",
		Description: "Apply bounded, structured filters to work candidates.",
		Inputs:      []customWorkflowPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "accepted", DataType: "work_candidates"}, {ID: "rejected", DataType: "work_candidates"}},
		ConfigKeys:  []string{"limit", "codePrefix", "existing", "releaseFrom", "releaseTo", "voiceNames", "metadataTags", "userTags"},
	},
	"metadata_sync": {
		Type: "metadata_sync", Phase: "commit", DisplayName: "Sync metadata",
		Description: "Materialize accepted candidates and synchronize normalized provider metadata.",
		Inputs:      []customWorkflowPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"maxWorks"},
	},
	"track_works": {
		Type: "track_works", Phase: "execute", DisplayName: "Track works",
		Description: "Track available source works through the existing remote sync domain operation.",
		Inputs:      []customWorkflowPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"sourceId", "maxWorks"},
	},
	"fetch_works": {
		Type: "fetch_works", Phase: "execute", DisplayName: "Fetch works",
		Description: "Queue the existing recoverable Fetch transaction for bounded, filtered remote files.",
		Inputs:      []customWorkflowPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"downloads:manage"}, Composite: true,
		ConfigKeys: []string{"sourceId", "excludeExtensions", "maxWorks", "maxFiles", "maxBytes", "minFreeBytes", "allowUnknownSizes", "targetRoot"},
	},
	"tag_works": {
		Type: "tag_works", Phase: "commit", DisplayName: "Tag works",
		Description: "Assign a user-owned tag to works materialized by prior actions.",
		Inputs:      []customWorkflowPort{{ID: "works", DataType: "work_refs", Required: true}, {ID: "tag", DataType: "text"}},
		Outputs:     []customWorkflowPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_refs"}},
		Permissions: []string{"tags:write"}, Composite: true, ConfigKeys: []string{"tagName"},
	},
}

func customPortLabel(id string) string {
	label := strings.ReplaceAll(strings.TrimSpace(id), "_", " ")
	if label == "" {
		return "Value"
	}
	return strings.ToUpper(label[:1]) + label[1:]
}

func validateCustomWorkflowDefinition(raw string) (customWorkflowGraph, error) {
	definition, err := parseCustomWorkflowDefinition(raw)
	if err != nil {
		return customWorkflowGraph{}, err
	}
	requiresPreview := customWorkflowRequiresPreview(definition)
	nodesByID, nodeOrder, err := validateCustomWorkflowNodes(&definition, requiresPreview)
	if err != nil {
		return customWorkflowGraph{}, err
	}
	edges, err := validateCustomWorkflowEdges(&definition, nodesByID)
	if err != nil {
		return customWorkflowGraph{}, err
	}
	if err := validateCustomWorkflowRequiredInputs(definition, edges.targetPorts); err != nil {
		return customWorkflowGraph{}, err
	}
	topological, err := customWorkflowTopologicalOrder(nodesByID, edges.adjacency, edges.indegree, nodeOrder)
	if err != nil {
		return customWorkflowGraph{}, err
	}
	return customWorkflowGraph{
		Definition:       definition,
		NodesByID:        nodesByID,
		IncomingByNode:   edges.incoming,
		TopologicalOrder: topological,
	}, nil
}

func parseCustomWorkflowDefinition(raw string) (customWorkflowDefinition, error) {
	var definition customWorkflowDefinition
	if err := json.Unmarshal([]byte(raw), &definition); err != nil {
		return customWorkflowDefinition{}, fmt.Errorf("definition JSON is invalid")
	}
	if definition.SchemaVersion != customWorkflowSchemaVersion {
		return customWorkflowDefinition{}, fmt.Errorf("custom workflow schemaVersion must be 2")
	}
	if len(definition.Nodes) == 0 || len(definition.Nodes) > 100 {
		return customWorkflowDefinition{}, fmt.Errorf("custom workflow needs 1-100 nodes")
	}
	if len(definition.Edges) > 300 {
		return customWorkflowDefinition{}, fmt.Errorf("custom workflow supports at most 300 edges")
	}
	return definition, nil
}

func validateCustomWorkflowNodes(
	definition *customWorkflowDefinition,
	requiresPreview bool,
) (map[string]customWorkflowNode, map[string]int, error) {
	nodesByID := make(map[string]customWorkflowNode, len(definition.Nodes))
	nodeOrder := make(map[string]int, len(definition.Nodes))
	for index := range definition.Nodes {
		node := &definition.Nodes[index]
		node.ID = strings.TrimSpace(node.ID)
		node.Type = strings.TrimSpace(node.Type)
		node.DisplayName = strings.TrimSpace(node.DisplayName)
		if !customWorkflowIDPattern.MatchString(node.ID) {
			return nil, nil, fmt.Errorf("invalid node id: %s", node.ID)
		}
		if _, exists := nodesByID[node.ID]; exists {
			return nil, nil, fmt.Errorf("node id must be unique: %s", node.ID)
		}
		capability, exists := customWorkflowCapabilities[node.Type]
		if !exists {
			return nil, nil, fmt.Errorf("unsupported executable node type: %s", node.Type)
		}
		if node.DisplayName == "" {
			node.DisplayName = capability.DisplayName
		}
		if node.Config == nil {
			node.Config = map[string]any{}
		}
		if math.IsNaN(node.Position.X) || math.IsInf(node.Position.X, 0) || math.IsNaN(node.Position.Y) || math.IsInf(node.Position.Y, 0) {
			return nil, nil, fmt.Errorf("node position must be finite: %s", node.ID)
		}
		if err := validateCustomWorkflowNodeConfig(*node, requiresPreview); err != nil {
			return nil, nil, err
		}
		nodesByID[node.ID] = *node
		nodeOrder[node.ID] = index
	}
	return nodesByID, nodeOrder, nil
}

func validateCustomWorkflowEdges(
	definition *customWorkflowDefinition,
	nodesByID map[string]customWorkflowNode,
) (customWorkflowEdgeState, error) {
	state := customWorkflowEdgeState{
		edgeIDs:     map[string]bool{},
		targetPorts: map[string]bool{},
		incoming:    map[string][]customWorkflowEdge{},
		adjacency:   map[string][]string{},
		indegree:    map[string]int{},
	}
	for nodeID := range nodesByID {
		state.indegree[nodeID] = 0
	}
	for index := range definition.Edges {
		if err := validateCustomWorkflowEdge(&definition.Edges[index], nodesByID, &state); err != nil {
			return customWorkflowEdgeState{}, err
		}
	}
	return state, nil
}

func validateCustomWorkflowEdge(
	edge *customWorkflowEdge,
	nodesByID map[string]customWorkflowNode,
	state *customWorkflowEdgeState,
) error {
	edge.Source = strings.TrimSpace(edge.Source)
	edge.Target = strings.TrimSpace(edge.Target)
	edge.SourceHandle = strings.TrimSpace(edge.SourceHandle)
	edge.TargetHandle = strings.TrimSpace(edge.TargetHandle)
	source, sourceExists := nodesByID[edge.Source]
	target, targetExists := nodesByID[edge.Target]
	if !sourceExists || !targetExists {
		return fmt.Errorf("edge references an unknown node")
	}
	if edge.Source == edge.Target {
		return fmt.Errorf("node cannot connect to itself: %s", edge.Source)
	}
	sourcePorts := customNodeOutputPorts(source)
	targetPortsForNode := customNodeInputPorts(target)
	if edge.SourceHandle == "" && len(sourcePorts) == 1 {
		edge.SourceHandle = sourcePorts[0].ID
	}
	if edge.TargetHandle == "" && len(targetPortsForNode) == 1 {
		edge.TargetHandle = targetPortsForNode[0].ID
	}
	sourcePort, ok := findCustomPort(sourcePorts, edge.SourceHandle)
	if !ok {
		return fmt.Errorf("unknown output port %s.%s", edge.Source, edge.SourceHandle)
	}
	targetPort, ok := findCustomPort(targetPortsForNode, edge.TargetHandle)
	if !ok {
		return fmt.Errorf("unknown input port %s.%s", edge.Target, edge.TargetHandle)
	}
	if sourcePort.DataType != targetPort.DataType {
		return fmt.Errorf("incompatible edge %s.%s (%s) -> %s.%s (%s)", edge.Source, edge.SourceHandle, sourcePort.DataType, edge.Target, edge.TargetHandle, targetPort.DataType)
	}
	portKey := edge.Target + ":" + edge.TargetHandle
	if state.targetPorts[portKey] {
		return fmt.Errorf("input port has more than one edge: %s.%s", edge.Target, edge.TargetHandle)
	}
	state.targetPorts[portKey] = true
	if strings.TrimSpace(edge.ID) == "" {
		edge.ID = fmt.Sprintf("%s_%s_%s_%s", edge.Source, edge.SourceHandle, edge.Target, edge.TargetHandle)
	}
	if state.edgeIDs[edge.ID] {
		return fmt.Errorf("edge id must be unique: %s", edge.ID)
	}
	state.edgeIDs[edge.ID] = true
	state.incoming[edge.Target] = append(state.incoming[edge.Target], *edge)
	state.adjacency[edge.Source] = append(state.adjacency[edge.Source], edge.Target)
	state.indegree[edge.Target]++
	return nil
}

func validateCustomWorkflowRequiredInputs(definition customWorkflowDefinition, targetPorts map[string]bool) error {
	for _, node := range definition.Nodes {
		for _, port := range customNodeInputPorts(node) {
			if port.Required && !targetPorts[node.ID+":"+port.ID] && !customNodeConfigSuppliesPort(node, port.ID) {
				return fmt.Errorf("required input is not connected: %s.%s", node.ID, port.ID)
			}
		}
	}
	return nil
}

func customWorkflowTopologicalOrder(
	nodesByID map[string]customWorkflowNode,
	adjacency map[string][]string,
	indegree map[string]int,
	nodeOrder map[string]int,
) ([]string, error) {
	ready := []string{}
	for nodeID, degree := range indegree {
		if degree == 0 {
			ready = append(ready, nodeID)
		}
	}
	sort.Slice(ready, func(i, j int) bool { return nodeOrder[ready[i]] < nodeOrder[ready[j]] })
	topological := make([]string, 0, len(nodesByID))
	for len(ready) > 0 {
		nodeID := ready[0]
		ready = ready[1:]
		topological = append(topological, nodeID)
		for _, targetID := range adjacency[nodeID] {
			indegree[targetID]--
			if indegree[targetID] == 0 {
				ready = append(ready, targetID)
				sort.Slice(ready, func(i, j int) bool { return nodeOrder[ready[i]] < nodeOrder[ready[j]] })
			}
		}
	}
	if len(topological) != len(nodesByID) {
		return nil, fmt.Errorf("workflow graph must be acyclic")
	}
	return topological, nil
}

func customWorkflowRequiresPreview(definition customWorkflowDefinition) bool {
	return definition.Policy.RequirePreview == nil || *definition.Policy.RequirePreview
}

type customWorkflowNodeConfigValidator func(customWorkflowNode, bool) error

var customWorkflowNodeConfigValidators = map[string]customWorkflowNodeConfigValidator{
	"circle_catalog":     validateCustomCircleCatalogConfig,
	"series_catalog":     validateCustomSeriesCatalogConfig,
	"voice_source_works": validateCustomVoiceSourceWorksConfig,
	"filter_works":       validateCustomFilterWorksConfig,
	"metadata_sync":      validateCustomMetadataSyncConfig,
	"track_works":        validateCustomTrackWorksConfig,
	"fetch_works":        validateCustomFetchWorksConfig,
	"tag_works":          validateCustomTagWorksConfig,
}

func validateCustomWorkflowNodeConfig(node customWorkflowNode, requiresPreview bool) error {
	if err := validateCustomWorkflowConfigKeys(node); err != nil {
		return err
	}
	if err := validateCustomWorkflowConfigTypes(node); err != nil {
		return err
	}
	validator := customWorkflowNodeConfigValidators[node.Type]
	if validator == nil {
		return nil
	}
	return validator(node, requiresPreview)
}

func validateCustomWorkflowConfigKeys(node customWorkflowNode) error {
	capability := customWorkflowCapabilities[node.Type]
	allowedKeys := make(map[string]bool, len(capability.ConfigKeys))
	for _, key := range capability.ConfigKeys {
		allowedKeys[key] = true
	}
	for key := range node.Config {
		if !allowedKeys[key] {
			return fmt.Errorf("node %s has unsupported config key: %s", node.ID, key)
		}
	}
	return nil
}

func validateCustomWorkflowBound(node customWorkflowNode, key string, fallback, maximum int64, required bool) error {
	raw, explicit := node.Config[key]
	value := fallback
	if explicit {
		var valid bool
		value, valid = customConfigInteger(raw)
		if !valid {
			return fmt.Errorf("node %s config %s must be an integer", node.ID, key)
		}
	}
	if (required && !explicit) || value <= 0 || value > maximum {
		return fmt.Errorf("node %s requires %s between 1 and %d", node.ID, key, maximum)
	}
	return nil
}

func validateCustomPositiveConfigID(node customWorkflowNode, key string) error {
	value, ok := customConfigInteger(node.Config[key])
	if !ok || value <= 0 || value > math.MaxInt32 {
		return fmt.Errorf("node %s requires a %s", node.ID, key)
	}
	return nil
}

func validateCustomCircleCatalogConfig(node customWorkflowNode, requiresPreview bool) error {
	mode := strings.ToLower(configString(node.Config, "mode"))
	if mode == "" {
		mode = "stored"
	}
	if mode != "stored" && mode != "incremental" && mode != "full" {
		return fmt.Errorf("node %s has invalid catalog mode", node.ID)
	}
	if !requiresPreview && mode != "stored" {
		return fmt.Errorf("node %s catalog refresh mode %s requires preview", node.ID, mode)
	}
	return validateCustomWorkflowBound(node, "maxWorks", 100, 5000, !requiresPreview)
}

func validateCustomSeriesCatalogConfig(node customWorkflowNode, requiresPreview bool) error {
	return validateCustomWorkflowBound(node, "maxWorks", 100, 5000, !requiresPreview)
}

func validateCustomVoiceSourceWorksConfig(node customWorkflowNode, requiresPreview bool) error {
	if err := validateCustomPositiveConfigID(node, "sourceId"); err != nil {
		return err
	}
	if err := validateCustomWorkflowBound(node, "maxWorks", 100, 2000, !requiresPreview); err != nil {
		return err
	}
	if err := validateCustomWorkflowBound(node, "maxPages", 10, 100, !requiresPreview); err != nil {
		return err
	}
	return validateCustomWorkflowBound(node, "pageSize", 48, 100, false)
}

func validateCustomFilterWorksConfig(node customWorkflowNode, _ bool) error {
	if err := validateCustomWorkFilterConfig(node); err != nil {
		return err
	}
	existing := strings.ToLower(configString(node.Config, "existing"))
	if node.Type == "filter_works" && existing != "" && existing != "any" && existing != "known" && existing != "unknown" {
		return fmt.Errorf("node %s has invalid existing filter", node.ID)
	}
	if _, configured := node.Config["limit"]; configured {
		return validateCustomWorkflowBound(node, "limit", 100, 5000, false)
	}
	return nil
}

func validateCustomMetadataSyncConfig(node customWorkflowNode, requiresPreview bool) error {
	return validateCustomWorkflowBound(node, "maxWorks", 25, 500, !requiresPreview)
}

func validateCustomTrackWorksConfig(node customWorkflowNode, requiresPreview bool) error {
	return validateCustomWorkflowBound(node, "maxWorks", 25, 500, !requiresPreview)
}

func validateCustomFetchWorksConfig(node customWorkflowNode, requiresPreview bool) error {
	requireBound := !requiresPreview
	if err := validateCustomWorkflowBound(node, "maxWorks", 25, 100, requireBound); err != nil {
		return err
	}
	if err := validateCustomWorkflowBound(node, "maxFiles", 10000, 50000, requireBound); err != nil {
		return err
	}
	if err := validateCustomWorkflowBound(node, "maxBytes", 100*1024*1024*1024, 2*1024*1024*1024*1024, requireBound); err != nil {
		return err
	}
	if _, configured := node.Config["minFreeBytes"]; configured || requireBound {
		if err := validateCustomWorkflowBound(node, "minFreeBytes", 2*1024*1024*1024, 1024*1024*1024*1024, requireBound); err != nil {
			return err
		}
	}
	_, unknownSizePolicySet := node.Config["allowUnknownSizes"]
	if !requiresPreview && (!unknownSizePolicySet || configBool(node.Config, "allowUnknownSizes", false)) {
		return fmt.Errorf("node %s requires allowUnknownSizes=false when preview is disabled", node.ID)
	}
	return nil
}

func validateCustomTagWorksConfig(node customWorkflowNode, _ bool) error {
	if tagName := configString(node.Config, "tagName"); len([]rune(tagName)) > 40 {
		return fmt.Errorf("node %s tagName is too long", node.ID)
	}
	return nil
}

type customWorkflowConfigKind uint8

const (
	customWorkflowStringConfig customWorkflowConfigKind = iota
	customWorkflowIntegerConfig
	customWorkflowStringArrayConfig
	customWorkflowBooleanConfig
)

var customWorkflowConfigKinds = map[string]customWorkflowConfigKind{
	"sourceId":          customWorkflowIntegerConfig,
	"definitionId":      customWorkflowIntegerConfig,
	"pageSize":          customWorkflowIntegerConfig,
	"maxPages":          customWorkflowIntegerConfig,
	"maxWorks":          customWorkflowIntegerConfig,
	"limit":             customWorkflowIntegerConfig,
	"maxFiles":          customWorkflowIntegerConfig,
	"maxBytes":          customWorkflowIntegerConfig,
	"minFreeBytes":      customWorkflowIntegerConfig,
	"year":              customWorkflowIntegerConfig,
	"codes":             customWorkflowStringArrayConfig,
	"excludeExtensions": customWorkflowStringArrayConfig,
	"voiceNames":        customWorkflowStringArrayConfig,
	"metadataTags":      customWorkflowStringArrayConfig,
	"userTags":          customWorkflowStringArrayConfig,
	"allowUnknownSizes": customWorkflowBooleanConfig,
}

func validateCustomWorkflowConfigTypes(node customWorkflowNode) error {
	for key, value := range node.Config {
		if err := validateCustomWorkflowConfigType(node.ID, key, value); err != nil {
			return err
		}
	}
	return validateCustomWorkflowExcludedExtensions(node)
}

func validateCustomWorkflowConfigType(nodeID, key string, value any) error {
	switch customWorkflowConfigKinds[key] {
	case customWorkflowIntegerConfig:
		if _, ok := customConfigInteger(value); !ok {
			return fmt.Errorf("node %s config %s must be an integer", nodeID, key)
		}
	case customWorkflowStringArrayConfig:
		if !customWorkflowStringArray(value) {
			return fmt.Errorf("node %s config %s must be an array of strings", nodeID, key)
		}
	case customWorkflowBooleanConfig:
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("node %s config %s must be a boolean", nodeID, key)
		}
	default:
		if _, ok := value.(string); !ok {
			return fmt.Errorf("node %s config %s must be a string", nodeID, key)
		}
	}
	return nil
}

func customWorkflowStringArray(value any) bool {
	switch items := value.(type) {
	case []string:
		return true
	case []any:
		for _, item := range items {
			if _, ok := item.(string); !ok {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func validateCustomWorkflowExcludedExtensions(node customWorkflowNode) error {
	for _, extension := range configStringSlice(node.Config, "excludeExtensions") {
		extension = strings.TrimPrefix(strings.TrimSpace(extension), ".")
		if extension == "" || len(extension) > 16 || strings.ContainsAny(extension, `/\\`) {
			return fmt.Errorf("node %s has invalid excluded extension", node.ID)
		}
	}
	return nil
}

func validateCustomWorkFilterConfig(node customWorkflowNode) error {
	for _, key := range []string{"releaseFrom", "releaseTo"} {
		value := configString(node.Config, key)
		if value == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", value); err != nil {
			return fmt.Errorf("node %s config %s must use YYYY-MM-DD", node.ID, key)
		}
	}
	from := configString(node.Config, "releaseFrom")
	to := configString(node.Config, "releaseTo")
	if from != "" && to != "" && from > to {
		return fmt.Errorf("node %s releaseFrom must not be after releaseTo", node.ID)
	}
	return nil
}

func customConfigInteger(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed != math.Trunc(typed) || typed < math.MinInt64 || typed > math.MaxInt64 {
			return 0, false
		}
		return int64(typed), true
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case json.Number:
		parsed, err := typed.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

func customNodeInputPorts(node customWorkflowNode) []customWorkflowPort {
	return append([]customWorkflowPort{}, customWorkflowCapabilities[node.Type].Inputs...)
}

func customNodeOutputPorts(node customWorkflowNode) []customWorkflowPort {
	return append([]customWorkflowPort{}, customWorkflowCapabilities[node.Type].Outputs...)
}

func publicCustomWorkflowRunGraph(graph customWorkflowGraph) customWorkflowRunGraph {
	result := customWorkflowRunGraph{SchemaVersion: 1, Nodes: []customWorkflowRunGraphNode{}, Edges: []customWorkflowRunGraphEdge{}}
	for _, node := range graph.Definition.Nodes {
		runNode := customWorkflowRunGraphNode{
			ID: node.ID, Type: node.Type, DisplayName: node.DisplayName, Position: node.Position,
			Inputs: []customWorkflowRunGraphPort{}, Outputs: []customWorkflowRunGraphPort{},
		}
		for _, port := range customNodeInputPorts(node) {
			runNode.Inputs = append(runNode.Inputs, customWorkflowRunGraphPort{ID: port.ID, DataType: port.DataType})
		}
		for _, port := range customNodeOutputPorts(node) {
			runNode.Outputs = append(runNode.Outputs, customWorkflowRunGraphPort{ID: port.ID, DataType: port.DataType})
		}
		result.Nodes = append(result.Nodes, runNode)
	}
	for _, edge := range graph.Definition.Edges {
		dataType := "dynamic"
		if source, ok := graph.NodesByID[edge.Source]; ok {
			if port, found := findCustomPort(customNodeOutputPorts(source), edge.SourceHandle); found {
				dataType = port.DataType
			}
		}
		result.Edges = append(result.Edges, customWorkflowRunGraphEdge{
			ID: edge.ID, Source: edge.Source, SourceHandle: edge.SourceHandle,
			Target: edge.Target, TargetHandle: edge.TargetHandle, DataType: dataType,
		})
	}
	return result
}

func (s *Server) customWorkflowRunGraphJSON(ctx context.Context, runID int64) (string, error) {
	var payloadJSON string
	err := s.db.QueryRowContext(ctx, `
		SELECT payload_json
		FROM workflow_job
		WHERE workflow_run_id = ? AND worker_type = 'custom_workflow'
		ORDER BY id ASC
		LIMIT 1
	`, runID).Scan(&payloadJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return "{}", nil
	}
	if err != nil {
		return "", err
	}
	var payload customWorkflowJobPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return "{}", nil
	}
	graph, err := validateCustomWorkflowDefinition(payload.DefinitionJSON)
	if err != nil {
		return "{}", nil
	}
	encoded, err := json.Marshal(publicCustomWorkflowRunGraph(graph))
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func findCustomPort(ports []customWorkflowPort, id string) (customWorkflowPort, bool) {
	for _, port := range ports {
		if port.ID == id {
			return port, true
		}
	}
	return customWorkflowPort{}, false
}

func customNodeConfigSuppliesPort(node customWorkflowNode, portID string) bool {
	switch node.Type + ":" + portID {
	case "circle_catalog:circle":
		return configString(node.Config, "circleId") != ""
	case "series_catalog:series":
		return configString(node.Config, "seriesId") != ""
	case "voice_source_works:voice":
		return configString(node.Config, "voiceName") != ""
	case "tag_works:tag":
		return configString(node.Config, "tagName") != ""
	default:
		return false
	}
}

func customStringValues(value any) ([]string, error) {
	switch typed := value.(type) {
	case string:
		return strings.FieldsFunc(typed, func(r rune) bool {
			return r == ',' || r == ';' || r == '，' || r == '；' || r == '\n' || r == '\r' || r == ' ' || r == '\t'
		}), nil
	case []string:
		return typed, nil
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("work codes must be strings")
			}
			result = append(result, text)
		}
		return result, nil
	default:
		return nil, fmt.Errorf("work codes must be a string or array")
	}
}

func customWorkflowRequiredPermissions(graph customWorkflowGraph) []string {
	permissions := map[string]bool{"workflows:run": true}
	for _, node := range graph.Definition.Nodes {
		capability := customWorkflowCapabilities[node.Type]
		for _, permission := range capability.Permissions {
			mode := strings.ToLower(configString(node.Config, "mode"))
			if node.Type == "circle_catalog" && (mode == "" || mode == "stored") && permission == "metadata:sync" {
				continue
			}
			permissions[permission] = true
		}
	}
	result := make([]string, 0, len(permissions))
	for permission := range permissions {
		result = append(result, permission)
	}
	sort.Strings(result)
	return result
}

func missingCustomWorkflowPermission(actual []string, required []string) string {
	have := map[string]bool{}
	for _, permission := range actual {
		have[permission] = true
	}
	if have["system:admin"] {
		return ""
	}
	for _, permission := range required {
		if !have[permission] {
			return permission
		}
	}
	return ""
}

func canUseWorkflowDefinition(actor currentUser, definition workflowDefinitionRecord) bool {
	return definition.Scope == "system"
}

type customWorkflowJobPayload struct {
	DefinitionJSON string         `json:"definitionJson"`
	Inputs         map[string]any `json:"inputs"`
	UserID         int64          `json:"userId"`
	Permissions    []string       `json:"permissions"`
	StartedAt      string         `json:"startedAt"`
}

type customWorkflowCheckpoint struct {
	CompletedNodeIDs []string                              `json:"completedNodeIds"`
	Outputs          map[string]map[string]customPortValue `json:"outputs"`
	ChildRunIDs      []int64                               `json:"childRunIds"`
	Pending          *customPendingExecution               `json:"pending,omitempty"`
	Partial          bool                                  `json:"partial"`
	BasePriority     int                                   `json:"basePriority"`
}

type customWorkflowEnqueueOptions struct {
	TriggerID     int64
	TriggerType   string
	TriggerReason string
	// DefinitionJSON overrides the stored definition snapshot. Preset workflows
	// build their graph per dispatch while the system definition record only
	// carries a display pipeline.
	DefinitionJSON string
}

func (s *Server) enqueueCustomWorkflow(ctx context.Context, definition workflowDefinitionRecord, graph customWorkflowGraph, userID int64, permissions []string, inputs map[string]any, options customWorkflowEnqueueOptions) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	triggerType := strings.TrimSpace(options.TriggerType)
	if triggerType == "" {
		triggerType = "manual"
	}
	triggerReason := strings.TrimSpace(options.TriggerReason)
	if triggerReason == "" {
		triggerReason = "custom_definition"
	}
	runInput := map[string]any{"inputs": inputs, "definition_schema_version": customWorkflowSchemaVersion, "requested_by_user_id": userID}
	runID, err := workflow.InsertRun(ctx, tx, definition.ID, definition.Code, definition.DisplayName, "queued", triggerType, triggerReason, runInput, map[string]any{"nodes": len(graph.TopologicalOrder)})
	if err != nil {
		return 0, err
	}
	if options.TriggerID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", options.TriggerID, runID); err != nil {
			return 0, err
		}
	}
	firstNodeRunID := int64(0)
	for position, nodeID := range graph.TopologicalOrder {
		node := graph.NodesByID[nodeID]
		nodeRunID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
			NodeID: node.ID, NodeType: node.Type, DisplayName: node.DisplayName, Position: position + 1, Status: "queued",
			Input: map[string]any{"config": publicCustomWorkflowConfig(node.Config)},
		})
		if err != nil {
			return 0, err
		}
		if firstNodeRunID == 0 {
			firstNodeRunID = nodeRunID
		}
	}
	definitionJSON := definition.DefinitionJSON
	if strings.TrimSpace(options.DefinitionJSON) != "" {
		definitionJSON = options.DefinitionJSON
	}
	payload := customWorkflowJobPayload{DefinitionJSON: definitionJSON, Inputs: inputs, UserID: userID, Permissions: append([]string{}, permissions...), StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	jobPriority := workflowJobPriorityForTrigger(triggerType)
	checkpoint := customWorkflowCheckpoint{CompletedNodeIDs: []string{}, Outputs: map[string]map[string]customPortValue{}, ChildRunIDs: []int64{}, BasePriority: jobPriority}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: firstNodeRunID, WorkerType: "custom_workflow", Status: "queued", Priority: jobPriority, Payload: payload,
		Checkpoint: checkpoint, Recoverable: true, MaxRetries: 3, ProgressTotal: len(graph.TopologicalOrder),
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return runID, nil
}

func workflowJobPriorityForTrigger(triggerType string) int {
	switch strings.ToLower(strings.TrimSpace(triggerType)) {
	case "playback":
		return workflow.JobPriorityPlayback
	case "manual":
		return workflow.JobPriorityUserInitiated
	default:
		return workflow.JobPriorityBackground
	}
}

func publicCustomWorkflowConfig(config map[string]any) map[string]any {
	result := map[string]any{}
	for key, value := range config {
		switch strings.ToLower(key) {
		case "url", "endpoint", "apiurl", "password", "token", "secret":
			continue
		default:
			result[key] = value
		}
	}
	return result
}

func configString(config map[string]any, key string) string {
	value, _ := config[key].(string)
	return strings.TrimSpace(value)
}

func configStringSlice(config map[string]any, key string) []string {
	value, ok := config[key]
	if !ok {
		return nil
	}
	items, err := customStringValues(value)
	if err != nil {
		return nil
	}
	return items
}

func configInt(config map[string]any, key string, fallback int) int {
	value := configInt64(config, key, int64(fallback))
	if value > math.MaxInt32 || value < math.MinInt32 {
		return fallback
	}
	return int(value)
}

func configInt64(config map[string]any, key string, fallback int64) int64 {
	value, ok := config[key]
	if !ok {
		return fallback
	}
	switch typed := value.(type) {
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) || typed != math.Trunc(typed) {
			return fallback
		}
		return int64(typed)
	case int:
		return int64(typed)
	case int64:
		return typed
	case json.Number:
		parsed, err := typed.Int64()
		if err == nil {
			return parsed
		}
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

func configBool(config map[string]any, key string, fallback bool) bool {
	value, ok := config[key].(bool)
	if !ok {
		return fallback
	}
	return value
}

type customWorkCandidate struct {
	Code         string   `json:"code"`
	SourceID     int64    `json:"sourceId,omitempty"`
	Title        string   `json:"title,omitempty"`
	ReleaseDate  string   `json:"releaseDate,omitempty"`
	VoiceNames   []string `json:"voiceNames,omitempty"`
	MetadataTags []string `json:"metadataTags,omitempty"`
	Reason       string   `json:"reason,omitempty"`
}

type customWorkRef struct {
	Code       string `json:"code"`
	WorkID     int64  `json:"workId"`
	SourceID   int64  `json:"sourceId,omitempty"`
	ChildRunID int64  `json:"childRunId,omitempty"`
}

type customPortValue struct {
	Type       string                `json:"type"`
	Text       string                `json:"text,omitempty"`
	Candidates []customWorkCandidate `json:"candidates,omitempty"`
	WorkRefs   []customWorkRef       `json:"workRefs,omitempty"`
}

type customNodeExecution struct {
	Outputs     map[string]customPortValue
	Partial     bool
	ChildRunIDs []int64
	Pending     *customPendingExecution
}

type customPendingChild struct {
	RunID     int64               `json:"runId"`
	Candidate customWorkCandidate `json:"candidate"`
	WorkRef   customWorkRef       `json:"workRef"`
}

type customPendingExecution struct {
	NodeID        string                `json:"nodeId"`
	Kind          string                `json:"kind"`
	Children      []customPendingChild  `json:"children"`
	Failed        []customWorkCandidate `json:"failed,omitempty"`
	Candidates    []customWorkCandidate `json:"candidates,omitempty"`
	OutputNodeIDs []string              `json:"outputNodeIds,omitempty"`
}

func (s *Server) executeCustomWorkflowJob(ctx context.Context, job workflowJobRecord) error {
	runtime, err := s.prepareCustomWorkflowRuntime(ctx, job)
	if err != nil {
		return err
	}
	for index, nodeID := range runtime.graph.TopologicalOrder {
		if runtime.completed[nodeID] {
			continue
		}
		deferred, err := s.executeCustomWorkflowRuntimeNode(ctx, job, index, nodeID, &runtime)
		if err != nil {
			return err
		}
		if deferred {
			return nil
		}
	}
	return s.finishCustomWorkflowJob(ctx, job, runtime.checkpoint, len(runtime.graph.TopologicalOrder))
}

type customWorkflowRuntime struct {
	payload    customWorkflowJobPayload
	graph      customWorkflowGraph
	checkpoint customWorkflowCheckpoint
	completed  map[string]bool
	nodeRunIDs map[string]int64
}

func (s *Server) prepareCustomWorkflowRuntime(ctx context.Context, job workflowJobRecord) (customWorkflowRuntime, error) {
	var runtime customWorkflowRuntime
	var payload customWorkflowJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow payload is invalid")
		return runtime, err
	}
	graph, err := validateCustomWorkflowDefinition(payload.DefinitionJSON)
	if err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow snapshot is invalid")
		return runtime, err
	}
	if missing := missingCustomWorkflowPermission(payload.Permissions, customWorkflowRequiredPermissions(graph)); missing != "" {
		err := fmt.Errorf("permission snapshot is missing %s", missing)
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow permission snapshot is invalid")
		return runtime, err
	}
	checkpoint := customWorkflowCheckpoint{Outputs: map[string]map[string]customPortValue{}, CompletedNodeIDs: []string{}, ChildRunIDs: []int64{}}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow checkpoint is invalid")
		return runtime, err
	}
	if checkpoint.Outputs == nil {
		checkpoint.Outputs = map[string]map[string]customPortValue{}
	}
	if checkpoint.BasePriority == 0 && job.Priority > 0 {
		checkpoint.BasePriority = job.Priority
	}
	completed := map[string]bool{}
	for _, nodeID := range checkpoint.CompletedNodeIDs {
		completed[nodeID] = true
	}
	nodeRunIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow node runs are unavailable")
		return runtime, err
	}
	return customWorkflowRuntime{payload: payload, graph: graph, checkpoint: checkpoint, completed: completed, nodeRunIDs: nodeRunIDs}, nil
}

func (s *Server) executeCustomWorkflowRuntimeNode(ctx context.Context, job workflowJobRecord, index int, nodeID string, runtime *customWorkflowRuntime) (bool, error) {
	if err := s.ensureWorkflowRunActive(ctx, job.RunID); err != nil {
		return false, err
	}
	node := runtime.graph.NodesByID[nodeID]
	inputs, err := customRuntimeNodeInputs(runtime.graph, node, runtime.checkpoint.Outputs)
	if err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, runtime.nodeRunIDs[nodeID], "custom workflow input resolution failed")
		return false, err
	}
	nodeRunID := runtime.nodeRunIDs[nodeID]
	if err := s.startCustomWorkflowNode(ctx, job, nodeRunID, node, inputs); err != nil {
		return false, err
	}
	execution, waiting, runErr := s.runCustomWorkflowRuntimeNode(ctx, job, nodeID, node, inputs, runtime)
	if runErr != nil {
		slog.Error("custom workflow node failed", "run_id", job.RunID, "node_id", node.ID, "node_type", node.Type, "error", runErr)
		_ = s.failCustomWorkflowJob(ctx, job, nodeRunID, publicCustomWorkflowError(node.Type))
		return false, runErr
	}
	if waiting {
		return true, s.deferCustomWorkflowJob(ctx, job, nodeRunID, runtime.checkpoint)
	}
	if execution.Pending != nil {
		runtime.checkpoint.Pending = execution.Pending
		for _, child := range execution.Pending.Children {
			runtime.checkpoint.ChildRunIDs = appendUniqueInt64(runtime.checkpoint.ChildRunIDs, child.RunID)
		}
		return true, s.deferCustomWorkflowJob(ctx, job, nodeRunID, runtime.checkpoint)
	}
	status := "succeeded"
	if execution.Partial {
		status = "partial"
		runtime.checkpoint.Partial = true
	}
	if execution.Outputs == nil {
		execution.Outputs = map[string]customPortValue{}
	}
	if err := s.completeCustomWorkflowNode(ctx, job, nodeRunID, node, status, execution.Outputs); err != nil {
		return false, err
	}
	runtime.checkpoint.Outputs[nodeID] = execution.Outputs
	runtime.checkpoint.CompletedNodeIDs = append(runtime.checkpoint.CompletedNodeIDs, nodeID)
	runtime.checkpoint.ChildRunIDs = append(runtime.checkpoint.ChildRunIDs, execution.ChildRunIDs...)
	runtime.completed[nodeID] = true
	err = s.updateWorkflowJobCheckpoint(ctx, job.ID, nodeID, runtime.checkpoint, index+1, len(runtime.graph.TopologicalOrder))
	return false, err
}

func (s *Server) runCustomWorkflowRuntimeNode(ctx context.Context, job workflowJobRecord, nodeID string, node customWorkflowNode, inputs map[string]customPortValue, runtime *customWorkflowRuntime) (customNodeExecution, bool, error) {
	if runtime.checkpoint.Pending == nil {
		execution, err := s.executeCustomWorkflowNode(ctx, job.RunID, runtime.checkpoint.BasePriority, runtime.payload, runtime.graph, node, inputs)
		return execution, false, err
	}
	if runtime.checkpoint.Pending.NodeID != nodeID {
		return customNodeExecution{}, false, fmt.Errorf("custom workflow pending node does not match execution order")
	}
	execution, waiting, err := s.resumeCustomPendingExecution(ctx, *runtime.checkpoint.Pending)
	if err == nil && !waiting {
		runtime.checkpoint.Pending = nil
	}
	return execution, waiting, err
}

func (s *Server) startCustomWorkflowNode(ctx context.Context, job workflowJobRecord, nodeRunID int64, node customWorkflowNode, inputs map[string]customPortValue) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'running', input_json = ?, error_message = '', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = NULL
		WHERE id = ?
	`, mustJSON(customPortValuesSummary(inputs)), nodeRunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: nodeRunID, JobID: job.ID, Level: "info", Type: "custom_workflow.node_started",
		Message: node.DisplayName + " started", Detail: map[string]any{"node_id": node.ID, "node_type": node.Type, "status": "running"},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) completeCustomWorkflowNode(ctx context.Context, job workflowJobRecord, nodeRunID int64, node customWorkflowNode, status string, outputs map[string]customPortValue) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?, output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, mustJSON(customPortValuesSummary(outputs)), nodeRunID); err != nil {
		return err
	}
	level := "info"
	if status == "partial" {
		level = "warn"
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: nodeRunID, JobID: job.ID, Level: level, Type: "custom_workflow.node_completed",
		Message: node.DisplayName + " " + status, Detail: map[string]any{"node_id": node.ID, "node_type": node.Type, "status": status},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) resumeCustomPendingExecution(ctx context.Context, pending customPendingExecution) (customNodeExecution, bool, error) {
	switch pending.Kind {
	case "fetch":
		return s.resumeCustomPendingFetch(ctx, pending)
	default:
		return customNodeExecution{}, false, fmt.Errorf("unsupported pending custom workflow operation")
	}
}

func (s *Server) resumeCustomPendingFetch(ctx context.Context, pending customPendingExecution) (customNodeExecution, bool, error) {
	completed := []customWorkRef{}
	failed := append([]customWorkCandidate{}, pending.Failed...)
	waiting := false
	for _, child := range pending.Children {
		var status string
		err := s.db.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", child.RunID).Scan(&status)
		if errors.Is(err, sql.ErrNoRows) {
			candidate := child.Candidate
			candidate.Reason = "fetch_child_missing"
			failed = append(failed, candidate)
			continue
		}
		if err != nil {
			return customNodeExecution{}, false, err
		}
		switch status {
		case "queued", "running":
			waiting = true
		case "succeeded":
			completed = append(completed, child.WorkRef)
		default:
			candidate := child.Candidate
			candidate.Reason = "fetch_child_" + strings.ToLower(strings.TrimSpace(status))
			failed = append(failed, candidate)
		}
	}
	if waiting {
		return customNodeExecution{}, true, nil
	}
	return customNodeExecution{Partial: len(failed) > 0, Outputs: map[string]customPortValue{
		"completed": {Type: "work_refs", WorkRefs: uniqueCustomWorkRefs(completed)},
		"failed":    {Type: "work_candidates", Candidates: uniqueCustomCandidates(failed)},
	}}, false, nil
}

func (s *Server) deferCustomWorkflowJob(ctx context.Context, job workflowJobRecord, nodeRunID int64, checkpoint customWorkflowCheckpoint) error {
	availableAt := time.Now().UTC().Add(2 * time.Second).Format("2006-01-02 15:04:05")
	checkpointJSON := mustJSON(map[string]any{
		"phase": "waiting_for_children", "detail": checkpoint,
		"progressCurrent": len(checkpoint.CompletedNodeIDs), "progressTotal": 0,
		"updatedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'queued', output_json = ?, error_message = '', finished_at = NULL
		WHERE id = ?
	`, mustJSON(map[string]any{"waiting_for_child_runs": checkpoint.ChildRunIDs}), nodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'queued', checkpoint_json = ?, available_at = ?, locked_by = '', locked_at = NULL,
			heartbeat_at = NULL, priority = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status = 'running'
	`, checkpointJSON, availableAt, workflow.JobPriorityBackground-1, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = 'queued', finished_at = NULL WHERE id = ? AND status = 'running'", job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: nodeRunID, JobID: job.ID, Level: "info", Type: "workflow.children_waiting",
		Message: "Waiting for child workflows", Detail: map[string]any{"child_run_ids": checkpoint.ChildRunIDs, "available_at": availableAt},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func appendUniqueInt64(values []int64, value int64) []int64 {
	if value <= 0 {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func customRuntimeNodeInputs(graph customWorkflowGraph, node customWorkflowNode, outputs map[string]map[string]customPortValue) (map[string]customPortValue, error) {
	result := map[string]customPortValue{}
	for _, edge := range graph.IncomingByNode[node.ID] {
		sourceOutputs, ok := outputs[edge.Source]
		if !ok {
			return nil, fmt.Errorf("source node has no output: %s", edge.Source)
		}
		value, ok := sourceOutputs[edge.SourceHandle]
		if !ok {
			return nil, fmt.Errorf("source port has no output: %s.%s", edge.Source, edge.SourceHandle)
		}
		result[edge.TargetHandle] = value
	}
	return result, nil
}

func (s *Server) executeCustomWorkflowNode(ctx context.Context, runID int64, jobPriority int, payload customWorkflowJobPayload, graph customWorkflowGraph, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	switch node.Type {
	case "circle_catalog":
		return s.executeCustomCircleCatalog(ctx, node, inputs)
	case "series_catalog":
		return s.executeCustomSeriesCatalog(ctx, node, inputs)
	case "voice_source_works":
		return s.executeCustomVoiceSourceWorks(ctx, runID, node, inputs)
	case "filter_works":
		return s.executeCustomFilterWorks(ctx, payload.UserID, node, inputs)
	case "metadata_sync":
		return s.executeCustomMetadataSync(ctx, runID, node, inputs)
	case "track_works":
		return s.executeCustomTrackWorks(ctx, runID, node, inputs)
	case "fetch_works":
		return s.executeCustomFetchWorks(ctx, runID, payload.UserID, jobPriority, node, inputs)
	case "tag_works":
		return s.executeCustomTagWorks(ctx, payload.UserID, node, inputs)
	default:
		return customNodeExecution{}, fmt.Errorf("unsupported custom workflow node: %s", node.Type)
	}
}

func (s *Server) executeCustomCircleCatalog(ctx context.Context, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	circleID := normalizeMakerID(firstNonEmpty(inputs["circle"].Text, configString(node.Config, "circleId")))
	if !dlsiteMakerIDPattern.MatchString(circleID) {
		return customNodeExecution{}, fmt.Errorf("invalid circle id")
	}
	partyID, err := s.ensurePlaceholderCircle(ctx, circleID)
	if err != nil {
		return customNodeExecution{}, err
	}
	visible, err := s.circlePartyVisible(ctx, partyID)
	if err != nil {
		return customNodeExecution{}, err
	}
	if !visible {
		return customNodeExecution{}, fmt.Errorf("circle is translation-only")
	}
	mode := strings.ToLower(configString(node.Config, "mode"))
	if mode == "" {
		mode = "stored"
	}
	if mode != "stored" {
		if _, err := s.runCircleCatalogRefresh(ctx, partyID, circleID, mode, s.newDLsiteClient()); err != nil {
			return customNodeExecution{}, err
		}
	}
	profile, err := s.loadCircleProfileForRefresh(ctx, partyID, circleID)
	if err != nil {
		return customNodeExecution{}, err
	}
	maxWorks := configInt(node.Config, "maxWorks", 100)
	codes := profile.WorkCodes
	if len(codes) > maxWorks {
		codes = codes[:maxWorks]
	}
	normalized, err := normalizeCustomWorkCodes(codes, maxWorks)
	if err != nil && len(codes) > 0 {
		return customNodeExecution{}, err
	}
	return customNodeExecution{Outputs: map[string]customPortValue{"works": {Type: "work_candidates", Candidates: customCandidatesForCodes(normalized, 0)}}}, nil
}

func (s *Server) executeCustomSeriesCatalog(ctx context.Context, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	seriesID := strings.ToUpper(strings.TrimSpace(firstNonEmpty(inputs["series"].Text, configString(node.Config, "seriesId"))))
	if seriesID == "" {
		return customNodeExecution{}, fmt.Errorf("series id is required")
	}
	query := `
		SELECT DISTINCT series_work.primary_code
		FROM party_series_work AS series_work
		INNER JOIN party_series AS series ON series.id = series_work.series_id
		WHERE UPPER(series.title_id) = ?
	`
	args := []any{seriesID}
	if circleID := normalizeMakerID(configString(node.Config, "circleExternalId")); circleID != "" {
		query += ` AND series.party_id IN (SELECT party_id FROM party_external_id WHERE UPPER(external_id) = ?)`
		args = append(args, circleID)
	}
	query += ` ORDER BY series_work.position ASC, series_work.primary_code ASC LIMIT ?`
	maxWorks := configInt(node.Config, "maxWorks", 100)
	args = append(args, maxWorks)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return customNodeExecution{}, err
	}
	defer rows.Close()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return customNodeExecution{}, err
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		return customNodeExecution{}, err
	}
	normalized := []string{}
	if len(codes) > 0 {
		normalized, err = normalizeCustomWorkCodes(codes, maxWorks)
		if err != nil {
			return customNodeExecution{}, err
		}
	}
	return customNodeExecution{Outputs: map[string]customPortValue{"works": {Type: "work_candidates", Candidates: customCandidatesForCodes(normalized, 0)}}}, nil
}

func (s *Server) executeCustomVoiceSourceWorks(ctx context.Context, runID int64, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	search, err := s.prepareCustomVoiceSourceSearch(ctx, node, inputs)
	if err != nil {
		return customNodeExecution{}, err
	}
	candidates, err := s.collectCustomVoiceSourceWorks(ctx, runID, search)
	if err != nil {
		return customNodeExecution{}, err
	}
	return customNodeExecution{Outputs: map[string]customPortValue{"works": {Type: "work_candidates", Candidates: candidates}}}, nil
}

type customVoiceSourceSearch struct {
	Source   remoteSourceForUse
	Keyword  string
	PageSize int
	MaxPages int
	MaxWorks int
}

func (s *Server) prepareCustomVoiceSourceSearch(ctx context.Context, node customWorkflowNode, inputs map[string]customPortValue) (customVoiceSourceSearch, error) {
	voiceName := strings.TrimSpace(firstNonEmpty(inputs["voice"].Text, configString(node.Config, "voiceName")))
	if voiceName == "" || isUnknownVoiceActorName(voiceName) {
		return customVoiceSourceSearch{}, fmt.Errorf("voice name is required")
	}
	sourceID := configInt64(node.Config, "sourceId", 0)
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		return customVoiceSourceSearch{}, err
	}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) || strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return customVoiceSourceSearch{}, fmt.Errorf("source is not an enabled compatible remote source")
	}
	healthCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = s.checkRemoteSourceHealthWithClass(healthCtx, source, sourceRequestCrawl)
	cancel()
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		return customVoiceSourceSearch{}, err
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	return customVoiceSourceSearch{
		Source: source, Keyword: "$va:" + voiceName + "$",
		PageSize: configInt(node.Config, "pageSize", 48),
		MaxPages: configInt(node.Config, "maxPages", 10),
		MaxWorks: configInt(node.Config, "maxWorks", 100),
	}, nil
}

func (s *Server) collectCustomVoiceSourceWorks(ctx context.Context, runID int64, search customVoiceSourceSearch) ([]customWorkCandidate, error) {
	client := s.kikoeruCrawlClientForSource(search.Source)
	projector := s.remoteCatalogProjector(ctx)
	candidates := []customWorkCandidate{}
	seen := map[string]bool{}
	for pageNumber := 1; pageNumber <= search.MaxPages && len(candidates) < search.MaxWorks; pageNumber++ {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return nil, err
		}
		page, err := client.ListWorks(ctx, pageNumber, search.PageSize, search.Keyword)
		if err != nil {
			_ = s.updateSourceHealth(ctx, search.Source.ID, "unavailable")
			return nil, err
		}
		for _, remoteWork := range page.Works {
			code := normalizedRemoteWorkCode(remoteWork)
			if code == "" || seen[code] {
				continue
			}
			seen[code] = true
			candidates = append(candidates, customCandidateFromRemoteWork(remoteWork, search.Source.ID, projector))
			if len(candidates) >= search.MaxWorks {
				break
			}
		}
		total := page.Pagination.TotalCount
		if total == 0 {
			total = page.Pagination.Total
		}
		if total == 0 {
			total = page.Pagination.Count
		}
		if total > 0 && pageNumber*search.PageSize >= total {
			break
		}
		if total == 0 && len(page.Works) < search.PageSize {
			break
		}
	}
	return candidates, nil
}

func customCandidateFromRemoteWork(work kikoeru.Work, sourceID int64, projector remoteCatalogProjector) customWorkCandidate {
	projected := projector.project(sourceID, work)
	return customWorkCandidate{
		Code: projected.RemoteCode, SourceID: sourceID, Title: projected.Title,
		ReleaseDate: normalizeCustomReleaseDate(projected.ReleaseDate), VoiceNames: uniqueFoldedStrings(projected.VoiceActors), MetadataTags: uniqueFoldedStrings(projected.Tags),
	}
}

func normalizeCustomReleaseDate(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 10 {
		candidate := value[:10]
		if _, err := time.Parse("2006-01-02", candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func (s *Server) executeCustomFilterWorks(ctx context.Context, userID int64, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	candidates := uniqueCustomCandidates(inputs["works"].Candidates)
	limit := configInt(node.Config, "limit", min(100, len(candidates)))
	if limit <= 0 {
		limit = len(candidates)
	}
	prefix := strings.ToUpper(configString(node.Config, "codePrefix"))
	existing := strings.ToLower(configString(node.Config, "existing"))
	if existing == "" {
		existing = "any"
	}
	accepted := []customWorkCandidate{}
	rejected := []customWorkCandidate{}
	for _, candidate := range candidates {
		keep := prefix == "" || strings.HasPrefix(candidate.Code, prefix)
		metadata, err := s.customWorkFilterMetadata(ctx, userID, candidate.Code)
		if err != nil {
			return customNodeExecution{}, err
		}
		candidate = mergeCustomCandidateMetadata(candidate, metadata)
		if keep && existing != "any" {
			ref, err := s.canonicalWorkForCode(ctx, candidate.Code)
			if err != nil {
				return customNodeExecution{}, err
			}
			keep = (existing == "known" && ref.Known) || (existing == "unknown" && !ref.Known)
		}
		if keep {
			keep = customWorkMatchesFilter(candidate.ReleaseDate, candidate.VoiceNames, candidate.MetadataTags, metadata.UserTags, node.Config)
		}
		if keep && len(accepted) < limit {
			accepted = append(accepted, candidate)
		} else {
			candidate.Reason = "filtered"
			rejected = append(rejected, candidate)
		}
	}
	return customNodeExecution{Outputs: map[string]customPortValue{
		"accepted": {Type: "work_candidates", Candidates: accepted},
		"rejected": {Type: "work_candidates", Candidates: rejected},
	}}, nil
}

func (s *Server) executeCustomMetadataSync(ctx context.Context, runID int64, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	candidates := uniqueCustomCandidates(inputs["works"].Candidates)
	maxWorks := configInt(node.Config, "maxWorks", 25)
	if len(candidates) > maxWorks {
		return customNodeExecution{}, fmt.Errorf("metadata candidate count exceeds maxWorks")
	}
	completed := []customWorkRef{}
	failed := []customWorkCandidate{}
	partial := false
	for _, candidate := range candidates {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return customNodeExecution{}, err
		}
		family, err := s.syncWorkMetadataFamily(ctx, candidate.Code)
		if err != nil {
			candidate.Reason = "metadata_sync_failed"
			failed = append(failed, candidate)
			continue
		}
		var workID int64
		var code string
		if err := s.db.QueryRowContext(ctx, "SELECT id, primary_code FROM work WHERE UPPER(primary_code) = UPPER(?)", candidate.Code).Scan(&workID, &code); err != nil {
			candidate.Reason = "metadata_work_missing"
			failed = append(failed, candidate)
			continue
		}
		completed = append(completed, customWorkRef{Code: code, WorkID: workID, SourceID: candidate.SourceID})
		partial = partial || len(family.Failures) > 0
	}
	return customNodeExecution{Partial: partial || len(failed) > 0, Outputs: map[string]customPortValue{
		"completed": {Type: "work_refs", WorkRefs: uniqueCustomWorkRefs(completed)},
		"failed":    {Type: "work_candidates", Candidates: uniqueCustomCandidates(failed)},
	}}, nil
}

type customWorkFilterMetadata struct {
	ReleaseDate  string
	VoiceNames   []string
	MetadataTags []string
	UserTags     []string
}

func (s *Server) customWorkFilterMetadata(ctx context.Context, userID int64, code string) (customWorkFilterMetadata, error) {
	metadata := customWorkFilterMetadata{}
	var workID int64
	var release sql.NullString
	err := s.db.QueryRowContext(ctx, "SELECT id, release_date FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&workID, &release)
	if errors.Is(err, sql.ErrNoRows) {
		return metadata, nil
	}
	if err != nil {
		return metadata, err
	}
	metadata.ReleaseDate = normalizeCustomReleaseDate(release.String)
	queries := []struct {
		Target *[]string
		SQL    string
		Args   []any
	}{
		{&metadata.VoiceNames, `SELECT DISTINCT person.display_name FROM work_credit INNER JOIN person ON person.id = work_credit.person_id WHERE work_credit.work_id = ? AND work_credit.role = 'voice_actor' ORDER BY person.display_name`, []any{workID}},
		{&metadata.MetadataTags, `SELECT DISTINCT tag.display_name FROM work_tag INNER JOIN tag ON tag.id = work_tag.tag_id WHERE work_tag.work_id = ? ORDER BY tag.display_name`, []any{workID}},
		{&metadata.UserTags, `SELECT DISTINCT user_tag.name FROM user_work_tag INNER JOIN user_tag ON user_tag.id = user_work_tag.user_tag_id WHERE user_work_tag.work_id = ? AND user_work_tag.user_id = ? ORDER BY user_tag.name`, []any{workID, userID}},
	}
	for _, query := range queries {
		rows, err := s.db.QueryContext(ctx, query.SQL, query.Args...)
		if err != nil {
			return metadata, err
		}
		for rows.Next() {
			var value string
			if err := rows.Scan(&value); err != nil {
				rows.Close()
				return metadata, err
			}
			*query.Target = append(*query.Target, value)
		}
		if err := rows.Close(); err != nil {
			return metadata, err
		}
	}
	return metadata, nil
}

func mergeCustomCandidateMetadata(candidate customWorkCandidate, metadata customWorkFilterMetadata) customWorkCandidate {
	if candidate.ReleaseDate == "" {
		candidate.ReleaseDate = metadata.ReleaseDate
	}
	candidate.VoiceNames = uniqueFoldedStrings(append(candidate.VoiceNames, metadata.VoiceNames...))
	candidate.MetadataTags = uniqueFoldedStrings(append(candidate.MetadataTags, metadata.MetadataTags...))
	return candidate
}

func customWorkMatchesFilter(releaseDate string, voiceNames, metadataTags, userTags []string, config map[string]any) bool {
	if from := configString(config, "releaseFrom"); from != "" && (releaseDate == "" || releaseDate < from) {
		return false
	}
	if to := configString(config, "releaseTo"); to != "" && (releaseDate == "" || releaseDate > to) {
		return false
	}
	return containsAnyFold(voiceNames, configStringSlice(config, "voiceNames")) &&
		containsAnyFold(metadataTags, configStringSlice(config, "metadataTags")) &&
		containsAnyFold(userTags, configStringSlice(config, "userTags"))
}

func containsAnyFold(values, wanted []string) bool {
	if len(wanted) == 0 {
		return true
	}
	for _, target := range wanted {
		for _, value := range values {
			if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(target)) {
				return true
			}
		}
	}
	return false
}

func uniqueFoldedStrings(values []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}

func (s *Server) executeCustomTrackWorks(ctx context.Context, runID int64, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	candidates := uniqueCustomCandidates(inputs["works"].Candidates)
	maxWorks := configInt(node.Config, "maxWorks", 25)
	if len(candidates) > maxWorks {
		return customNodeExecution{}, fmt.Errorf("track candidate count exceeds maxWorks")
	}
	completed := []customWorkRef{}
	failed := []customWorkCandidate{}
	childRunIDs := []int64{}
	for _, candidate := range candidates {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return customNodeExecution{}, err
		}
		sourceID := candidate.SourceID
		if sourceID <= 0 {
			sourceID = configInt64(node.Config, "sourceId", 0)
		}
		if sourceID <= 0 {
			candidate.Reason = "source_required"
			failed = append(failed, candidate)
			continue
		}
		requestID := customTrackRequestID(runID, node.ID, sourceID, candidate.Code)
		if existing, found, err := s.customTrackRequestResult(ctx, requestID, sourceID, candidate.Code); err != nil {
			return customNodeExecution{}, err
		} else if found {
			completed = append(completed, customWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: sourceID, ChildRunID: existing.RunID})
			childRunIDs = append(childRunIDs, existing.RunID)
			continue
		}
		result, err := s.runRemoteWorkSync(ctx, sourceID, candidate.Code, requestID)
		if err != nil {
			candidate.Reason = "track_failed"
			failed = append(failed, candidate)
			continue
		}
		completed = append(completed, customWorkRef{Code: result.PrimaryCode, WorkID: result.WorkID, SourceID: sourceID, ChildRunID: result.RunID})
		childRunIDs = append(childRunIDs, result.RunID)
	}
	return customNodeExecution{Partial: len(failed) > 0, ChildRunIDs: childRunIDs, Outputs: map[string]customPortValue{
		"completed": {Type: "work_refs", WorkRefs: completed}, "failed": {Type: "work_candidates", Candidates: failed},
	}}, nil
}

type preparedCustomFetch struct {
	Candidate customWorkCandidate
	RequestID string
	Paths     []string
	Files     int
	Bytes     int64
	Unknown   int
}

func (s *Server) executeCustomFetchWorks(ctx context.Context, runID int64, userID int64, jobPriority int, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	candidates := uniqueCustomCandidates(inputs["works"].Candidates)
	limits := customFetchLimitsFromConfig(node.Config)
	if len(candidates) > limits.maxWorks {
		return customNodeExecution{}, fmt.Errorf("fetch candidate count exceeds maxWorks")
	}
	state, err := s.prepareCustomFetchCandidates(ctx, runID, node, candidates, limits)
	if err != nil {
		return customNodeExecution{}, err
	}
	if len(state.prepared) > 1 && limits.targetTemplate != "" && !strings.Contains(limits.targetTemplate, "<work_code>") {
		return customNodeExecution{}, fmt.Errorf("batch targetRoot must contain <work_code>")
	}
	state, err = s.enqueuePreparedCustomFetches(ctx, runID, userID, jobPriority, node, limits, state)
	if err != nil {
		return customNodeExecution{}, err
	}
	if len(state.pendingChildren) > 0 {
		return customNodeExecution{ChildRunIDs: state.childRunIDs, Pending: &customPendingExecution{
			NodeID: node.ID, Kind: "fetch", Children: state.pendingChildren, Failed: state.failed,
		}}, nil
	}
	return customNodeExecution{Partial: len(state.failed) > 0, ChildRunIDs: state.childRunIDs, Outputs: map[string]customPortValue{
		"completed": {Type: "work_refs", WorkRefs: []customWorkRef{}}, "failed": {Type: "work_candidates", Candidates: state.failed},
	}}, nil
}

type customFetchLimits struct {
	maxWorks       int
	maxFiles       int
	maxBytes       int64
	allowUnknown   bool
	targetTemplate string
	minFreeBytes   int64
	excluded       map[string]bool
}

func customFetchLimitsFromConfig(config map[string]any) customFetchLimits {
	return customFetchLimits{
		maxWorks: configInt(config, "maxWorks", 25), maxFiles: configInt(config, "maxFiles", 10000),
		maxBytes: configInt64(config, "maxBytes", 100*1024*1024*1024), allowUnknown: configBool(config, "allowUnknownSizes", false),
		targetTemplate: configString(config, "targetRoot"), minFreeBytes: configInt64(config, "minFreeBytes", 0),
		excluded: customExtensionSet(configStringSlice(config, "excludeExtensions")),
	}
}

type customFetchPreparation struct {
	prepared        []preparedCustomFetch
	failed          []customWorkCandidate
	childRunIDs     []int64
	pendingChildren []customPendingChild
	totalFiles      int
	totalBytes      int64
}

func (s *Server) prepareCustomFetchCandidates(ctx context.Context, runID int64, node customWorkflowNode, candidates []customWorkCandidate, limits customFetchLimits) (customFetchPreparation, error) {
	state := customFetchPreparation{}
	for _, candidate := range candidates {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return state, err
		}
		sourceID := candidate.SourceID
		if sourceID <= 0 {
			sourceID = configInt64(node.Config, "sourceId", 0)
		}
		if sourceID <= 0 {
			candidate.Reason = "source_required"
			state.failed = append(state.failed, candidate)
			continue
		}
		candidate.SourceID = sourceID
		requestID := customFetchRequestID(runID, node.ID, candidate.Code)
		existing, found, err := s.remoteFetchRequestResult(ctx, requestID, sourceID, candidate.Code)
		if err != nil {
			return state, err
		}
		if found {
			usage, err := s.customFetchPersistedUsage(ctx, existing.RunID)
			if err != nil {
				return state, err
			}
			if usage.Unknown > 0 && !limits.allowUnknown {
				return state, fmt.Errorf("persisted fetch plan contains unknown file sizes")
			}
			if err := state.addUsage(usage, limits); err != nil {
				return state, err
			}
			ref := customWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: sourceID, ChildRunID: existing.RunID}
			state.pendingChildren = append(state.pendingChildren, customPendingChild{RunID: existing.RunID, Candidate: candidate, WorkRef: ref})
			state.childRunIDs = append(state.childRunIDs, existing.RunID)
			continue
		}
		_, _, tracks, err := s.loadRemoteWorkTracksCached(ctx, sourceID, candidate.Code)
		if err != nil {
			candidate.Reason = "fetch_plan_failed"
			state.failed = append(state.failed, candidate)
			continue
		}
		item, reason, err := summarizeCustomFetch(candidate, requestID, tracks, limits)
		if err != nil {
			return state, err
		}
		if reason != "" {
			candidate.Reason = reason
			state.failed = append(state.failed, candidate)
			continue
		}
		if err := state.addUsage(customFetchUsage{Files: item.Files, Bytes: item.Bytes, Unknown: item.Unknown}, limits); err != nil {
			return state, err
		}
		state.prepared = append(state.prepared, item)
	}
	return state, nil
}

func summarizeCustomFetch(candidate customWorkCandidate, requestID string, tracks []kikoeru.Track, limits customFetchLimits) (preparedCustomFetch, string, error) {
	item := preparedCustomFetch{Candidate: candidate, RequestID: requestID, Paths: []string{}}
	for _, file := range flattenRemoteSaveFiles(tracks) {
		extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(file.Path), "."))
		if limits.excluded[extension] {
			continue
		}
		item.Paths = append(item.Paths, file.Path)
		item.Files++
		if file.SizeBytes == nil || *file.SizeBytes < 0 {
			item.Unknown++
			continue
		}
		var valid bool
		item.Bytes, valid = checkedAddInt64(item.Bytes, *file.SizeBytes)
		if !valid {
			return preparedCustomFetch{}, "", fmt.Errorf("fetch size metadata exceeds supported range")
		}
	}
	if item.Files == 0 {
		return item, "no_files_after_filter", nil
	}
	if item.Unknown > 0 && !limits.allowUnknown {
		return item, "unknown_file_size", nil
	}
	return item, "", nil
}

func (state *customFetchPreparation) addUsage(usage customFetchUsage, limits customFetchLimits) error {
	if usage.Files > limits.maxFiles-state.totalFiles {
		return fmt.Errorf("fetch file count exceeds maxFiles")
	}
	state.totalFiles += usage.Files
	var valid bool
	state.totalBytes, valid = checkedAddInt64(state.totalBytes, usage.Bytes)
	if !valid {
		return fmt.Errorf("fetch size metadata exceeds supported range")
	}
	if state.totalBytes > limits.maxBytes {
		return fmt.Errorf("fetch size exceeds maxBytes")
	}
	return nil
}

func (s *Server) enqueuePreparedCustomFetches(ctx context.Context, runID, userID int64, jobPriority int, node customWorkflowNode, limits customFetchLimits, state customFetchPreparation) (customFetchPreparation, error) {
	for _, item := range state.prepared {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return state, err
		}
		existing, found, err := s.remoteFetchRequestResult(ctx, item.RequestID, item.Candidate.SourceID, item.Candidate.Code)
		if err != nil {
			return state, err
		}
		if found {
			ref := customWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: item.Candidate.SourceID, ChildRunID: existing.RunID}
			state.pendingChildren = append(state.pendingChildren, customPendingChild{RunID: existing.RunID, Candidate: item.Candidate, WorkRef: ref})
			state.childRunIDs = append(state.childRunIDs, existing.RunID)
			continue
		}
		targetRoot := strings.ReplaceAll(limits.targetTemplate, "<work_code>", item.Candidate.Code)
		result, err := s.enqueueRemoteWorkSave(ctx, item.Candidate.SourceID, item.Candidate.Code, item.Paths, nil, targetRoot, item.RequestID, nil, limits.minFreeBytes, userID, jobPriority)
		if err != nil {
			item.Candidate.Reason = "fetch_queue_failed"
			state.failed = append(state.failed, item.Candidate)
			continue
		}
		ref := customWorkRef{Code: result.PrimaryCode, WorkID: result.WorkID, SourceID: item.Candidate.SourceID, ChildRunID: result.RunID}
		state.pendingChildren = append(state.pendingChildren, customPendingChild{RunID: result.RunID, Candidate: item.Candidate, WorkRef: ref})
		state.childRunIDs = append(state.childRunIDs, result.RunID)
	}
	return state, nil
}

func checkedAddInt64(left, right int64) (int64, bool) {
	if left < 0 || right < 0 || left > math.MaxInt64-right {
		return 0, false
	}
	return left + right, true
}

type customFetchUsage struct {
	Files   int
	Bytes   int64
	Unknown int
}

func (s *Server) customFetchPersistedUsage(ctx context.Context, runID int64) (customFetchUsage, error) {
	var manifestID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id
		FROM remote_fetch_manifest
		WHERE workflow_run_id = ?
	`, runID).Scan(&manifestID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return customFetchUsage{}, fmt.Errorf("persisted fetch request is missing its manifest")
		}
		return customFetchUsage{}, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT expected_size_bytes
		FROM remote_fetch_manifest_item
		WHERE manifest_id = ?
		ORDER BY id
	`, manifestID)
	if err != nil {
		return customFetchUsage{}, err
	}
	defer rows.Close()
	usage := customFetchUsage{}
	for rows.Next() {
		var size sql.NullInt64
		if err := rows.Scan(&size); err != nil {
			return customFetchUsage{}, err
		}
		usage.Files++
		if !size.Valid || size.Int64 < 0 {
			usage.Unknown++
			continue
		}
		var valid bool
		usage.Bytes, valid = checkedAddInt64(usage.Bytes, size.Int64)
		if !valid {
			return customFetchUsage{}, fmt.Errorf("persisted fetch size metadata exceeds supported range")
		}
	}
	if err := rows.Err(); err != nil {
		return customFetchUsage{}, err
	}
	if usage.Files == 0 {
		return customFetchUsage{}, fmt.Errorf("persisted fetch manifest contains no remote files")
	}
	return usage, nil
}

func (s *Server) executeCustomTagWorks(ctx context.Context, userID int64, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	refs := uniqueCustomWorkRefs(inputs["works"].WorkRefs)
	tagName := strings.TrimSpace(firstNonEmpty(inputs["tag"].Text, configString(node.Config, "tagName")))
	if tagName == "" || len([]rune(tagName)) > 40 {
		return customNodeExecution{}, fmt.Errorf("tag name is required and must be at most 40 characters")
	}
	workIDs := make([]int64, 0, len(refs))
	for _, ref := range refs {
		if ref.WorkID > 0 {
			workIDs = append(workIDs, ref.WorkID)
		}
	}
	if len(workIDs) > 0 {
		if _, err := s.addWorkUserTag(ctx, userID, workIDs, tagName); err != nil {
			return customNodeExecution{}, err
		}
	}
	return customNodeExecution{Outputs: map[string]customPortValue{
		"completed": {Type: "work_refs", WorkRefs: refs}, "failed": {Type: "work_refs", WorkRefs: []customWorkRef{}},
	}}, nil
}

func (s *Server) finishCustomWorkflowJob(ctx context.Context, job workflowJobRecord, checkpoint customWorkflowCheckpoint, total int) error {
	status := "succeeded"
	if checkpoint.Partial {
		status = "partial"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	runResult, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, status, mustJSON(map[string]any{"completed_nodes": len(checkpoint.CompletedNodeIDs), "child_run_ids": checkpoint.ChildRunIDs, "partial": checkpoint.Partial}), job.RunID)
	if err != nil {
		return err
	}
	updated, err := runResult.RowsAffected()
	if err != nil {
		return err
	}
	if updated == 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, progress_current = ?, progress_total = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL, error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, status, total, total, job.ID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		JobID: job.ID, Level: map[bool]string{true: "warn", false: "info"}[checkpoint.Partial], Type: "custom_workflow.completed",
		Message: "Custom workflow " + status, Detail: map[string]any{"status": status, "child_run_ids": checkpoint.ChildRunIDs},
	}); err != nil {
		return err
	}
	if err := updateCustomWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) failCustomWorkflowJob(ctx context.Context, job workflowJobRecord, failedNodeRunID int64, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "custom workflow failed"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	failedNodeID, failedNodeType, err := loadCustomWorkflowFailedNode(ctx, tx, job.RunID, failedNodeRunID)
	if err != nil {
		return err
	}
	updated, err := markCustomWorkflowRunAndJobFailed(ctx, tx, job, failedNodeRunID, message)
	if err != nil || !updated {
		return err
	}
	if err := markCustomWorkflowNodeRunsFailed(ctx, tx, job.RunID, failedNodeRunID, message); err != nil {
		return err
	}
	if err := insertCustomWorkflowFailureEvents(ctx, tx, job, failedNodeRunID, failedNodeID, failedNodeType, message); err != nil {
		return err
	}
	if err := updateCustomWorkflowTriggerFailure(ctx, tx, job.RunID, message); err != nil {
		return err
	}
	return tx.Commit()
}

func loadCustomWorkflowFailedNode(ctx context.Context, tx *sql.Tx, runID, nodeRunID int64) (string, string, error) {
	if nodeRunID <= 0 {
		return "", "", nil
	}
	var nodeID, nodeType string
	err := tx.QueryRowContext(ctx, "SELECT node_id, node_type FROM workflow_node_run WHERE id = ? AND workflow_run_id = ?", nodeRunID, runID).Scan(&nodeID, &nodeType)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", nil
	}
	return nodeID, nodeType, err
}

func markCustomWorkflowRunAndJobFailed(ctx context.Context, tx *sql.Tx, job workflowJobRecord, failedNodeRunID int64, message string) (bool, error) {
	var failedNodeValue any
	if failedNodeRunID > 0 {
		failedNodeValue = failedNodeRunID
	}
	runResult, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'failed', summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, mustJSON(map[string]any{"error": message, "failed_node_run_id": failedNodeValue}), job.RunID)
	if err != nil {
		return false, err
	}
	updated, err := runResult.RowsAffected()
	if err != nil {
		return false, err
	}
	if updated == 0 {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'failed', error_message = ?, locked_by = '', locked_at = NULL,
			heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, message, job.ID); err != nil {
		return false, err
	}
	return true, nil
}

func markCustomWorkflowNodeRunsFailed(ctx context.Context, tx *sql.Tx, runID, failedNodeRunID int64, message string) error {
	if failedNodeRunID > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND workflow_run_id = ?
		`, message, failedNodeRunID, runID); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'skipped', error_message = 'Not executed because a previous node failed', finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ? AND id <> ? AND status IN ('queued', 'running')
	`, runID, failedNodeRunID)
	return err
}

func insertCustomWorkflowFailureEvents(ctx context.Context, tx *sql.Tx, job workflowJobRecord, failedNodeRunID int64, failedNodeID, failedNodeType, message string) error {
	if failedNodeRunID > 0 {
		if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
			NodeRunID: failedNodeRunID, JobID: job.ID, Level: "error", Type: "custom_workflow.node_failed",
			Message: message, Detail: map[string]any{"node_id": failedNodeID, "node_type": failedNodeType, "status": "failed"},
		}); err != nil {
			return err
		}
	}
	var failedNodeValue any
	if failedNodeRunID > 0 {
		failedNodeValue = failedNodeRunID
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: failedNodeRunID, JobID: job.ID, Level: "error", Type: "custom_workflow.failed",
		Message: message, Detail: map[string]any{"failed_node_run_id": failedNodeValue},
	}); err != nil {
		return err
	}
	return nil
}

func uniqueCustomCandidates(values []customWorkCandidate) []customWorkCandidate {
	result := []customWorkCandidate{}
	seen := map[string]bool{}
	for _, value := range values {
		value.Code = strings.ToUpper(strings.TrimSpace(value.Code))
		key := fmt.Sprintf("%d:%s", value.SourceID, value.Code)
		if value.Code == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}

func uniqueCustomWorkRefs(values []customWorkRef) []customWorkRef {
	result := []customWorkRef{}
	seen := map[int64]bool{}
	for _, value := range values {
		if value.WorkID <= 0 || seen[value.WorkID] {
			continue
		}
		seen[value.WorkID] = true
		result = append(result, value)
	}
	return result
}

func customPortValuesSummary(values map[string]customPortValue) map[string]any {
	result := map[string]any{}
	for handle, value := range values {
		summary := map[string]any{"type": value.Type}
		switch value.Type {
		case "work_candidates":
			summary["count"] = len(value.Candidates)
			codes := make([]string, 0, min(len(value.Candidates), 100))
			for index, candidate := range value.Candidates {
				if index >= 100 {
					break
				}
				codes = append(codes, candidate.Code)
			}
			summary["codes"] = codes
		case "work_refs":
			summary["count"] = len(value.WorkRefs)
			summary["works"] = value.WorkRefs
		default:
			summary["characters"] = len([]rune(value.Text))
		}
		result[handle] = summary
	}
	return result
}

func customExtensionSet(values []string) map[string]bool {
	result := map[string]bool{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "."))
		if value != "" && len(value) <= 16 {
			result[value] = true
		}
	}
	return result
}

func customFetchRequestID(runID int64, nodeID, code string) string {
	nodeID = regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(nodeID, "_")
	return fmt.Sprintf("cw:%d:%s:%s", runID, nodeID, strings.ToUpper(strings.TrimSpace(code)))
}

func customTrackRequestID(runID int64, nodeID string, sourceID int64, code string) string {
	nodeID = regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(nodeID, "_")
	return fmt.Sprintf("cw-track:%d:%s:%d:%s", runID, nodeID, sourceID, strings.ToUpper(strings.TrimSpace(code)))
}

func (s *Server) customTrackRequestResult(ctx context.Context, requestID string, sourceID int64, code string) (remoteWorkSyncResult, bool, error) {
	var result remoteWorkSyncResult
	err := s.db.QueryRowContext(ctx, `
		SELECT child.id,
			COALESCE(job.id, 0),
			COALESCE(CAST(json_extract(match_node.output_json, '$.work_id') AS INTEGER), 0),
			COALESCE(CAST(json_extract(child.input_json, '$.work_code') AS TEXT), '')
		FROM workflow_run AS child
		LEFT JOIN workflow_node_run AS match_node
			ON match_node.workflow_run_id = child.id AND match_node.node_id = 'match'
		LEFT JOIN workflow_job AS job ON job.workflow_run_id = child.id
		WHERE child.workflow_code = 'remote_source_sync'
			AND child.status IN ('succeeded', 'partial')
			AND child.trigger_reason = ?
			AND CAST(json_extract(child.input_json, '$.file_source_id') AS INTEGER) = ?
			AND UPPER(COALESCE(
				CAST(json_extract(child.input_json, '$.requested_work_code') AS TEXT),
				CAST(json_extract(child.input_json, '$.work_code') AS TEXT),
				''
			)) = ?
		ORDER BY child.id DESC, job.id
		LIMIT 1
	`, requestID, sourceID, strings.ToUpper(strings.TrimSpace(code))).Scan(&result.RunID, &result.JobID, &result.WorkID, &result.PrimaryCode)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkSyncResult{}, false, nil
	}
	if err != nil {
		return remoteWorkSyncResult{}, false, err
	}
	if result.RunID <= 0 || result.WorkID <= 0 || strings.TrimSpace(result.PrimaryCode) == "" {
		return remoteWorkSyncResult{}, false, fmt.Errorf("completed track request result is incomplete")
	}
	result.Status = "succeeded"
	result.Tracked = true
	result.TriggerReason = requestID
	return result, true, nil
}

func publicCustomWorkflowError(nodeType string) string {
	switch nodeType {
	case "circle_catalog":
		return "circle catalog request failed"
	case "series_catalog":
		return "series catalog query failed"
	case "voice_source_works", "check_source_availability", "track_works":
		return "remote source operation failed"
	case "fetch_works":
		return "fetch planning or submission failed"
	case "tag_works":
		return "tag assignment failed"
	default:
		return "custom workflow node failed"
	}
}

func normalizeCustomWorkCodes(values []string, limit int) ([]string, error) {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		code := strings.ToUpper(strings.TrimSpace(value))
		if code == "" || seen[code] {
			continue
		}
		if !customWorkflowWorkCodePattern.MatchString(code) {
			return nil, fmt.Errorf("invalid work code: %s", code)
		}
		seen[code] = true
		result = append(result, code)
		if limit > 0 && len(result) > limit {
			return nil, fmt.Errorf("too many work codes; maximum is %d", limit)
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("at least one work code is required")
	}
	return result, nil
}

func customCandidatesForCodes(codes []string, sourceID int64) []customWorkCandidate {
	result := make([]customWorkCandidate, 0, len(codes))
	for _, code := range codes {
		result = append(result, customWorkCandidate{Code: strings.ToUpper(strings.TrimSpace(code)), SourceID: sourceID})
	}
	return result
}
