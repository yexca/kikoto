package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type remoteCollectionRunRequest struct {
	SourceID        int64  `json:"sourceId"`
	Action          string `json:"action"`
	Limit           int    `json:"limit"`
	TagName         string `json:"tagName"`
	TagNameTemplate string `json:"tagNameTemplate"`
}

type remoteCollectionRunResult struct {
	RunID           int64    `json:"runId"`
	SourceID        int64    `json:"sourceId"`
	CollectionKind  string   `json:"collectionKind"`
	Action          string   `json:"action"`
	Status          string   `json:"status"`
	Discovered      int      `json:"discovered"`
	Accepted        int      `json:"accepted"`
	Skipped         int      `json:"skipped"`
	Tracked         int      `json:"tracked"`
	Fetched         int      `json:"fetched"`
	Tagged          int      `json:"tagged"`
	Failed          int      `json:"failed"`
	ChildRuns       []int64  `json:"childRuns"`
	Failures        []string `json:"failures"`
	ExpectedMaximum int      `json:"expectedMaximum"`
	ReturnedCount   int      `json:"returnedCount"`
	TagName         string   `json:"tagName"`
}

type remoteCollectionJobCheckpoint struct {
	CompletedCodes []string                  `json:"completedCodes"`
	Candidates     []kikoeru.Work            `json:"candidates"`
	Result         remoteCollectionRunResult `json:"result"`
}

type remoteCollectionJobPayload struct {
	UserID   int64  `json:"user_id"`
	SourceID int64  `json:"source_id"`
	Action   string `json:"action"`
	Limit    int    `json:"limit"`
	TagName  string `json:"tag_name"`
}

func (s *Server) runRemotePopularWorkflow(ctx context.Context, userID int64, payload remoteCollectionRunRequest) (remoteCollectionRunResult, error) {
	return s.runRemotePopularWorkflowWithTrigger(ctx, userID, payload, workflowRunTrigger{Type: "manual", Reason: normalizeRemoteCollectionAction(payload.Action)})
}

func (s *Server) runRemotePopularWorkflowWithTrigger(ctx context.Context, userID int64, payload remoteCollectionRunRequest, trigger workflowRunTrigger) (remoteCollectionRunResult, error) {
	action, source, payload, err := s.prepareRemotePopularWorkflow(ctx, payload)
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	return s.enqueueRemotePopularWorkflow(ctx, userID, source, payload, action, trigger)
}

func (s *Server) prepareRemotePopularWorkflow(ctx context.Context, payload remoteCollectionRunRequest) (string, remoteSourceForUse, remoteCollectionRunRequest, error) {
	action := normalizeRemoteCollectionAction(payload.Action)
	if action == "" {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("action must be track or fetch")
	}
	if payload.SourceID <= 0 {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("sourceId is required")
	}
	if payload.Limit <= 0 || payload.Limit > 100 {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("limit must be between 1 and 100")
	}
	source, err := s.remoteCollectionSource(ctx, payload.SourceID)
	if err != nil {
		return "", remoteSourceForUse{}, payload, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("source is not an enabled compatible remote source")
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("source has no API endpoint")
	}
	payload.TagNameTemplate = strings.TrimSpace(payload.TagNameTemplate)
	if payload.TagNameTemplate != "" {
		payload.TagName, err = renderWorkflowTagNameTemplate(payload.TagNameTemplate, map[string]string{
			"date": time.Now().UTC().Format("060102"), "remote_name": workflowTagFragment(source.DisplayName),
			"source_code": workflowTagFragment(source.Code), "action": action,
		})
		if err != nil {
			return "", remoteSourceForUse{}, payload, err
		}
	}
	payload.TagName = strings.TrimSpace(payload.TagName)
	if payload.TagName == "" {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("tagName or tagNameTemplate is required")
	}
	if runes := []rune(payload.TagName); len(runes) > 40 {
		payload.TagName = string(runes[:40])
	}
	return action, source, payload, nil
}

