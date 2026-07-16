package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	texttemplate "text/template"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const customWorkflowSchemaVersion = 2

var (
	customWorkflowIDPattern       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	customWorkflowAliasPattern    = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{1,31}$`)
	customWorkflowInputKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
	customWorkflowWorkCodePattern = regexp.MustCompile(`(?i)^(RJ|BJ|VJ|CC)[0-9]{4,8}$`)
)

type customWorkflowDefinition struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Command       customWorkflowCommand `json:"command,omitempty"`
	Inputs        []customWorkflowInput `json:"inputs,omitempty"`
	Nodes         []customWorkflowNode  `json:"nodes"`
	Edges         []customWorkflowEdge  `json:"edges"`
	Policy        customWorkflowPolicy  `json:"policy,omitempty"`
}

type customWorkflowCommand struct {
	Enabled bool   `json:"enabled"`
	Alias   string `json:"alias"`
}

type customWorkflowPolicy struct {
	RequirePreview *bool `json:"requirePreview,omitempty"`
}

type customWorkflowInput struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	Type         string `json:"type"`
	Required     bool   `json:"required"`
	DefaultValue any    `json:"defaultValue,omitempty"`
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
	"workflow_input": {
		Type: "workflow_input", Phase: "target", DisplayName: "Workflow input",
		Description: "Read one typed value supplied when the workflow starts.",
		Outputs:     []customWorkflowPort{{ID: "value", DataType: "dynamic"}}, ConfigKeys: []string{"inputKey"},
	},
	"input_text": {
		Type: "input_text", Phase: "target", DisplayName: "Text input",
		Description: "Provide text from a workflow input or a configured value.",
		Outputs:     []customWorkflowPort{{ID: "value", DataType: "text"}}, ConfigKeys: []string{"inputKey", "value"},
	},
	"input_circle": {
		Type: "input_circle", Phase: "target", DisplayName: "Circle input",
		Description: "Provide a validated DLsite circle id.",
		Outputs:     []customWorkflowPort{{ID: "value", DataType: "circle_id"}}, ConfigKeys: []string{"inputKey", "value"},
	},
	"input_series": {
		Type: "input_series", Phase: "target", DisplayName: "Series input",
		Description: "Provide a provider series id.",
		Outputs:     []customWorkflowPort{{ID: "value", DataType: "series_id"}}, ConfigKeys: []string{"inputKey", "value"},
	},
	"input_voice": {
		Type: "input_voice", Phase: "target", DisplayName: "Voice input",
		Description: "Provide a voice actor name.",
		Outputs:     []customWorkflowPort{{ID: "value", DataType: "voice_name"}}, ConfigKeys: []string{"inputKey", "value"},
	},
	"input_work": {
		Type: "input_work", Phase: "target", DisplayName: "Work input",
		Description: "Provide one or more validated work codes.",
		Outputs:     []customWorkflowPort{{ID: "works", DataType: "work_candidates"}}, ConfigKeys: []string{"inputKey", "codes"},
	},
	"template_text": {
		Type: "template_text", Phase: "filter", DisplayName: "Text template",
		Description: "Render text from workflow inputs and a frozen run timestamp.",
		Inputs:      []customWorkflowPort{{ID: "value", DataType: "text"}},
		Outputs:     []customWorkflowPort{{ID: "text", DataType: "text"}}, ConfigKeys: []string{"template"},
	},
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
		ConfigKeys:  []string{"limit", "codePrefix", "existing"},
	},
	"check_source_availability": {
		Type: "check_source_availability", Phase: "match", DisplayName: "Check source availability",
		Description: "Health-gate one source and partition candidates into available, missing, and error outputs.",
		Inputs:      []customWorkflowPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []customWorkflowPort{{ID: "available", DataType: "work_candidates"}, {ID: "missing", DataType: "work_candidates"}, {ID: "error", DataType: "work_candidates"}},
		Permissions: []string{"library:read"}, Composite: true, ConfigKeys: []string{"sourceId"},
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
		ConfigKeys: []string{"sourceId", "excludeExtensions", "maxWorks", "maxFiles", "maxBytes", "allowUnknownSizes", "targetRoot"},
	},
	"tag_works": {
		Type: "tag_works", Phase: "commit", DisplayName: "Tag works",
		Description: "Assign a user-owned tag to works materialized by prior actions.",
		Inputs:      []customWorkflowPort{{ID: "works", DataType: "work_refs", Required: true}, {ID: "tag", DataType: "text"}},
		Outputs:     []customWorkflowPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_refs"}},
		Permissions: []string{"tags:write"}, Composite: true, ConfigKeys: []string{"tagName"},
	},
}

func customWorkflowNodeTypeRecords() []workflowNodeTypeRecord {
	types := make([]string, 0, len(customWorkflowCapabilities))
	for nodeType := range customWorkflowCapabilities {
		types = append(types, nodeType)
	}
	sort.Strings(types)
	result := make([]workflowNodeTypeRecord, 0, len(types))
	for _, nodeType := range types {
		capability := customWorkflowCapabilities[nodeType]
		record := workflowNodeTypeRecord{
			Type: nodeType, Phase: capability.Phase, DisplayName: capability.DisplayName,
			Description: capability.Description, UserVisible: true, ConfigSchema: customWorkflowConfigSchema(capability),
			InputSchema: schemaObject(portIDs(capability.Inputs)...), OutputSchema: schemaObject(portIDs(capability.Outputs)...),
			RequiredPermissions: append([]string{}, capability.Permissions...), Composite: capability.Composite,
		}
		for _, port := range capability.Inputs {
			record.InputPorts = append(record.InputPorts, workflowNodePortRecord{ID: port.ID, Label: customPortLabel(port.ID), Type: port.DataType, Required: port.Required})
		}
		for _, port := range capability.Outputs {
			record.OutputPorts = append(record.OutputPorts, workflowNodePortRecord{ID: port.ID, Label: customPortLabel(port.ID), Type: port.DataType, Required: port.Required})
		}
		result = append(result, record)
	}
	return result
}

func customWorkflowConfigSchema(capability customWorkflowCapability) string {
	property := func(title, propertyType string, extra map[string]any) map[string]any {
		result := map[string]any{"title": title, "type": propertyType}
		for key, value := range extra {
			result[key] = value
		}
		return result
	}
	integer := func(title string, defaultValue, maximum int64) map[string]any {
		return property(title, "integer", map[string]any{"default": defaultValue, "minimum": 1, "maximum": maximum})
	}
	sourceID := func() map[string]any {
		return property("Remote source", "integer", map[string]any{"minimum": 1, "maximum": math.MaxInt32})
	}
	properties := map[string]any{}
	switch capability.Type {
	case "workflow_input":
		properties["inputKey"] = property("Workflow input", "string", nil)
	case "input_text", "input_circle", "input_series", "input_voice":
		properties["inputKey"] = property("Workflow input", "string", nil)
		properties["value"] = property("Fixed value", "string", nil)
	case "input_work":
		properties["inputKey"] = property("Workflow input", "string", nil)
		properties["codes"] = property("Work codes", "array", map[string]any{"items": map[string]any{"type": "string"}})
	case "template_text":
		properties["template"] = property("Template", "string", map[string]any{"default": "{{.Value}}"})
	case "circle_catalog":
		properties["circleId"] = property("Circle ID", "string", nil)
		properties["mode"] = property("Catalog mode", "string", map[string]any{"default": "stored", "enum": []string{"stored", "incremental", "full"}})
		properties["maxWorks"] = integer("Maximum works", 100, 5000)
	case "series_catalog":
		properties["seriesId"] = property("Series ID", "string", nil)
		properties["circleExternalId"] = property("Circle ID", "string", nil)
		properties["maxWorks"] = integer("Maximum works", 100, 5000)
	case "voice_source_works":
		properties["voiceName"] = property("Voice name", "string", nil)
		properties["sourceId"] = sourceID()
		properties["pageSize"] = integer("Page size", 48, 100)
		properties["maxPages"] = integer("Maximum pages", 10, 100)
		properties["maxWorks"] = integer("Maximum works", 100, 2000)
	case "filter_works":
		properties["limit"] = integer("Maximum accepted works", 100, 5000)
		properties["codePrefix"] = property("Code prefix", "string", nil)
		properties["existing"] = property("Database state", "string", map[string]any{"default": "any", "enum": []string{"any", "known", "unknown"}})
	case "check_source_availability":
		properties["sourceId"] = sourceID()
	case "track_works":
		properties["sourceId"] = sourceID()
		properties["maxWorks"] = integer("Maximum works", 25, 500)
	case "fetch_works":
		properties["sourceId"] = sourceID()
		properties["excludeExtensions"] = property("Exclude extensions", "array", map[string]any{"default": []string{"wav"}, "items": map[string]any{"type": "string"}})
		properties["maxWorks"] = integer("Maximum works", 25, 100)
		properties["maxFiles"] = integer("Maximum files", 10000, 50000)
		properties["maxBytes"] = integer("Maximum bytes", 100*1024*1024*1024, 2*1024*1024*1024*1024)
		properties["allowUnknownSizes"] = property("Allow unknown sizes", "boolean", map[string]any{"default": false})
		properties["targetRoot"] = property("Existing target root", "string", nil)
	case "tag_works":
		properties["tagName"] = property("Tag name", "string", map[string]any{"maxLength": 40})
	}
	raw, err := json.Marshal(map[string]any{"type": "object", "properties": properties})
	if err != nil {
		return schemaObject(capability.ConfigKeys...)
	}
	return string(raw)
}

func customPortLabel(id string) string {
	label := strings.ReplaceAll(strings.TrimSpace(id), "_", " ")
	if label == "" {
		return "Value"
	}
	return strings.ToUpper(label[:1]) + label[1:]
}

func portIDs(ports []customWorkflowPort) []string {
	result := make([]string, 0, len(ports))
	for _, port := range ports {
		result = append(result, port.ID)
	}
	return result
}

func validateCustomWorkflowDefinition(raw string) (customWorkflowGraph, error) {
	var definition customWorkflowDefinition
	if err := json.Unmarshal([]byte(raw), &definition); err != nil {
		return customWorkflowGraph{}, fmt.Errorf("definition JSON is invalid")
	}
	if definition.SchemaVersion != customWorkflowSchemaVersion {
		return customWorkflowGraph{}, fmt.Errorf("custom workflow schemaVersion must be 2")
	}
	if len(definition.Nodes) == 0 || len(definition.Nodes) > 100 {
		return customWorkflowGraph{}, fmt.Errorf("custom workflow needs 1-100 nodes")
	}
	if len(definition.Edges) > 300 {
		return customWorkflowGraph{}, fmt.Errorf("custom workflow supports at most 300 edges")
	}
	definition.Command.Alias = strings.TrimPrefix(strings.TrimSpace(definition.Command.Alias), "/")
	if definition.Command.Enabled && !customWorkflowAliasPattern.MatchString(definition.Command.Alias) {
		return customWorkflowGraph{}, fmt.Errorf("command alias must be 2-32 letters, numbers, underscores, or hyphens")
	}

	inputsByKey := map[string]customWorkflowInput{}
	for index := range definition.Inputs {
		input := &definition.Inputs[index]
		input.Key = strings.TrimSpace(input.Key)
		input.Label = strings.TrimSpace(input.Label)
		input.Type = strings.ToLower(strings.TrimSpace(input.Type))
		if !customWorkflowInputKeyPattern.MatchString(input.Key) {
			return customWorkflowGraph{}, fmt.Errorf("invalid workflow input key: %s", input.Key)
		}
		if _, exists := inputsByKey[input.Key]; exists {
			return customWorkflowGraph{}, fmt.Errorf("workflow input key must be unique: %s", input.Key)
		}
		if customInputDataType(input.Type) == "" {
			return customWorkflowGraph{}, fmt.Errorf("unsupported workflow input type: %s", input.Type)
		}
		if input.DefaultValue != nil {
			normalizedDefault, err := normalizeCustomWorkflowInputValue(input.Type, input.DefaultValue)
			if err != nil {
				return customWorkflowGraph{}, fmt.Errorf("invalid default value for workflow input %s: %w", input.Key, err)
			}
			input.DefaultValue = normalizedDefault
		}
		inputsByKey[input.Key] = *input
	}

	nodesByID := make(map[string]customWorkflowNode, len(definition.Nodes))
	nodeOrder := make(map[string]int, len(definition.Nodes))
	for index := range definition.Nodes {
		node := &definition.Nodes[index]
		node.ID = strings.TrimSpace(node.ID)
		node.Type = strings.TrimSpace(node.Type)
		node.DisplayName = strings.TrimSpace(node.DisplayName)
		if !customWorkflowIDPattern.MatchString(node.ID) {
			return customWorkflowGraph{}, fmt.Errorf("invalid node id: %s", node.ID)
		}
		if _, exists := nodesByID[node.ID]; exists {
			return customWorkflowGraph{}, fmt.Errorf("node id must be unique: %s", node.ID)
		}
		capability, exists := customWorkflowCapabilities[node.Type]
		if !exists {
			return customWorkflowGraph{}, fmt.Errorf("unsupported executable node type: %s", node.Type)
		}
		if node.DisplayName == "" {
			node.DisplayName = capability.DisplayName
		}
		if node.Config == nil {
			node.Config = map[string]any{}
		}
		if math.IsNaN(node.Position.X) || math.IsInf(node.Position.X, 0) || math.IsNaN(node.Position.Y) || math.IsInf(node.Position.Y, 0) {
			return customWorkflowGraph{}, fmt.Errorf("node position must be finite: %s", node.ID)
		}
		if err := validateCustomInputNode(*node, inputsByKey); err != nil {
			return customWorkflowGraph{}, err
		}
		if err := validateCustomWorkflowNodeConfig(*node, customWorkflowRequiresPreview(definition)); err != nil {
			return customWorkflowGraph{}, err
		}
		nodesByID[node.ID] = *node
		nodeOrder[node.ID] = index
	}

	edgeIDs := map[string]bool{}
	targetPorts := map[string]bool{}
	incoming := map[string][]customWorkflowEdge{}
	adjacency := map[string][]string{}
	indegree := map[string]int{}
	for nodeID := range nodesByID {
		indegree[nodeID] = 0
	}
	for index := range definition.Edges {
		edge := &definition.Edges[index]
		edge.Source = strings.TrimSpace(edge.Source)
		edge.Target = strings.TrimSpace(edge.Target)
		edge.SourceHandle = strings.TrimSpace(edge.SourceHandle)
		edge.TargetHandle = strings.TrimSpace(edge.TargetHandle)
		source, sourceExists := nodesByID[edge.Source]
		target, targetExists := nodesByID[edge.Target]
		if !sourceExists || !targetExists {
			return customWorkflowGraph{}, fmt.Errorf("edge references an unknown node")
		}
		if edge.Source == edge.Target {
			return customWorkflowGraph{}, fmt.Errorf("node cannot connect to itself: %s", edge.Source)
		}
		sourcePorts := customNodeOutputPorts(source, inputsByKey)
		targetPortsForNode := customNodeInputPorts(target)
		if edge.SourceHandle == "" && len(sourcePorts) == 1 {
			edge.SourceHandle = sourcePorts[0].ID
		}
		if edge.TargetHandle == "" && len(targetPortsForNode) == 1 {
			edge.TargetHandle = targetPortsForNode[0].ID
		}
		sourcePort, ok := findCustomPort(sourcePorts, edge.SourceHandle)
		if !ok {
			return customWorkflowGraph{}, fmt.Errorf("unknown output port %s.%s", edge.Source, edge.SourceHandle)
		}
		targetPort, ok := findCustomPort(targetPortsForNode, edge.TargetHandle)
		if !ok {
			return customWorkflowGraph{}, fmt.Errorf("unknown input port %s.%s", edge.Target, edge.TargetHandle)
		}
		if sourcePort.DataType != targetPort.DataType {
			return customWorkflowGraph{}, fmt.Errorf("incompatible edge %s.%s (%s) -> %s.%s (%s)", edge.Source, edge.SourceHandle, sourcePort.DataType, edge.Target, edge.TargetHandle, targetPort.DataType)
		}
		portKey := edge.Target + ":" + edge.TargetHandle
		if targetPorts[portKey] {
			return customWorkflowGraph{}, fmt.Errorf("input port has more than one edge: %s.%s", edge.Target, edge.TargetHandle)
		}
		targetPorts[portKey] = true
		if strings.TrimSpace(edge.ID) == "" {
			edge.ID = fmt.Sprintf("%s_%s_%s_%s", edge.Source, edge.SourceHandle, edge.Target, edge.TargetHandle)
		}
		if edgeIDs[edge.ID] {
			return customWorkflowGraph{}, fmt.Errorf("edge id must be unique: %s", edge.ID)
		}
		edgeIDs[edge.ID] = true
		incoming[edge.Target] = append(incoming[edge.Target], *edge)
		adjacency[edge.Source] = append(adjacency[edge.Source], edge.Target)
		indegree[edge.Target]++
	}

	for _, node := range definition.Nodes {
		for _, port := range customNodeInputPorts(node) {
			if port.Required && !targetPorts[node.ID+":"+port.ID] && !customNodeConfigSuppliesPort(node, port.ID) {
				return customWorkflowGraph{}, fmt.Errorf("required input is not connected: %s.%s", node.ID, port.ID)
			}
		}
	}

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
		return customWorkflowGraph{}, fmt.Errorf("workflow graph must be acyclic")
	}
	return customWorkflowGraph{Definition: definition, NodesByID: nodesByID, IncomingByNode: incoming, TopologicalOrder: topological}, nil
}

func customWorkflowRequiresPreview(definition customWorkflowDefinition) bool {
	return definition.Policy.RequirePreview == nil || *definition.Policy.RequirePreview
}

func validateCustomWorkflowNodeConfig(node customWorkflowNode, requiresPreview bool) error {
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
	if err := validateCustomWorkflowConfigTypes(node); err != nil {
		return err
	}
	requireBound := !requiresPreview
	bound := func(key string, fallback int64, maximum int64, required bool) error {
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
	switch node.Type {
	case "circle_catalog":
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
		return bound("maxWorks", 100, 5000, requireBound)
	case "series_catalog":
		return bound("maxWorks", 100, 5000, requireBound)
	case "voice_source_works":
		if sourceID, ok := customConfigInteger(node.Config["sourceId"]); !ok || sourceID <= 0 || sourceID > math.MaxInt32 {
			return fmt.Errorf("node %s requires a sourceId", node.ID)
		}
		if err := bound("maxWorks", 100, 2000, requireBound); err != nil {
			return err
		}
		if err := bound("maxPages", 10, 100, requireBound); err != nil {
			return err
		}
		return bound("pageSize", 48, 100, false)
	case "filter_works":
		existing := strings.ToLower(configString(node.Config, "existing"))
		if existing != "" && existing != "any" && existing != "known" && existing != "unknown" {
			return fmt.Errorf("node %s has invalid existing filter", node.ID)
		}
		if _, ok := node.Config["limit"]; ok {
			return bound("limit", 100, 5000, false)
		}
	case "check_source_availability":
		if sourceID, ok := customConfigInteger(node.Config["sourceId"]); !ok || sourceID <= 0 || sourceID > math.MaxInt32 {
			return fmt.Errorf("node %s requires a sourceId", node.ID)
		}
	case "track_works":
		return bound("maxWorks", 25, 500, requireBound)
	case "fetch_works":
		if err := bound("maxWorks", 25, 100, requireBound); err != nil {
			return err
		}
		if err := bound("maxFiles", 10000, 50000, requireBound); err != nil {
			return err
		}
		if err := bound("maxBytes", 100*1024*1024*1024, 2*1024*1024*1024*1024, requireBound); err != nil {
			return err
		}
		_, unknownSizePolicySet := node.Config["allowUnknownSizes"]
		if !requiresPreview && (!unknownSizePolicySet || configBool(node.Config, "allowUnknownSizes", false)) {
			return fmt.Errorf("node %s requires allowUnknownSizes=false when preview is disabled", node.ID)
		}
	case "tag_works":
		if tagName := configString(node.Config, "tagName"); len([]rune(tagName)) > 40 {
			return fmt.Errorf("node %s tagName is too long", node.ID)
		}
	}
	return nil
}

func validateCustomWorkflowConfigTypes(node customWorkflowNode) error {
	integerKeys := map[string]bool{"sourceId": true, "pageSize": true, "maxPages": true, "maxWorks": true, "limit": true, "maxFiles": true, "maxBytes": true}
	arrayKeys := map[string]bool{"codes": true, "excludeExtensions": true}
	booleanKeys := map[string]bool{"allowUnknownSizes": true}
	for key, value := range node.Config {
		switch {
		case integerKeys[key]:
			if _, ok := customConfigInteger(value); !ok {
				return fmt.Errorf("node %s config %s must be an integer", node.ID, key)
			}
		case arrayKeys[key]:
			items, ok := value.([]any)
			if !ok {
				if stringsValue, stringsOK := value.([]string); stringsOK {
					items = make([]any, len(stringsValue))
					for index := range stringsValue {
						items[index] = stringsValue[index]
					}
				} else {
					return fmt.Errorf("node %s config %s must be an array of strings", node.ID, key)
				}
			}
			for _, item := range items {
				if _, ok := item.(string); !ok {
					return fmt.Errorf("node %s config %s must be an array of strings", node.ID, key)
				}
			}
		case booleanKeys[key]:
			if _, ok := value.(bool); !ok {
				return fmt.Errorf("node %s config %s must be a boolean", node.ID, key)
			}
		default:
			if _, ok := value.(string); !ok {
				return fmt.Errorf("node %s config %s must be a string", node.ID, key)
			}
		}
	}
	if templateText := configString(node.Config, "template"); templateText != "" {
		if _, err := texttemplate.New("workflow-text-validation").Option("missingkey=error").Parse(templateText); err != nil {
			return fmt.Errorf("node %s has invalid text template", node.ID)
		}
	}
	for _, extension := range configStringSlice(node.Config, "excludeExtensions") {
		extension = strings.TrimPrefix(strings.TrimSpace(extension), ".")
		if extension == "" || len(extension) > 16 || strings.ContainsAny(extension, `/\\`) {
			return fmt.Errorf("node %s has invalid excluded extension", node.ID)
		}
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

func validateCustomInputNode(node customWorkflowNode, inputs map[string]customWorkflowInput) error {
	if node.Type != "workflow_input" && !strings.HasPrefix(node.Type, "input_") {
		return nil
	}
	inputKey := configString(node.Config, "inputKey")
	if node.Type == "workflow_input" {
		if inputKey == "" {
			return fmt.Errorf("workflow_input requires config.inputKey: %s", node.ID)
		}
		if _, ok := inputs[inputKey]; !ok {
			return fmt.Errorf("workflow_input references an unknown input: %s", inputKey)
		}
		return nil
	}
	if inputKey == "" {
		if node.Type == "input_work" {
			if len(configStringSlice(node.Config, "codes")) == 0 {
				return fmt.Errorf("%s requires config.inputKey or config.codes", node.ID)
			}
		} else if configString(node.Config, "value") == "" {
			return fmt.Errorf("%s requires config.inputKey or config.value", node.ID)
		}
		return nil
	}
	input, ok := inputs[inputKey]
	if !ok {
		return fmt.Errorf("node %s references an unknown input: %s", node.ID, inputKey)
	}
	want := map[string]string{
		"input_text": "text", "input_circle": "circle_id", "input_series": "series_id",
		"input_voice": "voice_name", "input_work": "work_candidates",
	}[node.Type]
	if customInputDataType(input.Type) != want {
		return fmt.Errorf("node %s input type is incompatible with %s", node.ID, inputKey)
	}
	return nil
}

func customNodeInputPorts(node customWorkflowNode) []customWorkflowPort {
	return append([]customWorkflowPort{}, customWorkflowCapabilities[node.Type].Inputs...)
}

func customNodeOutputPorts(node customWorkflowNode, inputs map[string]customWorkflowInput) []customWorkflowPort {
	ports := append([]customWorkflowPort{}, customWorkflowCapabilities[node.Type].Outputs...)
	if node.Type == "workflow_input" && len(ports) == 1 {
		ports[0].DataType = customInputDataType(inputs[configString(node.Config, "inputKey")].Type)
	}
	return ports
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

func customInputDataType(inputType string) string {
	switch strings.ToLower(strings.TrimSpace(inputType)) {
	case "text":
		return "text"
	case "circle_id":
		return "circle_id"
	case "series_id":
		return "series_id"
	case "voice_name":
		return "voice_name"
	case "work_code", "work_codes":
		return "work_candidates"
	default:
		return ""
	}
}

type customWorkflowRunRequest struct {
	Mode         string         `json:"mode"`
	Inputs       map[string]any `json:"inputs"`
	PreviewToken string         `json:"previewToken"`
}

type customWorkflowRunResponse struct {
	Mode                string                     `json:"mode"`
	DefinitionID        int64                      `json:"definitionId,omitempty"`
	WorkflowCode        string                     `json:"workflowCode,omitempty"`
	Status              string                     `json:"status"`
	PreviewToken        string                     `json:"previewToken,omitempty"`
	RequiredPermissions []string                   `json:"requiredPermissions,omitempty"`
	NormalizedInputs    map[string]any             `json:"normalizedInputs,omitempty"`
	Plan                *customWorkflowPreviewPlan `json:"plan,omitempty"`
	Warnings            []string                   `json:"warnings,omitempty"`
	RunID               int64                      `json:"runId,omitempty"`
}

type customWorkflowPreviewPlan struct {
	NodeCount        int                           `json:"nodeCount"`
	EdgeCount        int                           `json:"edgeCount"`
	TopologicalOrder []string                      `json:"topologicalOrder"`
	Actions          []customWorkflowPreviewAction `json:"actions"`
	Estimates        *customWorkflowEstimates      `json:"estimates"`
	Limits           []customWorkflowPreviewLimit  `json:"limits"`
}

type customWorkflowPreviewAction struct {
	NodeID               string `json:"nodeId"`
	NodeType             string `json:"nodeType"`
	DisplayName          string `json:"displayName"`
	Phase                string `json:"phase"`
	RequiresConfirmation bool   `json:"requiresConfirmation"`
}

type customWorkflowEstimates struct {
	CandidateCount int    `json:"candidateCount,omitempty"`
	FileCount      int    `json:"fileCount,omitempty"`
	TotalBytes     *int64 `json:"totalBytes,omitempty"`
}

type customWorkflowPreviewLimit struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	Value     any    `json:"value"`
	Unit      string `json:"unit,omitempty"`
	Satisfied *bool  `json:"satisfied,omitempty"`
	Message   string `json:"message,omitempty"`
}

func (s *Server) runCustomWorkflowDefinition(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	definitionID, err := parseInt64PathValue(r, "id")
	if err != nil || definitionID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow definition id"})
		return
	}
	definition, err := s.loadWorkflowDefinition(r.Context(), definitionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow definition not found"})
			return
		}
		writeError(w, err)
		return
	}
	if definition.Scope != "user" || !definition.Editable {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "only custom workflow definitions use the DAG runner"})
		return
	}
	if !canManageWorkflowDefinition(actor, definition) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	graph, err := validateCustomWorkflowDefinition(definition.DefinitionJSON)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var request customWorkflowRunRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	request.Mode = strings.ToLower(strings.TrimSpace(request.Mode))
	if request.Mode != "preview" && request.Mode != "confirm" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "mode must be preview or confirm"})
		return
	}
	normalizedInputs, err := normalizeCustomWorkflowInputs(graph.Definition.Inputs, request.Inputs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	requiredPermissions := customWorkflowRequiredPermissions(graph)
	if missing := missingCustomWorkflowPermission(actor.Permissions, requiredPermissions); missing != "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied", "permission": missing})
		return
	}
	previewToken := customWorkflowPreviewToken(definition.ID, actor.ID, definition.DefinitionJSON, normalizedInputs)
	preview := buildCustomWorkflowPreview(graph, normalizedInputs)
	if request.Mode == "preview" {
		writeJSON(w, http.StatusOK, customWorkflowRunResponse{
			Mode: "preview", DefinitionID: definition.ID, WorkflowCode: definition.Code, Status: "preview",
			PreviewToken: previewToken, RequiredPermissions: requiredPermissions, NormalizedInputs: normalizedInputs,
			Plan: &preview, Warnings: customWorkflowPreviewWarnings(graph),
		})
		return
	}
	requiresPreview := customWorkflowRequiresPreview(graph.Definition)
	if (requiresPreview && strings.TrimSpace(request.PreviewToken) == "") || (strings.TrimSpace(request.PreviewToken) != "" && request.PreviewToken != previewToken) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "workflow preview is required or no longer matches the definition and inputs"})
		return
	}
	runID, err := s.enqueueCustomWorkflow(r.Context(), definition, graph, actor.ID, actor.Permissions, normalizedInputs, previewToken)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, customWorkflowRunResponse{Mode: "confirm", DefinitionID: definition.ID, WorkflowCode: definition.Code, Status: "queued", RunID: runID})
}

func normalizeCustomWorkflowInputs(specs []customWorkflowInput, supplied map[string]any) (map[string]any, error) {
	if supplied == nil {
		supplied = map[string]any{}
	}
	known := map[string]bool{}
	result := map[string]any{}
	for _, spec := range specs {
		known[spec.Key] = true
		value, exists := supplied[spec.Key]
		if !exists {
			value = spec.DefaultValue
		}
		if value == nil {
			if spec.Required {
				return nil, fmt.Errorf("workflow input is required: %s", spec.Key)
			}
			continue
		}
		normalized, err := normalizeCustomWorkflowInputValue(spec.Type, value)
		if err != nil {
			return nil, fmt.Errorf("invalid workflow input %s: %w", spec.Key, err)
		}
		result[spec.Key] = normalized
	}
	for key := range supplied {
		if !known[key] {
			return nil, fmt.Errorf("unknown workflow input: %s", key)
		}
	}
	return result, nil
}

func normalizeCustomWorkflowInputValue(inputType string, value any) (any, error) {
	switch strings.ToLower(strings.TrimSpace(inputType)) {
	case "text":
		text, ok := value.(string)
		if !ok || len([]rune(strings.TrimSpace(text))) > 4096 {
			return nil, fmt.Errorf("text must be a string of at most 4096 characters")
		}
		return strings.TrimSpace(text), nil
	case "circle_id":
		text, ok := value.(string)
		text = normalizeMakerID(text)
		if !ok || !dlsiteMakerIDPattern.MatchString(text) || isTranslationUmbrellaCircle(text) {
			return nil, fmt.Errorf("invalid circle id")
		}
		return text, nil
	case "series_id":
		text, ok := value.(string)
		text = strings.ToUpper(strings.TrimSpace(text))
		if !ok || text == "" || len(text) > 128 {
			return nil, fmt.Errorf("invalid series id")
		}
		return text, nil
	case "voice_name":
		text, ok := value.(string)
		text = strings.TrimSpace(text)
		if !ok || text == "" || len([]rune(text)) > 200 || isUnknownVoiceActorName(text) {
			return nil, fmt.Errorf("invalid voice name")
		}
		return text, nil
	case "work_code":
		text, ok := value.(string)
		text = strings.ToUpper(strings.TrimSpace(text))
		if !ok || !customWorkflowWorkCodePattern.MatchString(text) {
			return nil, fmt.Errorf("invalid work code")
		}
		return text, nil
	case "work_codes":
		codes, err := customStringValues(value)
		if err != nil {
			return nil, err
		}
		return normalizeCustomWorkCodes(codes, 1000)
	default:
		return nil, fmt.Errorf("unsupported input type")
	}
}

func customStringValues(value any) ([]string, error) {
	switch typed := value.(type) {
	case string:
		return strings.FieldsFunc(typed, func(r rune) bool { return r == ',' || r == '\n' || r == '\r' || r == ' ' || r == '\t' }), nil
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

func canManageWorkflowDefinition(actor currentUser, definition workflowDefinitionRecord) bool {
	if missingCustomWorkflowPermission(actor.Permissions, []string{"system:admin"}) == "" {
		return true
	}
	return definition.OwnerUserID != nil && *definition.OwnerUserID == actor.ID
}

func canUseWorkflowDefinition(actor currentUser, definition workflowDefinitionRecord) bool {
	return definition.Scope == "system" || canManageWorkflowDefinition(actor, definition)
}

func workflowDefinitionSupportsScheduledTriggers(definition workflowDefinitionRecord) bool {
	if definition.Scope != "user" {
		return true
	}
	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	return json.Unmarshal([]byte(definition.DefinitionJSON), &probe) != nil || probe.SchemaVersion != customWorkflowSchemaVersion
}

func (s *Server) ensureWorkflowCommandAliasAvailable(ctx context.Context, ownerID int64, excludeDefinitionID int64, rawDefinition string) error {
	return ensureWorkflowCommandAliasAvailableFrom(ctx, s.db, ownerID, excludeDefinitionID, rawDefinition)
}

type workflowAliasQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func ensureWorkflowCommandAliasAvailableFrom(ctx context.Context, db workflowAliasQuerier, ownerID int64, excludeDefinitionID int64, rawDefinition string) error {
	var definition customWorkflowDefinition
	if json.Unmarshal([]byte(rawDefinition), &definition) != nil || definition.SchemaVersion != customWorkflowSchemaVersion || !definition.Command.Enabled {
		return nil
	}
	alias := strings.TrimPrefix(strings.TrimSpace(definition.Command.Alias), "/")
	if alias == "" {
		return nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT id, definition_json
		FROM workflow_definition
		WHERE scope = 'user' AND owner_user_id = ? AND id <> ?
	`, ownerID, excludeDefinitionID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var raw string
		if err := rows.Scan(&id, &raw); err != nil {
			return err
		}
		var existing customWorkflowDefinition
		if json.Unmarshal([]byte(raw), &existing) != nil {
			continue
		}
		existingAlias := strings.TrimPrefix(strings.TrimSpace(existing.Command.Alias), "/")
		if existing.SchemaVersion == customWorkflowSchemaVersion && existing.Command.Enabled && strings.EqualFold(existingAlias, alias) {
			return fmt.Errorf("quick action alias /%s is already in use", alias)
		}
	}
	return rows.Err()
}

