package httpapi

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

func canUseWorkflowDefinition(actor currentUser, definition workflowDefinitionRecord) bool {
	return definition.Scope == "system"
}

type workflowGraphJobPayload struct {
	DefinitionJSON string         `json:"definitionJson"`
	Inputs         map[string]any `json:"inputs"`
	UserID         int64          `json:"userId"`
	Permissions    []string       `json:"permissions"`
	StartedAt      string         `json:"startedAt"`
}

type workflowGraphCheckpoint struct {
	CompletedNodeIDs []string                             `json:"completedNodeIds"`
	Outputs          map[string]map[string]graphPortValue `json:"outputs"`
	ChildRunIDs      []int64                              `json:"childRunIds"`
	Pending          *graphPendingExecution               `json:"pending,omitempty"`
	Partial          bool                                 `json:"partial"`
	BasePriority     int                                  `json:"basePriority"`
}

type workflowGraphEnqueueOptions struct {
	TriggerID     int64
	TriggerType   string
	TriggerReason string
	// DefinitionJSON overrides the stored definition snapshot. Preset workflows
	// build their graph per dispatch while the system definition record only
	// carries a display pipeline.
	DefinitionJSON string
}

func (s *Server) enqueueWorkflowGraph(ctx context.Context, definition workflowDefinitionRecord, graph workflowGraph, userID int64, permissions []string, inputs map[string]any, options workflowGraphEnqueueOptions) (int64, error) {
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
	runInput := map[string]any{"inputs": inputs, "definition_schema_version": workflowGraphSchemaVersion, "requested_by_user_id": userID}
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
			Input: map[string]any{"config": publicWorkflowGraphConfig(node.Config)},
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
	payload := workflowGraphJobPayload{DefinitionJSON: definitionJSON, Inputs: inputs, UserID: userID, Permissions: append([]string{}, permissions...), StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	jobPriority := workflowJobPriorityForTrigger(triggerType)
	checkpoint := workflowGraphCheckpoint{CompletedNodeIDs: []string{}, Outputs: map[string]map[string]graphPortValue{}, ChildRunIDs: []int64{}, BasePriority: jobPriority}
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

func publicWorkflowGraphConfig(config map[string]any) map[string]any {
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
	items, err := graphStringValues(value)
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