func (s *Server) enqueueRemotePopularWorkflow(ctx context.Context, userID int64, source remoteSourceForUse, payload remoteCollectionRunRequest, action string, trigger workflowRunTrigger) (remoteCollectionRunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_popular_collection", "Collect popular remote works", "Discover popular works from a selected compatible source, track or fetch them, and append a user tag.", remotePopularCollectionDefinition())
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	input := map[string]any{"source_id": source.ID, "collection_kind": "popular", "action": action, "limit": payload.Limit, "tag_name": payload.TagName, "user_id": userID}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_popular_collection", "Collect popular remote works", "queued", trigger.Type, trigger.Reason, input, map[string]any{"source_id": source.ID, "action": action, "limit": payload.Limit, "tag_name": payload.TagName})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return remoteCollectionRunResult{}, err
		}
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "configure", NodeType: "select_remote_source", DisplayName: "Configure remote collection", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"source_id": source.ID, "source_code": source.Code, "action": action, "limit": payload.Limit, "tag_name": payload.TagName},
	}); err != nil {
		return remoteCollectionRunResult{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_collection", DisplayName: "Discover popular works", Position: 2, Status: "queued",
		Input: map[string]any{"source_id": source.ID, "collection_kind": "popular", "page": 1, "page_size": payload.Limit},
	})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter collection candidates", Position: 3, Status: "queued", Input: map[string]any{"limit": payload.Limit}},
		{NodeID: "dispatch", NodeType: "dispatch_child_workflows", DisplayName: "Dispatch accepted works", Position: 4, Status: "queued", Input: map[string]any{"action": action}},
		{NodeID: "tag", NodeType: "assign_user_tags", DisplayName: "Add user tag", Position: 5, Status: "queued", Input: map[string]any{"tag_name": payload.TagName, "user_id": userID}},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return remoteCollectionRunResult{}, err
		}
	}
	result := remoteCollectionRunResult{
		RunID: runID, SourceID: source.ID, CollectionKind: "popular", Action: action, Status: "queued",
		ChildRuns: []int64{}, Failures: []string{}, ExpectedMaximum: payload.Limit, TagName: payload.TagName,
	}
	jobPayload := remoteCollectionJobPayload{UserID: userID, SourceID: source.ID, Action: action, Limit: payload.Limit, TagName: payload.TagName}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: discoverNodeID, WorkerType: "remote_popular_collection", Status: "queued", Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: sourceResourceKey(source.Endpoint.APIURL), Payload: jobPayload,
		Checkpoint: remoteCollectionJobCheckpoint{CompletedCodes: []string{}, Candidates: nil, Result: result}, Recoverable: true, MaxRetries: 3,
	}); err != nil {
		return remoteCollectionRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteCollectionRunResult{}, err
	}
	return result, nil
}

func remotePopularCollectionDefinition() map[string]any {
	return map[string]any{"nodes": []map[string]string{
		{"id": "configure", "type": "select_remote_source", "displayName": "Configure remote collection"},
		{"id": "discover", "type": "discover_remote_collection", "displayName": "Discover popular works"},
		{"id": "filter", "type": "filter_candidates", "displayName": "Filter collection candidates"},
		{"id": "dispatch", "type": "dispatch_child_workflows", "displayName": "Dispatch accepted works"},
		{"id": "tag", "type": "assign_user_tags", "displayName": "Add user tag"},
	}}
}

func (s *Server) executeRemotePopularCollectionJob(ctx context.Context, job workflowJobRecord) error {
	payload, checkpoint, source, nodeIDs, err := s.loadRemotePopularJobState(ctx, job)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result := checkpoint.Result
	result.RunID = job.RunID
	result.SourceID = source.ID
	result.Action = normalizeRemoteCollectionAction(payload.Action)
	result.CollectionKind = "popular"
	result.TagName = payload.TagName
	result.ExpectedMaximum = payload.Limit
	result.Status = "running"
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", job.RunID); err != nil {
		return err
	}

	result, checkpoint, err = s.discoverRemotePopularCandidates(ctx, job, payload, source, nodeIDs, result, checkpoint)
	if err != nil {
		return err
	}

	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id IN (?, ?)", nodeIDs["dispatch"], nodeIDs["tag"]); err != nil {
		return err
	}
	result, checkpoint, err = s.dispatchRemotePopularCandidates(ctx, job, payload, source, result, checkpoint)
	if err != nil {
		return err
	}
	result.Status = remoteCollectionResultStatus(result)
	return s.finishRemotePopularCollectionJob(ctx, job, nodeIDs, result)
}

func (s *Server) loadRemotePopularJobState(ctx context.Context, job workflowJobRecord) (remoteCollectionJobPayload, remoteCollectionJobCheckpoint, remoteSourceForUse, map[string]int64, error) {
	var payload remoteCollectionJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		return payload, remoteCollectionJobCheckpoint{}, remoteSourceForUse{}, nil, err
	}
	checkpoint := remoteCollectionJobCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		return payload, checkpoint, remoteSourceForUse{}, nil, err
	}
	source, err := s.remoteCollectionSource(ctx, payload.SourceID)
	if err != nil {
		return payload, checkpoint, remoteSourceForUse{}, nil, err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	return payload, checkpoint, source, nodeIDs, err
}