func customWorkflowPreviewToken(definitionID int64, userID int64, definitionJSON string, inputs map[string]any) string {
	inputJSON, _ := json.Marshal(inputs)
	hash := sha256.Sum256([]byte(fmt.Sprintf("custom-workflow-preview-v1\n%d\n%d\n%s\n%s", definitionID, userID, definitionJSON, inputJSON)))
	return "cwp_" + hex.EncodeToString(hash[:])
}

func buildCustomWorkflowPreview(graph customWorkflowGraph, inputs map[string]any) customWorkflowPreviewPlan {
	plan := customWorkflowPreviewPlan{
		NodeCount: len(graph.Definition.Nodes), EdgeCount: len(graph.Definition.Edges),
		TopologicalOrder: append([]string{}, graph.TopologicalOrder...), Actions: []customWorkflowPreviewAction{}, Limits: []customWorkflowPreviewLimit{},
	}
	inputTypes := map[string]string{}
	for _, input := range graph.Definition.Inputs {
		inputTypes[input.Key] = input.Type
		if customInputDataType(input.Type) == "work_candidates" {
			switch value := inputs[input.Key].(type) {
			case string:
				plan.Estimates = &customWorkflowEstimates{CandidateCount: 1}
			case []string:
				plan.Estimates = &customWorkflowEstimates{CandidateCount: len(value)}
			case []any:
				plan.Estimates = &customWorkflowEstimates{CandidateCount: len(value)}
			}
		}
	}
	for _, nodeID := range graph.TopologicalOrder {
		node := graph.NodesByID[nodeID]
		capability := customWorkflowCapabilities[node.Type]
		confirm := capability.Phase == "execute" || capability.Phase == "commit" || (node.Type == "circle_catalog" && !strings.EqualFold(configString(node.Config, "mode"), "stored"))
		plan.Actions = append(plan.Actions, customWorkflowPreviewAction{NodeID: node.ID, NodeType: node.Type, DisplayName: node.DisplayName, Phase: capability.Phase, RequiresConfirmation: confirm})
		if node.Type == "fetch_works" {
			appendLimit := func(key, label string, value int64, unit string) {
				if value > 0 {
					plan.Limits = append(plan.Limits, customWorkflowPreviewLimit{Key: key, Label: label, Value: value, Unit: unit})
				}
			}
			appendLimit("maxWorks", "Maximum works", int64(configInt(node.Config, "maxWorks", 25)), "works")
			appendLimit("maxFiles", "Maximum files", int64(configInt(node.Config, "maxFiles", 10000)), "files")
			appendLimit("maxBytes", "Maximum bytes", configInt64(node.Config, "maxBytes", 100*1024*1024*1024), "bytes")
		}
	}
	_ = inputTypes
	return plan
}

