package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type llmExecutionSnapshot struct {
	Started       bool
	Text          llm.Text
	CachedTags    map[int64]string
	SendingTagIDs []int64
}

type llmTask struct {
	Execution                                           llmExecutionSnapshot
	ID, RunID, UserID, WorkID                           int64
	InputHash, PolicyHash, ConfigHash, State, PreviewID string
	Payload                                             llmTranslatePayload
	Result                                              llm.Text
	Index                                               int
}
type llmJobPayload struct {
	TaskID int64 `json:"task_id"`
	UserID int64 `json:"requested_by_user_id"`
}
type llmRunResponse struct {
	WorkID       int64  `json:"workId"`
	RunID        int64  `json:"runId"`
	State        string `json:"state"`
	Deduplicated bool   `json:"deduplicated"`
}

func (s *Server) createLLMTranslationRuns(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermissions(w, r, "metadata:sync", "library:write", "workflows:run")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	var body struct {
		WorkCodes []string `json:"workCodes"`
		llmTranslatePayload
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || len(body.WorkCodes) == 0 || len(body.WorkCodes) > 100 {
		writeAPIError(w, 400, "invalid_translation_scope", "Select 1–100 existing works.", false)
		return
	}
	if len(body.WorkCodes) > 1 && body.LyricsLocationID > 0 {
		writeAPIError(w, 400, "invalid_translation_scope", "Lyrics translation selects one work and one explicit file.", false)
		return
	}
	ids := []int64{}
	seen := map[int64]bool{}
	for _, raw := range body.WorkCodes {
		code := normalizeWorkCode(raw)
		var id int64
		if code == "" || s.db.QueryRowContext(r.Context(), "SELECT id FROM work WHERE primary_code=?", code).Scan(&id) != nil {
			writeAPIError(w, 400, "invalid_translation_scope", "Every selected code must already exist in the library.", false)
			return
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	runs, err := s.enqueueLLMTranslations(r.Context(), actor.ID, ids, body.llmTranslatePayload)
	if err != nil {
		writeLLMRequestError(w, err)
		return
	}
	writeJSON(w, 202, map[string]any{"runs": runs})
}
func (s *Server) enqueueLLMTranslations(ctx context.Context, userID int64, ids []int64, payload llmTranslatePayload) ([]llmRunResponse, error) {
	actor, err := s.accountStore.LoadByID(ctx, userID)
	if err != nil || !userHasPermission(actor, "library:write") || !userHasPermission(actor, "metadata:sync") || !userHasPermission(actor, "workflows:run") {
		return nil, llmInvalid("llm_permission_changed", "Translation permission changed.")
	}
	ctx = context.WithValue(ctx, currentUserKey, actor)

	if len(ids) == 0 || len(ids) > 100 {
		return nil, llmInvalid("invalid_translation_scope", "Select 1–100 existing works.")
	}
	plans := make([]llmTranslationPlan, len(ids))
	for i, id := range ids {
		plan, err := s.prepareLLMTranslation(ctx, id, payload)
		if err != nil {
			return nil, err
		}
		plans[i] = plan
	}
	// The stable field order makes equivalent selections share a task.
	sort.Strings(payload.Fields)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "llm_translation", "LLM translation", "Translate explicitly selected work content for user review.", map[string]any{"nodes": []map[string]string{{"id": "translate", "type": "llm_translation", "displayName": "Translate for review"}}})
	if err != nil {
		return nil, err
	}
	result := []llmRunResponse{}
	for i, workID := range ids {
		plan := plans[i]
		inputHash, policyHash, configHash := llmPlanHash(plan), llmValueHash(plan.Policy), s.llmConfigHash(plan.Provider)
		key := llmValueHash(struct {
			User, Work            int64
			Input, Policy, Config string
			Payload               llmTranslatePayload
		}{userID, workID, inputHash, policyHash, configHash, payload})
		var runID int64
		var state string
		err := tx.QueryRowContext(ctx, "SELECT workflow_run_id,state FROM llm_translation_task WHERE dedup_key=?", key).Scan(&runID, &state)
		if err == nil {
			if state == "cancelled" {
				var job workflowJobRecord
				if err := tx.QueryRowContext(ctx, "SELECT id,workflow_run_id,COALESCE(workflow_node_run_id,0),retry_count FROM workflow_job WHERE workflow_run_id=? AND worker_type='llm_translation' AND status='cancelled'", runID).Scan(&job.ID, &job.RunID, &job.NodeRunID, &job.RetryCount); err != nil {
					return nil, err
				}
				job.WorkerType = "llm_translation"
				if _, err := tx.ExecContext(ctx, "UPDATE workflow_job SET status='failed' WHERE id=?", job.ID); err != nil {
					return nil, err
				}
				if _, err := tx.ExecContext(ctx, "UPDATE llm_translation_task SET state='pending',failure_code='',updated_at=CURRENT_TIMESTAMP WHERE dedup_key=? AND state='cancelled'", key); err != nil {
					return nil, err
				}
				if err := requeueWorkflowJobTx(ctx, tx, job, time.Now().UTC().Format("2006-01-02 15:04:05"), "Explicitly resume cancelled translation", true); err != nil {
					return nil, err
				}
				state = "pending"
			}
			result = append(result, llmRunResponse{workID, runID, state, true})
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		input := map[string]any{workflowRunRequesterKey: userID, "work_id": workID, "target_language": payload.Target, "fields": payload.Fields}
		runID, err = workflow.InsertRun(ctx, tx, definitionID, "llm_translation", "LLM translation", "queued", "manual", "selected_work_translation", input, map[string]any{})
		if err != nil {
			return nil, err
		}
		task, err := tx.ExecContext(ctx, `INSERT INTO llm_translation_task(workflow_run_id,user_id,work_id,dedup_key,input_hash,policy_hash,config_hash,request_json) VALUES(?,?,?,?,?,?,?,?)`, runID, userID, workID, key, inputHash, policyHash, configHash, mustJSON(payload))
		if err != nil {
			return nil, err
		}
		taskID, err := task.LastInsertId()
		if err != nil {
			return nil, err
		}
		nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "translate", NodeType: "llm_translation", DisplayName: "Translate for review", Position: 1, Status: "queued", Input: input})
		if err != nil {
			return nil, err
		}
		_, err = workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: "llm_translation", Status: "queued", Priority: workflowJobPriorityForTrigger("manual"), ResourceKey: "llm:translation", Payload: llmJobPayload{taskID, userID}, Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3})
		if err != nil {
			return nil, err
		}
		result = append(result, llmRunResponse{workID, runID, "pending", false})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
func (s *Server) loadLLMTask(ctx context.Context, id int64) (llmTask, error) {
	var task llmTask
	var request, result, execution string
	err := s.db.QueryRowContext(ctx, `SELECT id,workflow_run_id,user_id,work_id,input_hash,policy_hash,config_hash,state,COALESCE(preview_id,''),request_json,result_json,request_index,execution_json FROM llm_translation_task WHERE id=?`, id).Scan(&task.ID, &task.RunID, &task.UserID, &task.WorkID, &task.InputHash, &task.PolicyHash, &task.ConfigHash, &task.State, &task.PreviewID, &request, &result, &task.Index, &execution)
	if err != nil {
		return task, err
	}
	if err = json.Unmarshal([]byte(request), &task.Payload); err != nil {
		return task, err
	}
	if err := json.Unmarshal([]byte(execution), &task.Execution); err != nil {
		return task, err
	}
	err = json.Unmarshal([]byte(result), &task.Result)
	return task, err
}
func (s *Server) failLLMTask(ctx context.Context, job workflowJobRecord, task llmTask, state, code string) error {
	ctx = context.WithoutCancel(ctx)
	if _, err := s.db.ExecContext(ctx, "UPDATE llm_translation_task SET state=?,failure_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state<>'ready'", state, code, task.ID); err != nil {
		return err
	}
	// Fixed diagnostics contain no endpoint, key, filename or source text.
	message := "Translation stopped: " + code
	if err := s.failClaimedWorkflowJob(ctx, job, message); err != nil {
		return err
	}
	return errors.New(message)
}
func (s *Server) executeLLMTranslationJob(ctx context.Context, job workflowJobRecord) error {
	var payload llmJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		return errors.New("invalid translation job")
	}
	task, err := s.loadLLMTask(ctx, payload.TaskID)
	if err != nil {
		return errors.New("translation task is unavailable")
	}
	if task.RunID != job.RunID || task.UserID != payload.UserID {
		return errors.New("translation job scope mismatch")
	}
	if task.State == "requesting" || task.State == "uncertain" {
		return s.failLLMTask(ctx, job, task, "uncertain", "upstream_result_unknown")
	}
	if task.State == "ready" {
		return s.finishLLMTranslationJob(ctx, job, task.PreviewID)
	}
	if task.State == "invalid" || task.State == "cancelled" {
		return s.failLLMTask(ctx, job, task, task.State, "translation_input_changed")
	}
	actor, err := s.accountStore.LoadByID(ctx, task.UserID)
	if err != nil || !userHasPermission(actor, "metadata:sync") || !userHasPermission(actor, "library:write") || !userHasPermission(actor, "workflows:run") {
		return s.failLLMTask(ctx, job, task, "invalid", "permission_changed")
	}
	ctx = context.WithValue(ctx, currentUserKey, actor)
	plan, err := s.prepareLLMTranslation(ctx, task.WorkID, task.Payload)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var invalid llmRequestError
		if errors.As(err, &invalid) && (invalid.Code == "llm_lyrics_unavailable" || invalid.Code == "llm_lyrics_scope") {
			return s.failLLMTask(ctx, job, task, "failed", "source_temporarily_unavailable")
		}
		return s.failLLMTask(ctx, job, task, "invalid", "content_or_endpoint_unavailable")
	}
	if llmPlanHash(plan) != task.InputHash || llmValueHash(plan.Policy) != task.PolicyHash || s.llmConfigHash(plan.Provider) != task.ConfigHash {
		return s.failLLMTask(ctx, job, task, "invalid", "translation_input_changed")
	}
	if task.Execution.Started {
		plan.Text, plan.CachedTags, plan.SendingTagIDs = task.Execution.Text, task.Execution.CachedTags, task.Execution.SendingTagIDs
	} else {
		task.Execution = llmExecutionSnapshot{true, plan.Text, plan.CachedTags, plan.SendingTagIDs}
		if _, err := s.db.ExecContext(ctx, "UPDATE llm_translation_task SET execution_json=? WHERE id=?", mustJSON(task.Execution), task.ID); err != nil {
			return err
		}
	}

	select {
	case s.llmRequestSlots <- struct{}{}:
		defer func() { <-s.llmRequestSlots }()
	case <-ctx.Done():
		return ctx.Err()
	}
	// Each request is bounded by the provider's request timeout.
	client, closeClient, err := s.llmClient(ctx, plan.Provider, plan.Provider.RequestTimeout())
	if err != nil {
		return s.failLLMTask(ctx, job, task, "failed", "endpoint_unavailable")
	}
	defer closeClient()
	requests := llmPlanRequests(plan)
	for i := task.Index; i < len(requests); i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.validateLLMSend(ctx, task.UserID, task.WorkID, task.Payload, plan); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return s.failLLMTask(ctx, job, task, "invalid", "translation_boundary_changed")
		}
		currentActor, err := s.accountStore.LoadByID(ctx, task.UserID)
		if err != nil || !userHasPermission(currentActor, "metadata:sync") || !userHasPermission(currentActor, "library:write") || !userHasPermission(currentActor, "workflows:run") {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return s.failLLMTask(ctx, job, task, "invalid", "permission_changed")
		}
		currentProvider, err := s.llmProvider(ctx, task.Payload.ProviderID)
		if err != nil || s.llmConfigHash(currentProvider) != task.ConfigHash {
			return s.failLLMTask(ctx, job, task, "invalid", "provider_changed")
		}
		currentPolicy, err := s.llmStore.Policy(ctx)
		if err != nil || llmValueHash(currentPolicy) != task.PolicyHash {
			return s.failLLMTask(ctx, job, task, "invalid", "policy_changed")
		}
		// The run cancellation and outgoing-request marker commit together.
		result, err := s.db.ExecContext(ctx, `UPDATE llm_translation_task SET state='requesting',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state IN ('pending','failed') AND NOT EXISTS(SELECT 1 FROM workflow_run WHERE id=? AND status='cancelled')`, task.ID, job.RunID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return errors.New("translation task cannot send a request")
		}
		translated, requestErr := client.Translate(ctx, plan.Provider.DefaultModel, task.Payload.Target, requests[i])
		if requestErr != nil {
			state, code := "uncertain", "upstream_result_unknown"
			var rejected llm.UpstreamError
			if errors.As(requestErr, &rejected) && (rejected.Status == 400 || rejected.Status == 401 || rejected.Status == 403 || rejected.Status == 404 || rejected.Status == 422 || rejected.Status == 429) {
				state, code = "failed", "upstream_rejected"
			}
			return s.failLLMTask(ctx, job, task, state, code)
		}
		mergeLLMText(&task.Result, translated)
		if len(strings.Join(task.Result.Lyrics, "\n")) > llm.LyricsLimit {
			return s.failLLMTask(ctx, job, task, "uncertain", "translation_output_too_large")
		}
		if _, err := s.db.ExecContext(ctx, "UPDATE llm_translation_task SET state='pending',request_index=?,result_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='requesting'", i+1, mustJSON(task.Result), task.ID); err != nil {
			return s.failLLMTask(ctx, job, task, "uncertain", "result_persistence_failed")
		}
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "translating", map[string]any{"work_id": task.WorkID, "target_language": task.Payload.Target}, i+1, len(requests)); err != nil {
			return err
		}
	}
	completed := completeLLMTags(plan, task.Result)
	if err := s.saveLLMTagCandidates(ctx, task.UserID, task.Payload.Target, plan, completed); err != nil {
		return err
	}
	var token [16]byte
	if plan.Lyrics != nil {
		if _, err := plan.Lyrics.Document.Render(task.Result.Lyrics); err != nil {
			return s.failLLMTask(ctx, job, task, "uncertain", "invalid_lyrics_output")
		}
	}
	if _, err := rand.Read(token[:]); err != nil {
		return err
	}
	id := hex.EncodeToString(token[:])
	preview := llmPreview{Source: plan.Source, WorkID: task.WorkID, UserID: task.UserID, Expires: time.Now().Add(24 * time.Hour), Hash: llmInputHash(plan.Input), PolicyHash: task.PolicyHash, ConfigHash: task.ConfigHash, Input: plan.Input, Fields: plan.Fields, Result: completed, Provider: plan.Provider, Target: task.Payload.Target, TagIDs: plan.TagIDs, Lyrics: plan.Lyrics, Payload: task.Payload, Assessment: plan.Assessment}
	if err := s.saveLLMPreview(ctx, id, preview); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, "UPDATE llm_translation_task SET state='ready',preview_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND NOT EXISTS(SELECT 1 FROM workflow_run WHERE id=? AND status='cancelled')", id, task.ID, job.RunID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		_, _ = s.db.ExecContext(context.WithoutCancel(ctx), "UPDATE llm_translation_preview SET status='rejected' WHERE id=?", id)
		return errors.New("translation run was cancelled")
	}
	return s.finishLLMTranslationJob(ctx, job, id)
}