func (s *Server) discoverRemotePopularCandidates(ctx context.Context, job workflowJobRecord, payload remoteCollectionJobPayload, source remoteSourceForUse, nodeIDs map[string]int64, result remoteCollectionRunResult, checkpoint remoteCollectionJobCheckpoint) (remoteCollectionRunResult, remoteCollectionJobCheckpoint, error) {
	if checkpoint.Candidates != nil {
		result.Accepted = len(checkpoint.Candidates)
		if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP) WHERE id = ?", mustJSON(map[string]any{"returned": result.ReturnedCount, "resumed": true}), nodeIDs["discover"]); err != nil {
			return result, checkpoint, err
		}
		if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP) WHERE id = ?", mustJSON(map[string]any{"accepted": result.Accepted, "skipped": result.Skipped, "resumed": true}), nodeIDs["filter"]); err != nil {
			return result, checkpoint, err
		}
		return result, checkpoint, nil
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", nodeIDs["discover"]); err != nil {
		return result, checkpoint, err
	}
	page, err := s.kikoeruCrawlClientForSource(source).PopularWorks(ctx, 1, payload.Limit)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return result, checkpoint, err
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	checkpoint.Candidates = uniqueRemoteCollectionWorks(page.Works, payload.Limit)
	result.Discovered = len(page.Works)
	result.ReturnedCount = len(page.Works)
	result.Accepted = len(checkpoint.Candidates)
	result.Skipped = max(0, len(page.Works)-len(checkpoint.Candidates))
	checkpoint.Result = result
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"returned": len(page.Works), "pagination": page.Pagination}), nodeIDs["discover"]); err != nil {
		return result, checkpoint, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"accepted": result.Accepted, "skipped": result.Skipped}), nodeIDs["filter"]); err != nil {
		return result, checkpoint, err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "discovered", checkpoint, len(checkpoint.CompletedCodes), len(checkpoint.Candidates))
	return result, checkpoint, nil
}

type remotePopularCandidateOutcome struct {
	code       string
	workID     int64
	childRunID int64
	tracked    bool
	fetched    bool
	tagged     bool
	failure    string
}

func (s *Server) dispatchRemotePopularCandidates(ctx context.Context, job workflowJobRecord, payload remoteCollectionJobPayload, source remoteSourceForUse, result remoteCollectionRunResult, checkpoint remoteCollectionJobCheckpoint) (remoteCollectionRunResult, remoteCollectionJobCheckpoint, error) {
	completed := make(map[string]bool, len(checkpoint.CompletedCodes))
	for _, code := range checkpoint.CompletedCodes {
		completed[strings.ToUpper(strings.TrimSpace(code))] = true
	}
	for index, work := range checkpoint.Candidates {
		if err := s.ensureWorkflowRunActive(ctx, job.RunID); err != nil {
			return result, checkpoint, err
		}
		code := normalizedRemoteWorkCode(work)
		if code == "" {
			result.Skipped++
			result.Failures = append(result.Failures, "remote work missing stable code")
			continue
		}
		if completed[code] {
			continue
		}
		outcome := s.dispatchRemotePopularCandidate(ctx, job, payload, source, work, code, result.Action)
		if outcome.tracked {
			result.Tracked++
		}
		if outcome.fetched {
			result.Fetched++
			result.ChildRuns = append(result.ChildRuns, outcome.childRunID)
		}
		if outcome.failure != "" {
			result.Failed++
			result.Failures = append(result.Failures, outcome.failure)
		}
		if outcome.tagged {
			result.Tagged++
		}
		completed[code] = true
		checkpoint.CompletedCodes = sortedStringKeys(completed)
		checkpoint.Result = result
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "dispatch", checkpoint, index+1, len(checkpoint.Candidates))
	}
	return result, checkpoint, nil
}