func customWorkflowPreviewWarnings(graph customWorkflowGraph) []string {
	warnings := []string{}
	for _, node := range graph.Definition.Nodes {
		switch node.Type {
		case "track_works":
			warnings = append(warnings, "Track creates unified works only for accepted remote candidates and records tracked source presence.")
		case "fetch_works":
			warnings = append(warnings, "Fetch queues separate recoverable child runs; publication remains under the existing staging and verification boundary.")
		case "circle_catalog":
			warnings = append(warnings, "Circle catalog discovery stores catalog candidates and does not materialize every discovered code as a work.")
		}
	}
	return warnings
}

type customWorkflowJobPayload struct {
	DefinitionJSON string         `json:"definitionJson"`
	Inputs         map[string]any `json:"inputs"`
	UserID         int64          `json:"userId"`
	Permissions    []string       `json:"permissions"`
	PreviewToken   string         `json:"previewToken"`
	StartedAt      string         `json:"startedAt"`
}

type customWorkflowCheckpoint struct {
	CompletedNodeIDs []string                              `json:"completedNodeIds"`
	Outputs          map[string]map[string]customPortValue `json:"outputs"`
	ChildRunIDs      []int64                               `json:"childRunIds"`
	Partial          bool                                  `json:"partial"`
}

func (s *Server) enqueueCustomWorkflow(ctx context.Context, definition workflowDefinitionRecord, graph customWorkflowGraph, userID int64, permissions []string, inputs map[string]any, previewToken string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	runInput := map[string]any{"inputs": inputs, "definition_schema_version": customWorkflowSchemaVersion, "requested_by_user_id": userID}
	runID, err := workflow.InsertRun(ctx, tx, definition.ID, definition.Code, definition.DisplayName, "queued", "manual", "custom_definition", runInput, map[string]any{"nodes": len(graph.TopologicalOrder)})
	if err != nil {
		return 0, err
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
	payload := customWorkflowJobPayload{DefinitionJSON: definition.DefinitionJSON, Inputs: inputs, UserID: userID, Permissions: append([]string{}, permissions...), PreviewToken: previewToken, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	checkpoint := customWorkflowCheckpoint{CompletedNodeIDs: []string{}, Outputs: map[string]map[string]customPortValue{}, ChildRunIDs: []int64{}}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: firstNodeRunID, WorkerType: "custom_workflow", Status: "queued", Payload: payload,
		Checkpoint: checkpoint, Recoverable: true, MaxRetries: 3, ProgressTotal: len(graph.TopologicalOrder),
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return runID, nil
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
	Code     string `json:"code"`
	SourceID int64  `json:"sourceId,omitempty"`
	Title    string `json:"title,omitempty"`
	Reason   string `json:"reason,omitempty"`
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
}

func (s *Server) executeCustomWorkflowJob(ctx context.Context, job workflowJobRecord) error {
	var payload customWorkflowJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow payload is invalid")
		return err
	}
	graph, err := validateCustomWorkflowDefinition(payload.DefinitionJSON)
	if err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow snapshot is invalid")
		return err
	}
	if missing := missingCustomWorkflowPermission(payload.Permissions, customWorkflowRequiredPermissions(graph)); missing != "" {
		err := fmt.Errorf("permission snapshot is missing %s", missing)
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow permission snapshot is invalid")
		return err
	}
	checkpoint := customWorkflowCheckpoint{Outputs: map[string]map[string]customPortValue{}, CompletedNodeIDs: []string{}, ChildRunIDs: []int64{}}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow checkpoint is invalid")
		return err
	}
	if checkpoint.Outputs == nil {
		checkpoint.Outputs = map[string]map[string]customPortValue{}
	}
	completed := map[string]bool{}
	for _, nodeID := range checkpoint.CompletedNodeIDs {
		completed[nodeID] = true
	}
	nodeRunIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failCustomWorkflowJob(ctx, job, 0, "custom workflow node runs are unavailable")
		return err
	}
	for index, nodeID := range graph.TopologicalOrder {
		if completed[nodeID] {
			continue
		}
		if err := s.ensureWorkflowRunActive(ctx, job.RunID); err != nil {
			return err
		}
		node := graph.NodesByID[nodeID]
		inputs, err := customRuntimeNodeInputs(graph, node, checkpoint.Outputs)
		if err != nil {
			_ = s.failCustomWorkflowJob(ctx, job, nodeRunIDs[nodeID], "custom workflow input resolution failed")
			return err
		}
		nodeRunID := nodeRunIDs[nodeID]
		if _, err := s.db.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = 'running', input_json = ?, error_message = '', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = NULL
			WHERE id = ?
		`, mustJSON(customPortValuesSummary(inputs)), nodeRunID); err != nil {
			return err
		}
		execution, runErr := s.executeCustomWorkflowNode(ctx, job.RunID, payload, graph, node, inputs)
		if runErr != nil {
			slog.Error("custom workflow node failed", "run_id", job.RunID, "node_id", node.ID, "node_type", node.Type, "error", runErr)
			_ = s.failCustomWorkflowJob(ctx, job, nodeRunID, publicCustomWorkflowError(node.Type))
			return runErr
		}
		status := "succeeded"
		if execution.Partial {
			status = "partial"
			checkpoint.Partial = true
		}
		if execution.Outputs == nil {
			execution.Outputs = map[string]customPortValue{}
		}
		if _, err := s.db.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = ?, output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, status, mustJSON(customPortValuesSummary(execution.Outputs)), nodeRunID); err != nil {
			return err
		}
		checkpoint.Outputs[nodeID] = execution.Outputs
		checkpoint.CompletedNodeIDs = append(checkpoint.CompletedNodeIDs, nodeID)
		checkpoint.ChildRunIDs = append(checkpoint.ChildRunIDs, execution.ChildRunIDs...)
		completed[nodeID] = true
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, nodeID, checkpoint, index+1, len(graph.TopologicalOrder)); err != nil {
			return err
		}
	}
	return s.finishCustomWorkflowJob(ctx, job, checkpoint, len(graph.TopologicalOrder))
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

func (s *Server) executeCustomWorkflowNode(ctx context.Context, runID int64, payload customWorkflowJobPayload, graph customWorkflowGraph, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	switch node.Type {
	case "workflow_input", "input_text", "input_circle", "input_series", "input_voice", "input_work":
		return executeCustomInputNode(payload, graph, node)
	case "template_text":
		return executeCustomTemplateNode(payload, node, inputs)
	case "circle_catalog":
		return s.executeCustomCircleCatalog(ctx, node, inputs)
	case "series_catalog":
		return s.executeCustomSeriesCatalog(ctx, node, inputs)
	case "voice_source_works":
		return s.executeCustomVoiceSourceWorks(ctx, runID, node, inputs)
	case "filter_works":
		return s.executeCustomFilterWorks(ctx, node, inputs)
	case "check_source_availability":
		return s.executeCustomSourceAvailability(ctx, runID, node, inputs)
	case "track_works":
		return s.executeCustomTrackWorks(ctx, runID, node, inputs)
	case "fetch_works":
		return s.executeCustomFetchWorks(ctx, runID, node, inputs)
	case "tag_works":
		return s.executeCustomTagWorks(ctx, payload.UserID, node, inputs)
	default:
		return customNodeExecution{}, fmt.Errorf("unsupported custom workflow node: %s", node.Type)
	}
}

func executeCustomInputNode(payload customWorkflowJobPayload, graph customWorkflowGraph, node customWorkflowNode) (customNodeExecution, error) {
	inputKey := configString(node.Config, "inputKey")
	value, hasValue := payload.Inputs[inputKey]
	if inputKey == "" {
		hasValue = true
		if node.Type == "input_work" {
			value = configStringSlice(node.Config, "codes")
		} else {
			value = configString(node.Config, "value")
		}
	}
	dataType := ""
	outputHandle := "value"
	inputRequired := true
	if node.Type == "workflow_input" {
		for _, input := range graph.Definition.Inputs {
			if input.Key == inputKey {
				dataType = customInputDataType(input.Type)
				inputRequired = input.Required
				break
			}
		}
	} else {
		dataType = customWorkflowCapabilities[node.Type].Outputs[0].DataType
		if inputKey != "" {
			for _, input := range graph.Definition.Inputs {
				if input.Key == inputKey {
					inputRequired = input.Required
					break
				}
			}
		}
	}
	if node.Type == "input_work" {
		outputHandle = "works"
	}
	if !hasValue {
		if inputRequired {
			return customNodeExecution{}, fmt.Errorf("workflow input is missing: %s", inputKey)
		}
		return customNodeExecution{Outputs: map[string]customPortValue{outputHandle: {Type: dataType}}}, nil
	}
	if node.Type == "input_work" || dataType == "work_candidates" {
		values, err := customStringValues(value)
		if err != nil {
			if text, ok := value.(string); ok {
				values = []string{text}
			} else {
				return customNodeExecution{}, err
			}
		}
		codes, err := normalizeCustomWorkCodes(values, 1000)
		if err != nil {
			return customNodeExecution{}, err
		}
		return customNodeExecution{Outputs: map[string]customPortValue{outputHandle: {Type: "work_candidates", Candidates: customCandidatesForCodes(codes, 0)}}}, nil
	}
	text, ok := value.(string)
	if !ok {
		return customNodeExecution{}, fmt.Errorf("input value must be text")
	}
	return customNodeExecution{Outputs: map[string]customPortValue{outputHandle: {Type: dataType, Text: strings.TrimSpace(text)}}}, nil
}

func executeCustomTemplateNode(payload customWorkflowJobPayload, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	templateText := configString(node.Config, "template")
	if templateText == "" {
		templateText = "{{.Value}}"
	}
	tmpl, err := texttemplate.New("workflow-text").Option("missingkey=error").Parse(templateText)
	if err != nil {
		return customNodeExecution{}, fmt.Errorf("invalid text template: %w", err)
	}
	startedAt, err := time.Parse(time.RFC3339Nano, payload.StartedAt)
	if err != nil {
		startedAt = time.Now().UTC()
	}
	data := struct {
		Inputs    map[string]any
		Value     string
		StartedAt string
		Date      string
	}{Inputs: payload.Inputs, Value: inputs["value"].Text, StartedAt: startedAt.Format(time.RFC3339), Date: startedAt.Format("2006-01-02")}
	var rendered strings.Builder
	if err := tmpl.Execute(&rendered, data); err != nil {
		return customNodeExecution{}, fmt.Errorf("render text template: %w", err)
	}
	text := strings.TrimSpace(rendered.String())
	if len([]rune(text)) > 4096 {
		return customNodeExecution{}, fmt.Errorf("rendered text exceeds 4096 characters")
	}
	return customNodeExecution{Outputs: map[string]customPortValue{"text": {Type: "text", Text: text}}}, nil
}

func (s *Server) executeCustomCircleCatalog(ctx context.Context, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	circleID := normalizeMakerID(firstNonEmpty(inputs["circle"].Text, configString(node.Config, "circleId")))
	if !dlsiteMakerIDPattern.MatchString(circleID) || isTranslationUmbrellaCircle(circleID) {
		return customNodeExecution{}, fmt.Errorf("invalid circle id")
	}
	partyID, err := s.ensurePlaceholderCircle(ctx, circleID)
	if err != nil {
		return customNodeExecution{}, err
	}
	mode := strings.ToLower(configString(node.Config, "mode"))
	if mode == "" {
		mode = "stored"
	}
	if mode != "stored" {
		if _, err := s.runCircleCatalogRefresh(ctx, partyID, circleID, mode, dlsite.NewClient(nil)); err != nil {
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
	voiceName := strings.TrimSpace(firstNonEmpty(inputs["voice"].Text, configString(node.Config, "voiceName")))
	if voiceName == "" || isUnknownVoiceActorName(voiceName) {
		return customNodeExecution{}, fmt.Errorf("voice name is required")
	}
	sourceID := configInt64(node.Config, "sourceId", 0)
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		return customNodeExecution{}, err
	}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) || strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return customNodeExecution{}, fmt.Errorf("source is not an enabled compatible remote source")
	}
	healthCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	err = checkRemoteSourceHealth(healthCtx, source)
	cancel()
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		return customNodeExecution{}, err
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	pageSize := configInt(node.Config, "pageSize", 48)
	maxPages := configInt(node.Config, "maxPages", 10)
	maxWorks := configInt(node.Config, "maxWorks", 100)
	keyword := "$va:" + voiceName + "$"
	client := kikoeruClientForSource(source)
	candidates := []customWorkCandidate{}
	seen := map[string]bool{}
	for pageNumber := 1; pageNumber <= maxPages && len(candidates) < maxWorks; pageNumber++ {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return customNodeExecution{}, err
		}
		if pageNumber > 1 {
			if err := s.waitRemoteDownloadDelay(ctx); err != nil {
				return customNodeExecution{}, err
			}
		}
		page, err := client.ListWorks(ctx, pageNumber, pageSize, keyword)
		if err != nil {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			return customNodeExecution{}, err
		}
		for _, remoteWork := range page.Works {
			code := normalizedRemoteWorkCode(remoteWork)
			if code == "" || seen[code] {
				continue
			}
			seen[code] = true
			candidates = append(candidates, customWorkCandidate{Code: code, SourceID: source.ID, Title: firstNonEmpty(remoteWork.Title, remoteWork.Name, code)})
			if len(candidates) >= maxWorks {
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
		if total > 0 && pageNumber*pageSize >= total {
			break
		}
		if total == 0 && len(page.Works) < pageSize {
			break
		}
	}
	return customNodeExecution{Outputs: map[string]customPortValue{"works": {Type: "work_candidates", Candidates: candidates}}}, nil
}

func (s *Server) executeCustomFilterWorks(ctx context.Context, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
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
		if keep && existing != "any" {
			ref, err := s.canonicalWorkForCode(ctx, candidate.Code)
			if err != nil {
				return customNodeExecution{}, err
			}
			keep = (existing == "known" && ref.Known) || (existing == "unknown" && !ref.Known)
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

func (s *Server) executeCustomSourceAvailability(ctx context.Context, runID int64, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	sourceID := configInt64(node.Config, "sourceId", 0)
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		return customNodeExecution{}, err
	}
	candidates := uniqueCustomCandidates(inputs["works"].Candidates)
	available := []customWorkCandidate{}
	missing := []customWorkCandidate{}
	failed := []customWorkCandidate{}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) || strings.TrimSpace(source.Endpoint.APIURL) == "" {
		for _, candidate := range candidates {
			candidate.SourceID = source.ID
			candidate.Reason = "source_unavailable"
			failed = append(failed, candidate)
		}
		return customNodeExecution{Partial: len(failed) > 0, Outputs: customAvailabilityOutputs(available, missing, failed)}, nil
	}
	healthCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	healthErr := checkRemoteSourceHealth(healthCtx, source)
	cancel()
	if healthErr != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		for _, candidate := range candidates {
			candidate.SourceID = source.ID
			candidate.Reason = "source_unavailable"
			failed = append(failed, candidate)
		}
		return customNodeExecution{Partial: len(failed) > 0, Outputs: customAvailabilityOutputs(available, missing, failed)}, nil
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	resultsByCode := map[string]sourceAvailabilitySummary{}
	for index, candidate := range candidates {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return customNodeExecution{}, err
		}
		if index > 0 {
			if err := s.waitRemoteDownloadDelay(ctx); err != nil {
				return customNodeExecution{}, err
			}
		}
		started := time.Now()
		remoteWork, checkErr := s.checkRemoteWorkAvailability(ctx, source, candidate.Code)
		summary := sourceAvailabilitySummary{SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName, ElapsedMS: time.Since(started).Milliseconds()}
		candidate.SourceID = source.ID
		if checkErr != nil {
			if isNotFoundLikeError(checkErr) {
				candidate.Reason = "not_found"
				missing = append(missing, candidate)
				summary.Status = "not_found"
			} else {
				candidate.Reason = "source_error"
				failed = append(failed, candidate)
				summary.Status = "error"
				summary.Error = "remote source request failed"
			}
			resultsByCode[candidate.Code] = summary
			continue
		}
		remoteCode := normalizedRemoteWorkCode(remoteWork)
		if remoteCode == "" {
			remoteCode = candidate.Code
		}
		candidate.Code = remoteCode
		candidate.Title = firstNonEmpty(remoteWork.Title, remoteWork.Name, candidate.Title, remoteCode)
		available = append(available, candidate)
		summary.Status = "available"
		summary.RemoteID = strconv.FormatInt(remoteWork.ID, 10)
		summary.PrimaryCode = remoteCode
		summary.Title = candidate.Title
		resultsByCode[candidate.Code] = summary
	}
	if len(resultsByCode) > 0 {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return customNodeExecution{}, err
		}
		defer tx.Rollback()
		for code, summary := range resultsByCode {
			if err := s.recordAvailabilityPresence(ctx, tx, code, []sourceAvailabilitySummary{summary}); err != nil {
				return customNodeExecution{}, err
			}
		}
		if err := tx.Commit(); err != nil {
			return customNodeExecution{}, err
		}
	}
	return customNodeExecution{Partial: len(failed) > 0, Outputs: customAvailabilityOutputs(available, missing, failed)}, nil
}

func customAvailabilityOutputs(available, missing, failed []customWorkCandidate) map[string]customPortValue {
	return map[string]customPortValue{
		"available": {Type: "work_candidates", Candidates: available},
		"missing":   {Type: "work_candidates", Candidates: missing},
		"error":     {Type: "work_candidates", Candidates: failed},
	}
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

func (s *Server) executeCustomFetchWorks(ctx context.Context, runID int64, node customWorkflowNode, inputs map[string]customPortValue) (customNodeExecution, error) {
	candidates := uniqueCustomCandidates(inputs["works"].Candidates)
	maxWorks := configInt(node.Config, "maxWorks", 25)
	maxFiles := configInt(node.Config, "maxFiles", 10000)
	maxBytes := configInt64(node.Config, "maxBytes", 100*1024*1024*1024)
	allowUnknown := configBool(node.Config, "allowUnknownSizes", false)
	if len(candidates) > maxWorks {
		return customNodeExecution{}, fmt.Errorf("fetch candidate count exceeds maxWorks")
	}
	excluded := customExtensionSet(configStringSlice(node.Config, "excludeExtensions"))
	prepared := []preparedCustomFetch{}
	failed := []customWorkCandidate{}
	completed := []customWorkRef{}
	childRunIDs := []int64{}
	totalFiles := 0
	totalBytes := int64(0)
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
		candidate.SourceID = sourceID
		requestID := customFetchRequestID(runID, node.ID, candidate.Code)
		if existing, found, err := s.remoteFetchRequestResult(ctx, requestID, sourceID, candidate.Code); err != nil {
			return customNodeExecution{}, err
		} else if found {
			usage, err := s.customFetchPersistedUsage(ctx, existing.RunID)
			if err != nil {
				return customNodeExecution{}, err
			}
			if usage.Unknown > 0 && !allowUnknown {
				return customNodeExecution{}, fmt.Errorf("persisted fetch plan contains unknown file sizes")
			}
			if usage.Files > maxFiles-totalFiles {
				return customNodeExecution{}, fmt.Errorf("fetch file count exceeds maxFiles")
			}
			totalFiles += usage.Files
			var valid bool
			totalBytes, valid = checkedAddInt64(totalBytes, usage.Bytes)
			if !valid {
				return customNodeExecution{}, fmt.Errorf("fetch size metadata exceeds supported range")
			}
			if totalBytes > maxBytes {
				return customNodeExecution{}, fmt.Errorf("fetch size exceeds maxBytes")
			}
			completed = append(completed, customWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: sourceID, ChildRunID: existing.RunID})
			childRunIDs = append(childRunIDs, existing.RunID)
			continue
		}
		_, _, tracks, err := s.loadRemoteWorkTracksCached(ctx, sourceID, candidate.Code)
		if err != nil {
			candidate.Reason = "fetch_plan_failed"
			failed = append(failed, candidate)
			continue
		}
		item := preparedCustomFetch{Candidate: candidate, RequestID: requestID, Paths: []string{}}
		for _, file := range flattenRemoteSaveFiles(tracks) {
			extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(file.Path), "."))
			if excluded[extension] {
				continue
			}
			item.Paths = append(item.Paths, file.Path)
			item.Files++
			if file.SizeBytes == nil || *file.SizeBytes < 0 {
				item.Unknown++
			} else {
				var valid bool
				item.Bytes, valid = checkedAddInt64(item.Bytes, *file.SizeBytes)
				if !valid {
					return customNodeExecution{}, fmt.Errorf("fetch size metadata exceeds supported range")
				}
			}
		}
		if item.Files == 0 {
			candidate.Reason = "no_files_after_filter"
			failed = append(failed, candidate)
			continue
		}
		if item.Unknown > 0 && !allowUnknown {
			candidate.Reason = "unknown_file_size"
			failed = append(failed, candidate)
			continue
		}
		if item.Files > maxFiles-totalFiles {
			return customNodeExecution{}, fmt.Errorf("fetch file count exceeds maxFiles")
		}
		totalFiles += item.Files
		var valid bool
		totalBytes, valid = checkedAddInt64(totalBytes, item.Bytes)
		if !valid {
			return customNodeExecution{}, fmt.Errorf("fetch size metadata exceeds supported range")
		}
		if totalBytes > maxBytes {
			return customNodeExecution{}, fmt.Errorf("fetch size exceeds maxBytes")
		}
		prepared = append(prepared, item)
	}
	targetTemplate := configString(node.Config, "targetRoot")
	if len(prepared) > 1 && targetTemplate != "" && !strings.Contains(targetTemplate, "<work_code>") {
		return customNodeExecution{}, fmt.Errorf("batch targetRoot must contain <work_code>")
	}
	for _, item := range prepared {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return customNodeExecution{}, err
		}
		requestID := item.RequestID
		if existing, found, err := s.remoteFetchRequestResult(ctx, requestID, item.Candidate.SourceID, item.Candidate.Code); err != nil {
			return customNodeExecution{}, err
		} else if found {
			completed = append(completed, customWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: item.Candidate.SourceID, ChildRunID: existing.RunID})
			childRunIDs = append(childRunIDs, existing.RunID)
			continue
		}
		targetRoot := strings.ReplaceAll(targetTemplate, "<work_code>", item.Candidate.Code)
		result, err := s.enqueueRemoteWorkSave(ctx, item.Candidate.SourceID, item.Candidate.Code, item.Paths, nil, targetRoot, requestID, nil)
		if err != nil {
			item.Candidate.Reason = "fetch_queue_failed"
			failed = append(failed, item.Candidate)
			continue
		}
		completed = append(completed, customWorkRef{Code: result.PrimaryCode, WorkID: result.WorkID, SourceID: item.Candidate.SourceID, ChildRunID: result.RunID})
		childRunIDs = append(childRunIDs, result.RunID)
	}
	return customNodeExecution{Partial: len(failed) > 0, ChildRunIDs: childRunIDs, Outputs: map[string]customPortValue{
		"completed": {Type: "work_refs", WorkRefs: completed}, "failed": {Type: "work_candidates", Candidates: failed},
	}}, nil
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
	return tx.Commit()
}

func (s *Server) failCustomWorkflowJob(ctx context.Context, job workflowJobRecord, failedNodeRunID int64, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "custom workflow failed"
	}
	var failedNodeValue any
	if failedNodeRunID > 0 {
		failedNodeValue = failedNodeRunID
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	runResult, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'failed', summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, mustJSON(map[string]any{"error": message, "failed_node_run_id": failedNodeValue}), job.RunID)
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
		SET status = 'failed', error_message = ?, locked_by = '', locked_at = NULL,
			heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status IN ('queued', 'running')
	`, message, job.ID); err != nil {
		return err
	}
	if failedNodeRunID > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND workflow_run_id = ?
		`, message, failedNodeRunID, job.RunID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'skipped', error_message = 'Not executed because a previous node failed', finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ? AND id <> ? AND status IN ('queued', 'running')
	`, job.RunID, failedNodeRunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: failedNodeRunID, JobID: job.ID, Level: "error", Type: "custom_workflow.failed",
		Message: message, Detail: map[string]any{"failed_node_run_id": failedNodeValue},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func customCandidatesForCodes(codes []string, sourceID int64) []customWorkCandidate {
	result := make([]customWorkCandidate, 0, len(codes))
	for _, code := range codes {
		result = append(result, customWorkCandidate{Code: strings.ToUpper(strings.TrimSpace(code)), SourceID: sourceID})
	}
	return result
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
