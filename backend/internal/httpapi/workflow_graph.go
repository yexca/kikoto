package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// A workflow graph is the typed DAG that preset workflows compose on the server.
// It runs as one recoverable job whose persisted worker type remains
// "custom_workflow" for existing queues and run history.
const workflowGraphSchemaVersion = 2

var (
	workflowGraphIDPattern       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	workflowGraphWorkCodePattern = regexp.MustCompile(`(?i)^(RJ|BJ|VJ|CC)[0-9]{5,8}$`)
)

type workflowGraphDefinition struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Nodes         []workflowGraphNode `json:"nodes"`
	Edges         []workflowGraphEdge `json:"edges"`
	Policy        workflowGraphPolicy `json:"policy,omitempty"`
}

type workflowGraphPolicy struct {
	RequirePreview *bool `json:"requirePreview,omitempty"`
}

type workflowGraphNode struct {
	ID          string                `json:"id"`
	Type        string                `json:"type"`
	DisplayName string                `json:"displayName"`
	Config      map[string]any        `json:"config"`
	Position    workflowGraphPosition `json:"position"`
}

type workflowGraphPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type workflowGraphEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	SourceHandle string `json:"sourceHandle"`
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
}

type workflowGraph struct {
	Definition       workflowGraphDefinition
	NodesByID        map[string]workflowGraphNode
	IncomingByNode   map[string][]workflowGraphEdge
	TopologicalOrder []string
}

type workflowGraphEdgeState struct {
	edgeIDs     map[string]bool
	targetPorts map[string]bool
	incoming    map[string][]workflowGraphEdge
	adjacency   map[string][]string
	indegree    map[string]int
}

type workflowRunGraph struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Nodes         []workflowRunGraphNode `json:"nodes"`
	Edges         []workflowRunGraphEdge `json:"edges"`
}

type workflowRunGraphNode struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	DisplayName string                 `json:"displayName"`
	Position    workflowGraphPosition  `json:"position"`
	Inputs      []workflowRunGraphPort `json:"inputs"`
	Outputs     []workflowRunGraphPort `json:"outputs"`
}

type workflowRunGraphPort struct {
	ID       string `json:"id"`
	DataType string `json:"dataType"`
}

type workflowRunGraphEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	SourceHandle string `json:"sourceHandle"`
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
	DataType     string `json:"dataType"`
}

type workflowGraphPort struct {
	ID       string
	DataType string
	Required bool
}

type workflowGraphCapability struct {
	Type        string
	Phase       string
	DisplayName string
	Description string
	Inputs      []workflowGraphPort
	Outputs     []workflowGraphPort
	Permissions []string
	Composite   bool
	ConfigKeys  []string
}