func (s *Server) dispatchRemotePopularCandidate(ctx context.Context, job workflowJobRecord, payload remoteCollectionJobPayload, source remoteSourceForUse, work kikoeru.Work, code, action string) remotePopularCandidateOutcome {
	outcome := remotePopularCandidateOutcome{code: code}
	if action == "track" {
		workID, err := s.trackRemoteCollectionWork(ctx, source, work, "popular", job.RunID)
		if err != nil {
			outcome.failure = fmt.Sprintf("%s: %s", code, err.Error())
			return outcome
		}
		outcome.workID, outcome.tracked = workID, workID > 0
	} else {
		fetchResult, err := s.enqueueRemoteWorkSave(ctx, source.ID, code, []string{}, nil, "", "", nil, 0, payload.UserID, workflow.JobPriorityBackground)
		if err != nil {
			outcome.failure = fmt.Sprintf("%s: %s", code, err.Error())
			return outcome
		}
		outcome.workID, outcome.childRunID, outcome.fetched = fetchResult.WorkID, fetchResult.RunID, true
		s.execBestEffort(ctx, "record popular collection candidate", `
			INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
			VALUES (?, 'remote_work', ?, 'accepted', ?)
		`, job.RunID, code, mustJSON(map[string]any{"collection_kind": "popular", "remote_work_id": work.ID, "child_run_id": fetchResult.RunID}))
	}
	if outcome.workID <= 0 {
		outcome.failure = fmt.Sprintf("%s: work was not persisted", code)
		return outcome
	}
	if _, err := s.addWorkUserTag(ctx, payload.UserID, []int64{outcome.workID}, payload.TagName); err != nil {
		outcome.failure = fmt.Sprintf("%s tag: %s", code, err.Error())
		return outcome
	}
	outcome.tagged = true
	return outcome
}

func remoteCollectionResultStatus(result remoteCollectionRunResult) string {
	succeeded := result.Tracked + result.Fetched
	if result.Failed > 0 && succeeded == 0 {
		return "failed"
	}
	if result.Failed > 0 {
		return "partial"
	}
	return "succeeded"
}

func (s *Server) finishRemotePopularCollectionJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, result remoteCollectionRunResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, mustJSON(map[string]any{"action": result.Action, "tracked": result.Tracked, "fetched": result.Fetched, "child_runs": result.ChildRuns, "failed": result.Failed}), strings.Join(result.Failures, "\n"), nodeIDs["dispatch"]); err != nil {
		return err
	}
	tagStatus := "succeeded"
	succeeded := result.Tracked + result.Fetched
	if result.Tagged < succeeded {
		tagStatus = "partial"
	}
	if result.Tagged == 0 && succeeded > 0 {
		tagStatus = "failed"
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", tagStatus, mustJSON(map[string]any{"tag_name": result.TagName, "tagged": result.Tagged}), nodeIDs["tag"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.Accepted, result.Accepted, strings.Join(result.Failures, "\n"), job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, mustJSON(result), job.RunID); err != nil {
		return err
	}
	if result.Status == "succeeded" {
		if err := updateWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
			return err
		}
	} else if err := updateWorkflowTriggerFailure(ctx, tx, job.RunID, strings.Join(result.Failures, "; ")); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) remoteCollectionSource(ctx context.Context, sourceID int64) (remoteSourceForUse, error) {
	if sourceID <= 0 {
		return remoteSourceForUse{}, fmt.Errorf("sourceId is required")
	}
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteSourceForUse{}, fmt.Errorf("source not found")
	}
	return source, err
}

func normalizeRemoteCollectionAction(action string) string {
	switch strings.TrimSpace(action) {
	case "track", "tracked":
		return "track"
	case "fetch", "local":
		return "fetch"
	default:
		return ""
	}
}

func uniqueRemoteCollectionWorks(works []kikoeru.Work, limit int) []kikoeru.Work {
	result := make([]kikoeru.Work, 0, len(works))
	seen := map[string]bool{}
	for _, work := range works {
		code := normalizedRemoteWorkCode(work)
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		result = append(result, work)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	return result
}

func (s *Server) trackRemoteCollectionWork(ctx context.Context, source remoteSourceForUse, remoteWork kikoeru.Work, collectionKind string, runID int64) (int64, error) {
	rawWork, _ := json.Marshal(remoteWork)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, rawWork, true)
	if err != nil {
		return 0, err
	}
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: "tracked",
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		RemoteCode:   normalizedRemoteWorkCode(remoteWork),
		SourceURL:    remoteWork.SourceURL,
		Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"collection_kind": collectionKind,
			"primary_code":    normalizedRemoteWorkCode(remoteWork),
			"remote_work_id":  remoteWork.ID,
		}),
	}); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'remote_work', ?, 'accepted', ?)
	`, runID, normalizedRemoteWorkCode(remoteWork), mustJSON(map[string]any{"collection_kind": collectionKind, "remote_work_id": remoteWork.ID})); err != nil {
		return 0, err
	}
	return workID, tx.Commit()
}

func (s *Server) createRemotePopularCollectionRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	var payload remoteCollectionRunRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	payload.Action = normalizeRemoteCollectionAction(payload.Action)
	if payload.Action == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be track or fetch"})
		return
	}
	if _, ok := s.requirePermission(w, r, "tags:write"); !ok {
		return
	}
	if payload.Action == "fetch" {
		if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
			return
		}
	}
	result, err := s.runRemotePopularWorkflow(r.Context(), actor.ID, payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}
