package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

type graphWorkCandidate struct {
	Code         string   `json:"code"`
	SourceID     int64    `json:"sourceId,omitempty"`
	Title        string   `json:"title,omitempty"`
	ReleaseDate  string   `json:"releaseDate,omitempty"`
	VoiceNames   []string `json:"voiceNames,omitempty"`
	MetadataTags []string `json:"metadataTags,omitempty"`
	Reason       string   `json:"reason,omitempty"`
}

type graphWorkRef struct {
	Code       string `json:"code"`
	WorkID     int64  `json:"workId"`
	SourceID   int64  `json:"sourceId,omitempty"`
	ChildRunID int64  `json:"childRunId,omitempty"`
}

type graphPortValue struct {
	Type       string               `json:"type"`
	Text       string               `json:"text,omitempty"`
	Candidates []graphWorkCandidate `json:"candidates,omitempty"`
	WorkRefs   []graphWorkRef       `json:"workRefs,omitempty"`
}

type graphNodeExecution struct {
	Outputs     map[string]graphPortValue
	Partial     bool
	ChildRunIDs []int64
	Pending     *graphPendingExecution
}

type graphPendingChild struct {
	RunID     int64              `json:"runId"`
	Candidate graphWorkCandidate `json:"candidate"`
	WorkRef   graphWorkRef       `json:"workRef"`
}

type graphPendingExecution struct {
	NodeID        string               `json:"nodeId"`
	Kind          string               `json:"kind"`
	Children      []graphPendingChild  `json:"children"`
	Failed        []graphWorkCandidate `json:"failed,omitempty"`
	Candidates    []graphWorkCandidate `json:"candidates,omitempty"`
	OutputNodeIDs []string             `json:"outputNodeIds,omitempty"`
}

func (s *Server) executeWorkflowGraphJob(ctx context.Context, job workflowJobRecord) error {
	runtime, err := s.prepareWorkflowGraphRuntime(ctx, job)
	if err != nil {
		return err
	}
	for index, nodeID := range runtime.graph.TopologicalOrder {
		if runtime.completed[nodeID] {
			continue
		}
		deferred, err := s.executeWorkflowGraphRuntimeNode(ctx, job, index, nodeID, &runtime)
		if err != nil {
			return err
		}
		if deferred {
			return nil
		}
	}
	return s.finishWorkflowGraphJob(ctx, job, runtime.checkpoint, len(runtime.graph.TopologicalOrder))
}

type workflowGraphRuntime struct {
	payload    workflowGraphJobPayload
	graph      workflowGraph
	checkpoint workflowGraphCheckpoint
	completed  map[string]bool
	nodeRunIDs map[string]int64
}

func (s *Server) prepareWorkflowGraphRuntime(ctx context.Context, job workflowJobRecord) (workflowGraphRuntime, error) {
	var runtime workflowGraphRuntime
	var payload workflowGraphJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failWorkflowGraphJob(ctx, job, 0, "custom workflow payload is invalid")
		return runtime, err
	}
	graph, err := validateWorkflowGraphDefinition(payload.DefinitionJSON)
	if err != nil {
		_ = s.failWorkflowGraphJob(ctx, job, 0, "custom workflow snapshot is invalid")
		return runtime, err
	}
	if missing := missingWorkflowGraphPermission(payload.Permissions, workflowGraphRequiredPermissions(graph)); missing != "" {
		err := fmt.Errorf("permission snapshot is missing %s", missing)
		_ = s.failWorkflowGraphJob(ctx, job, 0, "custom workflow permission snapshot is invalid")
		return runtime, err
	}
	checkpoint := workflowGraphCheckpoint{Outputs: map[string]map[string]graphPortValue{}, CompletedNodeIDs: []string{}, ChildRunIDs: []int64{}}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failWorkflowGraphJob(ctx, job, 0, "custom workflow checkpoint is invalid")
		return runtime, err
	}
	if checkpoint.Outputs == nil {
		checkpoint.Outputs = map[string]map[string]graphPortValue{}
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
		_ = s.failWorkflowGraphJob(ctx, job, 0, "custom workflow node runs are unavailable")
		return runtime, err
	}
	return workflowGraphRuntime{payload: payload, graph: graph, checkpoint: checkpoint, completed: completed, nodeRunIDs: nodeRunIDs}, nil
}

