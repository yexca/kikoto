package httpapi

// Workflow graph projections, ports, and permission requirements.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

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