var workflowGraphCapabilities = map[string]workflowGraphCapability{
	"circle_catalog": {
		Type: "circle_catalog", Phase: "discover", DisplayName: "Circle catalog",
		Description: "Read or refresh a circle catalog without materializing every discovered work.",
		Inputs:      []workflowGraphPort{{ID: "circle", DataType: "circle_id", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "works", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"circleId", "mode", "maxWorks"},
	},
	"series_catalog": {
		Type: "series_catalog", Phase: "discover", DisplayName: "Series catalog",
		Description: "Read stored work codes for one provider series without creating works.",
		Inputs:      []workflowGraphPort{{ID: "series", DataType: "series_id", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "works", DataType: "work_candidates"}}, Composite: true,
		ConfigKeys: []string{"seriesId", "circleExternalId", "maxWorks"},
	},
	"voice_catalog": {
		Type: "voice_catalog", Phase: "discover", DisplayName: "Voice actor catalog",
		Description: "Read or refresh a voice actor's persisted remote catalog without materializing discovered works.",
		Outputs:     []workflowGraphPort{{ID: "works", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"personId", "sourceIds", "mode", "maxWorks"},
	},
	"circle_metadata": {
		Type: "circle_metadata", Phase: "commit", DisplayName: "Refresh circle metadata",
		Description: "Synchronize provider metadata for a circle's catalog works that lack it, or for every catalog work.",
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"circleId", "productMode"},
	},
	"circle_sources": {
		Type: "circle_sources", Phase: "discover", DisplayName: "Check circle sources",
		Description: "Match a circle's works on the selected compatible remote sources.",
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"circleId", "sourceIds", "mode"},
	},
	"voice_metadata": {
		Type: "voice_metadata", Phase: "commit", DisplayName: "Refresh known-work metadata",
		Description: "Synchronize provider metadata for a voice actor's known works that lack it, or for every known work.",
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"personId", "mode"},
	},
	"filter_works": {
		Type: "filter_works", Phase: "filter", DisplayName: "Filter works",
		Description: "Apply bounded, structured filters to work candidates.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "accepted", DataType: "work_candidates"}, {ID: "rejected", DataType: "work_candidates"}},
		ConfigKeys:  []string{"limit", "codePrefix", "existing", "releaseFrom", "releaseTo", "voiceNames", "metadataTags", "userTags"},
	},
	"metadata_sync": {
		Type: "metadata_sync", Phase: "commit", DisplayName: "Sync metadata",
		Description: "Materialize accepted candidates and synchronize normalized provider metadata.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"maxWorks"},
	},
	"track_works": {
		Type: "track_works", Phase: "execute", DisplayName: "Track works",
		Description: "Track available source works through the existing remote sync domain operation.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"sourceId", "maxWorks"},
	},
	"fetch_works": {
		Type: "fetch_works", Phase: "execute", DisplayName: "Fetch works",
		Description: "Queue the existing recoverable Fetch transaction for bounded, filtered remote files.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"downloads:manage"}, Composite: true,
		ConfigKeys: []string{"sourceId", "excludeExtensions", "maxWorks", "maxFiles", "maxBytes", "minFreeBytes", "allowUnknownSizes", "targetRoot"},
	},
	"tag_works": {
		Type: "tag_works", Phase: "commit", DisplayName: "Tag works",
		Description: "Assign a user-owned tag to works materialized by prior actions.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_refs", Required: true}, {ID: "tag", DataType: "text"}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_refs"}},
		Permissions: []string{"tags:write"}, Composite: true, ConfigKeys: []string{"tagName"},
	},
}

func validateWorkflowGraphDefinition(raw string) (workflowGraph, error) {
	definition, err := parseWorkflowGraphDefinition(raw)
	if err != nil {
		return workflowGraph{}, err
	}
	requiresPreview := workflowGraphRequiresPreview(definition)
	nodesByID, nodeOrder, err := validateWorkflowGraphNodes(&definition, requiresPreview)
	if err != nil {
		return workflowGraph{}, err
	}
	edges, err := validateWorkflowGraphEdges(&definition, nodesByID)
	if err != nil {
		return workflowGraph{}, err
	}
	if err := validateWorkflowGraphRequiredInputs(definition, edges.targetPorts); err != nil {
		return workflowGraph{}, err
	}
	topological, err := workflowGraphTopologicalOrder(nodesByID, edges.adjacency, edges.indegree, nodeOrder)
	if err != nil {
		return workflowGraph{}, err
	}
	return workflowGraph{
		Definition:       definition,
		NodesByID:        nodesByID,
		IncomingByNode:   edges.incoming,
		TopologicalOrder: topological,
	}, nil
}

func parseWorkflowGraphDefinition(raw string) (workflowGraphDefinition, error) {
	var definition workflowGraphDefinition
	if err := json.Unmarshal([]byte(raw), &definition); err != nil {
		return workflowGraphDefinition{}, fmt.Errorf("definition JSON is invalid")
	}
	if definition.SchemaVersion != workflowGraphSchemaVersion {
		return workflowGraphDefinition{}, fmt.Errorf("custom workflow schemaVersion must be 2")
	}
	if len(definition.Nodes) == 0 || len(definition.Nodes) > 100 {
		return workflowGraphDefinition{}, fmt.Errorf("custom workflow needs 1-100 nodes")
	}
	if len(definition.Edges) > 300 {
		return workflowGraphDefinition{}, fmt.Errorf("custom workflow supports at most 300 edges")
	}
	return definition, nil
}

func validateWorkflowGraphNodes(
	definition *workflowGraphDefinition,
	requiresPreview bool,
) (map[string]workflowGraphNode, map[string]int, error) {
	nodesByID := make(map[string]workflowGraphNode, len(definition.Nodes))
	nodeOrder := make(map[string]int, len(definition.Nodes))
	for index := range definition.Nodes {
		node := &definition.Nodes[index]
		node.ID = strings.TrimSpace(node.ID)
		node.Type = strings.TrimSpace(node.Type)
		node.DisplayName = strings.TrimSpace(node.DisplayName)
		if !workflowGraphIDPattern.MatchString(node.ID) {
			return nil, nil, fmt.Errorf("invalid node id: %s", node.ID)
		}
		if _, exists := nodesByID[node.ID]; exists {
			return nil, nil, fmt.Errorf("node id must be unique: %s", node.ID)
		}
		capability, exists := workflowGraphCapabilities[node.Type]
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
		if err := validateWorkflowGraphNodeConfig(*node, requiresPreview); err != nil {
			return nil, nil, err
		}
		nodesByID[node.ID] = *node
		nodeOrder[node.ID] = index
	}
	return nodesByID, nodeOrder, nil
}