func (s *Server) executeWorkflowGraphRuntimeNode(ctx context.Context, job workflowJobRecord, index int, nodeID string, runtime *workflowGraphRuntime) (bool, error) {
	if err := s.ensureWorkflowRunActive(ctx, job.RunID); err != nil {
		return false, err
	}
	node := runtime.graph.NodesByID[nodeID]
	inputs, err := graphRuntimeNodeInputs(runtime.graph, node, runtime.checkpoint.Outputs)
	if err != nil {
		_ = s.failWorkflowGraphJob(ctx, job, runtime.nodeRunIDs[nodeID], "custom workflow input resolution failed")
		return false, err
	}
	nodeRunID := runtime.nodeRunIDs[nodeID]
	if err := s.startWorkflowGraphNode(ctx, job, nodeRunID, node, inputs); err != nil {
		return false, err
	}
	execution, waiting, runErr := s.runWorkflowGraphRuntimeNode(ctx, job, nodeID, node, inputs, runtime)
	if runErr != nil {
		slog.Error("custom workflow node failed", "run_id", job.RunID, "node_id", node.ID, "node_type", node.Type, "error", runErr)
		_ = s.failWorkflowGraphJob(ctx, job, nodeRunID, publicWorkflowGraphError(node.Type))
		return false, runErr
	}
	if waiting {
		return true, s.deferWorkflowGraphJob(ctx, job, nodeRunID, runtime.checkpoint)
	}
	if execution.Pending != nil {
		runtime.checkpoint.Pending = execution.Pending
		for _, child := range execution.Pending.Children {
			runtime.checkpoint.ChildRunIDs = appendUniqueInt64(runtime.checkpoint.ChildRunIDs, child.RunID)
		}
		return true, s.deferWorkflowGraphJob(ctx, job, nodeRunID, runtime.checkpoint)
	}
	status := "succeeded"
	if execution.Partial {
		status = "partial"
		runtime.checkpoint.Partial = true
	}
	if execution.Outputs == nil {
		execution.Outputs = map[string]graphPortValue{}
	}
	if err := s.completeWorkflowGraphNode(ctx, job, nodeRunID, node, status, execution.Outputs); err != nil {
		return false, err
	}
	runtime.checkpoint.Outputs[nodeID] = execution.Outputs
	runtime.checkpoint.CompletedNodeIDs = append(runtime.checkpoint.CompletedNodeIDs, nodeID)
	runtime.checkpoint.ChildRunIDs = append(runtime.checkpoint.ChildRunIDs, execution.ChildRunIDs...)
	runtime.completed[nodeID] = true
	err = s.updateWorkflowJobCheckpoint(ctx, job.ID, nodeID, runtime.checkpoint, index+1, len(runtime.graph.TopologicalOrder))
	return false, err
}

func (s *Server) runWorkflowGraphRuntimeNode(ctx context.Context, job workflowJobRecord, nodeID string, node workflowGraphNode, inputs map[string]graphPortValue, runtime *workflowGraphRuntime) (graphNodeExecution, bool, error) {
	if runtime.checkpoint.Pending == nil {
		execution, err := s.executeWorkflowGraphNode(ctx, job.RunID, runtime.checkpoint.BasePriority, runtime.payload, runtime.graph, node, inputs)
		return execution, false, err
	}
	if runtime.checkpoint.Pending.NodeID != nodeID {
		return graphNodeExecution{}, false, fmt.Errorf("custom workflow pending node does not match execution order")
	}
	execution, waiting, err := s.resumeGraphPendingExecution(ctx, *runtime.checkpoint.Pending)
	if err == nil && !waiting {
		runtime.checkpoint.Pending = nil
	}
	return execution, waiting, err
}

