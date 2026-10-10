package httpapi

// Workflow graph definition and node configuration validation.

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

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