func validateWorkflowGraphEdges(
	definition *workflowGraphDefinition,
	nodesByID map[string]workflowGraphNode,
) (workflowGraphEdgeState, error) {
	state := workflowGraphEdgeState{
		edgeIDs:     map[string]bool{},
		targetPorts: map[string]bool{},
		incoming:    map[string][]workflowGraphEdge{},
		adjacency:   map[string][]string{},
		indegree:    map[string]int{},
	}
	for nodeID := range nodesByID {
		state.indegree[nodeID] = 0
	}
	for index := range definition.Edges {
		if err := validateWorkflowGraphEdge(&definition.Edges[index], nodesByID, &state); err != nil {
			return workflowGraphEdgeState{}, err
		}
	}
	return state, nil
}

func validateWorkflowGraphEdge(
	edge *workflowGraphEdge,
	nodesByID map[string]workflowGraphNode,
	state *workflowGraphEdgeState,
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
	sourcePorts := graphNodeOutputPorts(source)
	targetPortsForNode := graphNodeInputPorts(target)
	if edge.SourceHandle == "" && len(sourcePorts) == 1 {
		edge.SourceHandle = sourcePorts[0].ID
	}
	if edge.TargetHandle == "" && len(targetPortsForNode) == 1 {
		edge.TargetHandle = targetPortsForNode[0].ID
	}
	sourcePort, ok := findGraphPort(sourcePorts, edge.SourceHandle)
	if !ok {
		return fmt.Errorf("unknown output port %s.%s", edge.Source, edge.SourceHandle)
	}
	targetPort, ok := findGraphPort(targetPortsForNode, edge.TargetHandle)
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

func validateWorkflowGraphRequiredInputs(definition workflowGraphDefinition, targetPorts map[string]bool) error {
	for _, node := range definition.Nodes {
		for _, port := range graphNodeInputPorts(node) {
			if port.Required && !targetPorts[node.ID+":"+port.ID] && !graphNodeConfigSuppliesPort(node, port.ID) {
				return fmt.Errorf("required input is not connected: %s.%s", node.ID, port.ID)
			}
		}
	}
	return nil
}

func workflowGraphTopologicalOrder(
	nodesByID map[string]workflowGraphNode,
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

func workflowGraphRequiresPreview(definition workflowGraphDefinition) bool {
	return definition.Policy.RequirePreview == nil || *definition.Policy.RequirePreview
}

type workflowGraphNodeConfigValidator func(workflowGraphNode, bool) error

var workflowGraphNodeConfigValidators = map[string]workflowGraphNodeConfigValidator{
	"circle_catalog":  validateGraphCircleCatalogConfig,
	"series_catalog":  validateGraphSeriesCatalogConfig,
	"voice_catalog":   validateGraphVoiceCatalogConfig,
	"circle_metadata": validateGraphCircleMetadataConfig,
	"circle_sources":  validateGraphCircleSourcesConfig,
	"voice_metadata":  validateGraphVoiceMetadataConfig,
	"filter_works":    validateGraphFilterWorksConfig,
	"metadata_sync":   validateGraphMetadataSyncConfig,
	"track_works":     validateGraphTrackWorksConfig,
	"fetch_works":     validateGraphFetchWorksConfig,
	"tag_works":       validateGraphTagWorksConfig,
}

func validateWorkflowGraphNodeConfig(node workflowGraphNode, requiresPreview bool) error {
	if err := validateWorkflowGraphConfigKeys(node); err != nil {
		return err
	}
	if err := validateWorkflowGraphConfigTypes(node); err != nil {
		return err
	}
	validator := workflowGraphNodeConfigValidators[node.Type]
	if validator == nil {
		return nil
	}
	return validator(node, requiresPreview)
}

func validateWorkflowGraphConfigKeys(node workflowGraphNode) error {
	capability := workflowGraphCapabilities[node.Type]
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

func validateWorkflowGraphBound(node workflowGraphNode, key string, fallback, maximum int64, required bool) error {
	raw, explicit := node.Config[key]
	value := fallback
	if explicit {
		var valid bool
		value, valid = graphConfigInteger(raw)
		if !valid {
			return fmt.Errorf("node %s config %s must be an integer", node.ID, key)
		}
	}
	if (required && !explicit) || value <= 0 || value > maximum {
		return fmt.Errorf("node %s requires %s between 1 and %d", node.ID, key, maximum)
	}
	return nil
}

func validateGraphPositiveConfigID(node workflowGraphNode, key string) error {
	value, ok := graphConfigInteger(node.Config[key])
	if !ok || value <= 0 || value > math.MaxInt32 {
		return fmt.Errorf("node %s requires a %s", node.ID, key)
	}
	return nil
}

func validateGraphCircleCatalogConfig(node workflowGraphNode, requiresPreview bool) error {
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
	return validateWorkflowGraphBound(node, "maxWorks", 100, 5000, !requiresPreview)
}

func validateGraphSeriesCatalogConfig(node workflowGraphNode, requiresPreview bool) error {
	return validateWorkflowGraphBound(node, "maxWorks", 100, 5000, !requiresPreview)
}

func validateGraphVoiceCatalogConfig(node workflowGraphNode, requiresPreview bool) error {
	if err := validateGraphPositiveConfigID(node, "personId"); err != nil {
		return err
	}
	mode := strings.ToLower(configString(node.Config, "mode"))
	if mode == "" {
		mode = "stored"
	}
	if mode != "stored" && mode != "incremental" && mode != "full" {
		return fmt.Errorf("node %s has invalid catalog mode", node.ID)
	}
	if mode != "stored" && len(configInt64Slice(node.Config, "sourceIds")) == 0 {
		return fmt.Errorf("node %s requires sourceIds to refresh the catalog", node.ID)
	}
	return validateWorkflowGraphBound(node, "maxWorks", 100, 5000, !requiresPreview)
}

func validateGraphCircleMetadataConfig(node workflowGraphNode, _ bool) error {
	if configString(node.Config, "circleId") == "" {
		return fmt.Errorf("node %s requires a circleId", node.ID)
	}
	if mode := configString(node.Config, "productMode"); mode != "available" && mode != "all" {
		return fmt.Errorf("node %s has invalid productMode", node.ID)
	}
	return nil
}

func validateGraphCircleSourcesConfig(node workflowGraphNode, _ bool) error {
	if configString(node.Config, "circleId") == "" {
		return fmt.Errorf("node %s requires a circleId", node.ID)
	}
	if len(configInt64Slice(node.Config, "sourceIds")) == 0 {
		return fmt.Errorf("node %s requires sourceIds", node.ID)
	}
	if mode := configString(node.Config, "mode"); mode != "incremental" && mode != "full" {
		return fmt.Errorf("node %s has invalid source check mode", node.ID)
	}
	return nil
}

func validateGraphVoiceMetadataConfig(node workflowGraphNode, _ bool) error {
	if err := validateGraphPositiveConfigID(node, "personId"); err != nil {
		return err
	}
	if mode := configString(node.Config, "mode"); mode != "incremental" && mode != "full" {
		return fmt.Errorf("node %s has invalid metadata mode", node.ID)
	}
	return nil
}

func validateGraphFilterWorksConfig(node workflowGraphNode, _ bool) error {
	if err := validateGraphWorkFilterConfig(node); err != nil {
		return err
	}
	existing := strings.ToLower(configString(node.Config, "existing"))
	if node.Type == "filter_works" && existing != "" && existing != "any" && existing != "known" && existing != "unknown" && existing != "missing_metadata" {
		return fmt.Errorf("node %s has invalid existing filter", node.ID)
	}
	if _, configured := node.Config["limit"]; configured {
		return validateWorkflowGraphBound(node, "limit", 100, 5000, false)
	}
	return nil
}

// A follow without a work limit syncs up to the whole catalog bound.
func validateGraphMetadataSyncConfig(node workflowGraphNode, requiresPreview bool) error {
	return validateWorkflowGraphBound(node, "maxWorks", 25, presetWorkflowMaxCatalogSize, !requiresPreview)
}

func validateGraphTrackWorksConfig(node workflowGraphNode, requiresPreview bool) error {
	return validateWorkflowGraphBound(node, "maxWorks", 25, 500, !requiresPreview)
}

func validateGraphFetchWorksConfig(node workflowGraphNode, requiresPreview bool) error {
	requireBound := !requiresPreview
	if err := validateWorkflowGraphBound(node, "maxWorks", 25, 100, requireBound); err != nil {
		return err
	}
	if err := validateWorkflowGraphBound(node, "maxFiles", 10000, 50000, requireBound); err != nil {
		return err
	}
	if err := validateWorkflowGraphBound(node, "maxBytes", 100*1024*1024*1024, 2*1024*1024*1024*1024, requireBound); err != nil {
		return err
	}
	if _, configured := node.Config["minFreeBytes"]; configured || requireBound {
		if err := validateWorkflowGraphBound(node, "minFreeBytes", 2*1024*1024*1024, 1024*1024*1024*1024, requireBound); err != nil {
			return err
		}
	}
	_, unknownSizePolicySet := node.Config["allowUnknownSizes"]
	if !requiresPreview && (!unknownSizePolicySet || configBool(node.Config, "allowUnknownSizes", false)) {
		return fmt.Errorf("node %s requires allowUnknownSizes=false when preview is disabled", node.ID)
	}
	return nil
}

func validateGraphTagWorksConfig(node workflowGraphNode, _ bool) error {
	if tagName := configString(node.Config, "tagName"); len([]rune(tagName)) > 40 {
		return fmt.Errorf("node %s tagName is too long", node.ID)
	}
	return nil
}

type workflowGraphConfigKind uint8

const (
	workflowGraphStringConfig workflowGraphConfigKind = iota
	workflowGraphIntegerConfig
	workflowGraphStringArrayConfig
	workflowGraphBooleanConfig
	workflowGraphIntegerArrayConfig
)

var workflowGraphConfigKinds = map[string]workflowGraphConfigKind{
	"sourceId":          workflowGraphIntegerConfig,
	"personId":          workflowGraphIntegerConfig,
	"sourceIds":         workflowGraphIntegerArrayConfig,
	"definitionId":      workflowGraphIntegerConfig,
	"pageSize":          workflowGraphIntegerConfig,
	"maxPages":          workflowGraphIntegerConfig,
	"maxWorks":          workflowGraphIntegerConfig,
	"limit":             workflowGraphIntegerConfig,
	"maxFiles":          workflowGraphIntegerConfig,
	"maxBytes":          workflowGraphIntegerConfig,
	"minFreeBytes":      workflowGraphIntegerConfig,
	"year":              workflowGraphIntegerConfig,
	"codes":             workflowGraphStringArrayConfig,
	"excludeExtensions": workflowGraphStringArrayConfig,
	"voiceNames":        workflowGraphStringArrayConfig,
	"metadataTags":      workflowGraphStringArrayConfig,
	"userTags":          workflowGraphStringArrayConfig,
	"allowUnknownSizes": workflowGraphBooleanConfig,
}

func validateWorkflowGraphConfigTypes(node workflowGraphNode) error {
	for key, value := range node.Config {
		if err := validateWorkflowGraphConfigType(node.ID, key, value); err != nil {
			return err
		}
	}
	return validateWorkflowGraphExcludedExtensions(node)
}

func validateWorkflowGraphConfigType(nodeID, key string, value any) error {
	switch workflowGraphConfigKinds[key] {
	case workflowGraphIntegerConfig:
		if _, ok := graphConfigInteger(value); !ok {
			return fmt.Errorf("node %s config %s must be an integer", nodeID, key)
		}
	case workflowGraphStringArrayConfig:
		if !workflowGraphStringArray(value) {
			return fmt.Errorf("node %s config %s must be an array of strings", nodeID, key)
		}
	case workflowGraphBooleanConfig:
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("node %s config %s must be a boolean", nodeID, key)
		}
	case workflowGraphIntegerArrayConfig:
		if _, ok := graphIntegerArray(value); !ok {
			return fmt.Errorf("node %s config %s must be an array of integers", nodeID, key)
		}
	default:
		if _, ok := value.(string); !ok {
			return fmt.Errorf("node %s config %s must be a string", nodeID, key)
		}
	}
	return nil
}

// graphIntegerArray accepts integer lists before and after a JSON round trip.
func graphIntegerArray(value any) ([]int64, bool) {
	switch items := value.(type) {
	case []int64:
		return items, true
	case []any:
		result := make([]int64, 0, len(items))
		for _, item := range items {
			number, ok := graphConfigInteger(item)
			if !ok {
				return nil, false
			}
			result = append(result, number)
		}
		return result, true
	default:
		return nil, false
	}
}

func workflowGraphStringArray(value any) bool {
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

func validateWorkflowGraphExcludedExtensions(node workflowGraphNode) error {
	for _, extension := range configStringSlice(node.Config, "excludeExtensions") {
		extension = strings.TrimPrefix(strings.TrimSpace(extension), ".")
		if extension == "" || len(extension) > 16 || strings.ContainsAny(extension, `/\\`) {
			return fmt.Errorf("node %s has invalid excluded extension", node.ID)
		}
	}
	return nil
}

func validateGraphWorkFilterConfig(node workflowGraphNode) error {
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

func graphConfigInteger(value any) (int64, bool) {
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

func graphNodeInputPorts(node workflowGraphNode) []workflowGraphPort {
	return append([]workflowGraphPort{}, workflowGraphCapabilities[node.Type].Inputs...)
}

func graphNodeOutputPorts(node workflowGraphNode) []workflowGraphPort {
	return append([]workflowGraphPort{}, workflowGraphCapabilities[node.Type].Outputs...)
}

func publicWorkflowRunGraph(graph workflowGraph) workflowRunGraph {
	result := workflowRunGraph{SchemaVersion: 1, Nodes: []workflowRunGraphNode{}, Edges: []workflowRunGraphEdge{}}
	for _, node := range graph.Definition.Nodes {
		runNode := workflowRunGraphNode{
			ID: node.ID, Type: node.Type, DisplayName: node.DisplayName, Position: node.Position,
			Inputs: []workflowRunGraphPort{}, Outputs: []workflowRunGraphPort{},
		}
		for _, port := range graphNodeInputPorts(node) {
			runNode.Inputs = append(runNode.Inputs, workflowRunGraphPort{ID: port.ID, DataType: port.DataType})
		}
		for _, port := range graphNodeOutputPorts(node) {
			runNode.Outputs = append(runNode.Outputs, workflowRunGraphPort{ID: port.ID, DataType: port.DataType})
		}
		result.Nodes = append(result.Nodes, runNode)
	}
	for _, edge := range graph.Definition.Edges {
		dataType := "dynamic"
		if source, ok := graph.NodesByID[edge.Source]; ok {
			if port, found := findGraphPort(graphNodeOutputPorts(source), edge.SourceHandle); found {
				dataType = port.DataType
			}
		}
		result.Edges = append(result.Edges, workflowRunGraphEdge{
			ID: edge.ID, Source: edge.Source, SourceHandle: edge.SourceHandle,
			Target: edge.Target, TargetHandle: edge.TargetHandle, DataType: dataType,
		})
	}
	return result
}

func (s *Server) workflowRunGraphJSON(ctx context.Context, runID int64) (string, error) {
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
	var payload workflowGraphJobPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return "{}", nil
	}
	graph, err := validateWorkflowGraphDefinition(payload.DefinitionJSON)
	if err != nil {
		return "{}", nil
	}
	encoded, err := json.Marshal(publicWorkflowRunGraph(graph))
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func findGraphPort(ports []workflowGraphPort, id string) (workflowGraphPort, bool) {
	for _, port := range ports {
		if port.ID == id {
			return port, true
		}
	}
	return workflowGraphPort{}, false
}

func graphNodeConfigSuppliesPort(node workflowGraphNode, portID string) bool {
	switch node.Type + ":" + portID {
	case "circle_catalog:circle":
		return configString(node.Config, "circleId") != ""
	case "series_catalog:series":
		return configString(node.Config, "seriesId") != ""
	case "tag_works:tag":
		return configString(node.Config, "tagName") != ""
	default:
		return false
	}
}

func graphStringValues(value any) ([]string, error) {
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

func workflowGraphRequiredPermissions(graph workflowGraph) []string {
	permissions := map[string]bool{"workflows:run": true}
	for _, node := range graph.Definition.Nodes {
		capability := workflowGraphCapabilities[node.Type]
		for _, permission := range capability.Permissions {
			mode := strings.ToLower(configString(node.Config, "mode"))
			// Reading a stored catalog writes nothing; only a catalog refresh needs metadata:sync.
			if (node.Type == "circle_catalog" || node.Type == "voice_catalog") && (mode == "" || mode == "stored") && permission == "metadata:sync" {
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

func missingWorkflowGraphPermission(actual []string, required []string) string {
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