func (s *Server) resubmitUncertainLLMRun(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermissions(w, r, "library:write", "metadata:sync", "workflows:run")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	runID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_run_id", "Invalid workflow run.", false)
		return
	}
	var payload struct {
		Acknowledge bool `json:"acknowledgeUncertain"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&payload) != nil || !payload.Acknowledge {
		writeAPIError(w, 400, "llm_acknowledgement_required", "Explicitly acknowledge that resending an uncertain request can incur another charge.", false)
		return
	}
	var taskID int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT id FROM llm_translation_task WHERE workflow_run_id=? AND user_id=? AND state='uncertain'", runID, actor.ID).Scan(&taskID); err != nil {
		writeAPIError(w, 409, "llm_retry_unavailable", "Only the owner can explicitly resubmit an uncertain translation.", false)
		return
	}
	task, err := s.loadLLMTask(r.Context(), taskID)
	if err != nil {
		writeError(w, err)
		return
	}
	plan, err := s.prepareLLMTranslation(r.Context(), task.WorkID, task.Payload)
	if err != nil {
		writeLLMRequestError(w, err)
		return
	}
	if llmPlanHash(plan) != task.InputHash || s.llmConfigHash(plan.Provider) != task.ConfigHash || llmValueHash(plan.Policy) != task.PolicyHash {
		writeAPIError(w, 409, "llm_config_changed", "The original endpoint, policy or content changed. Resubmission is unavailable.", false)
		return
	}
	// The generic retry path still refuses uncertain tasks. This endpoint is
	// the explicit acknowledgement boundary for a possibly billed request.

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	var job workflowJobRecord
	if err := tx.QueryRowContext(r.Context(), "SELECT id,workflow_run_id,COALESCE(workflow_node_run_id,0),retry_count FROM workflow_job WHERE workflow_run_id=? AND worker_type='llm_translation' AND status IN ('failed','cancelled')", runID).Scan(&job.ID, &job.RunID, &job.NodeRunID, &job.RetryCount); err != nil {
		writeAPIError(w, 409, "llm_retry_unavailable", "The translation job cannot be resubmitted.", false)
		return
	}
	job.WorkerType = "llm_translation"
	if _, err := tx.ExecContext(r.Context(), "UPDATE workflow_job SET status='failed' WHERE id=? AND status='cancelled'", job.ID); err != nil {
		writeError(w, err)
		return
	}
	result, err := tx.ExecContext(r.Context(), "UPDATE llm_translation_task SET state='pending',failure_code='',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='uncertain'", taskID)
	if err != nil {
		writeError(w, err)
		return
	}
	count, err := result.RowsAffected()
	if err != nil || count != 1 {
		writeAPIError(w, 409, "llm_retry_unavailable", "The translation task changed.", false)
		return
	}
	if err := requeueWorkflowJobTx(r.Context(), tx, job, time.Now().UTC().Format("2006-01-02 15:04:05"), "Explicitly resubmit uncertain translation; another charge may occur", true); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, 202, map[string]any{"runId": runID, "status": "queued"})
}
func (s *Server) finishLLMTranslationJob(ctx context.Context, job workflowJobRecord, id string) error {
	summary := map[string]any{"status": "ready_for_review", "preview_id": id}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, "UPDATE workflow_job SET status='succeeded',locked_by='',locked_at=NULL,heartbeat_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", job.ID)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return errors.New("translation job has already settled")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status='succeeded',output_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?", mustJSON(summary), job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status='succeeded',summary_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", mustJSON(summary), job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{NodeRunID: job.NodeRunID, JobID: job.ID, Level: "info", Type: "llm.ready_for_review", Message: "Translation is ready for user review", Detail: summary}); err != nil {
		return err
	}
	return tx.Commit()
}
func llmPlanRequests(plan llmTranslationPlan) []llm.Text {
	requests := []llm.Text{}
	if plan.Text.Title != "" || plan.Text.Description != "" || len(plan.Text.Tags) > 0 {
		requests = append(requests, llm.Text{Title: plan.Text.Title, Description: plan.Text.Description, Tags: plan.Text.Tags})
	}
	for start := 0; start < len(plan.Text.Lyrics); start += llm.LyricsChunkLines {
		requests = append(requests, llm.Text{Lyrics: plan.Text.Lyrics[start:min(start+llm.LyricsChunkLines, len(plan.Text.Lyrics))]})
	}
	return requests
}
func llmPlanHash(plan llmTranslationPlan) string {
	fields := append([]string{}, plan.Fields...)
	sort.Strings(fields)
	return llmValueHash(struct {
		Input   llmWorkInput
		Fields  []string
		TagIDs  []int64
		Sending llm.Text
	}{plan.Input, fields, plan.TagIDs, plan.Source})
}
func mergeLLMText(result *llm.Text, value llm.Text) {
	if value.Title != "" {
		result.Title = value.Title
	}
	if value.Description != "" {
		result.Description = value.Description
	}
	result.Tags = append(result.Tags, value.Tags...)
	result.Lyrics = append(result.Lyrics, value.Lyrics...)
}

// Retry resets only definitive upstream rejections or pre-request failures.
// An uncertain request remains inspectable and cannot be sent automatically.
func (s *Server) retryLLMTranslationRun(ctx context.Context, actor currentUser, runID int64) (workflowRetryDispatchResult, error) {
	if !userHasPermission(actor, "library:write") || !userHasPermission(actor, "metadata:sync") {
		return workflowRetryDispatchResult{}, errWorkflowRetryPermission
	}
	var state string
	if err := s.db.QueryRowContext(ctx, "SELECT state FROM llm_translation_task WHERE workflow_run_id=?", runID).Scan(&state); err != nil {
		return workflowRetryDispatchResult{}, err
	}
	if state == "requesting" || state == "uncertain" || state == "invalid" || state == "cancelled" {
		return workflowRetryDispatchResult{}, errors.New("translation cannot be retried: review its fixed failure state")
	}
	if err := s.retryFailedWorkflowJobFor(ctx, &actor, runID); err != nil {
		return workflowRetryDispatchResult{}, err
	}
	return workflowRetryDispatchResult{NewRunID: runID, ResumedExistingRun: true}, nil
}