func (s *Server) startWorkflowGraphNode(ctx context.Context, job workflowJobRecord, nodeRunID int64, node workflowGraphNode, inputs map[string]graphPortValue) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'running', input_json = ?, error_message = '', started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = NULL
		WHERE id = ?
	`, mustJSON(graphPortValuesSummary(inputs)), nodeRunID); err != nil {
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

func (s *Server) completeWorkflowGraphNode(ctx context.Context, job workflowJobRecord, nodeRunID int64, node workflowGraphNode, status string, outputs map[string]graphPortValue) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?, output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, mustJSON(graphPortValuesSummary(outputs)), nodeRunID); err != nil {
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

func (s *Server) resumeGraphPendingExecution(ctx context.Context, pending graphPendingExecution) (graphNodeExecution, bool, error) {
	switch pending.Kind {
	case "fetch":
		return s.resumeGraphPendingFetch(ctx, pending)
	default:
		return graphNodeExecution{}, false, fmt.Errorf("unsupported pending custom workflow operation")
	}
}

func (s *Server) resumeGraphPendingFetch(ctx context.Context, pending graphPendingExecution) (graphNodeExecution, bool, error) {
	completed := []graphWorkRef{}
	failed := append([]graphWorkCandidate{}, pending.Failed...)
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
			return graphNodeExecution{}, false, err
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
		return graphNodeExecution{}, true, nil
	}
	return graphNodeExecution{Partial: len(failed) > 0, Outputs: map[string]graphPortValue{
		"completed": {Type: "work_refs", WorkRefs: uniqueGraphWorkRefs(completed)},
		"failed":    {Type: "work_candidates", Candidates: uniqueGraphCandidates(failed)},
	}}, false, nil
}

func (s *Server) deferWorkflowGraphJob(ctx context.Context, job workflowJobRecord, nodeRunID int64, checkpoint workflowGraphCheckpoint) error {
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
	defer func() { _ = tx.Rollback() }()
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

func graphRuntimeNodeInputs(graph workflowGraph, node workflowGraphNode, outputs map[string]map[string]graphPortValue) (map[string]graphPortValue, error) {
	result := map[string]graphPortValue{}
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

func (s *Server) finishWorkflowGraphJob(ctx context.Context, job workflowJobRecord, checkpoint workflowGraphCheckpoint, total int) error {
	status := "succeeded"
	if checkpoint.Partial {
		status = "partial"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
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
	if err := updateWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) failWorkflowGraphJob(ctx context.Context, job workflowJobRecord, failedNodeRunID int64, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "custom workflow failed"
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	failedNodeID, failedNodeType, err := loadWorkflowGraphFailedNode(ctx, tx, job.RunID, failedNodeRunID)
	if err != nil {
		return err
	}
	updated, err := markWorkflowGraphRunAndJobFailed(ctx, tx, job, failedNodeRunID, message)
	if err != nil || !updated {
		return err
	}
	if err := markWorkflowGraphNodeRunsFailed(ctx, tx, job.RunID, failedNodeRunID, message); err != nil {
		return err
	}
	if err := insertWorkflowGraphFailureEvents(ctx, tx, job, failedNodeRunID, failedNodeID, failedNodeType, message); err != nil {
		return err
	}
	if err := updateWorkflowTriggerFailure(ctx, tx, job.RunID, message); err != nil {
		return err
	}
	return tx.Commit()
}

func loadWorkflowGraphFailedNode(ctx context.Context, tx *sql.Tx, runID, nodeRunID int64) (string, string, error) {
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

func markWorkflowGraphRunAndJobFailed(ctx context.Context, tx *sql.Tx, job workflowJobRecord, failedNodeRunID int64, message string) (bool, error) {
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

func markWorkflowGraphNodeRunsFailed(ctx context.Context, tx *sql.Tx, runID, failedNodeRunID int64, message string) error {
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

func insertWorkflowGraphFailureEvents(ctx context.Context, tx *sql.Tx, job workflowJobRecord, failedNodeRunID int64, failedNodeID, failedNodeType, message string) error {
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

func publicWorkflowGraphError(nodeType string) string {
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
