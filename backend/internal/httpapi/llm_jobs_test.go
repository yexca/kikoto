package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// An LLM translation run queued before Translate with AI replaced it ends
// without a request or a preview, and Activity cannot retry it.
func TestLLMTranslationRunQueuedBeforeTranslateWithAIStopsWithoutARequest(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
	}))
	defer upstream.Close()
	f := newManualOverrideFixture(t, config.Config{})
	if _, err := f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID); err != nil {
		t.Fatal(err)
	}
	p := llmTestProvider(t, f, upstream.URL, "external", "safe")
	ctx := context.Background()
	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "llm_translation", "LLM translation", "Translate explicitly selected work content for user review.", map[string]any{"nodes": []map[string]string{{"id": "translate", "type": "llm_translation"}}})
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]any{workflowRunRequesterKey: f.userID, "work_id": f.workID, "target_language": "zh-cn", "fields": []string{"title"}}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "llm_translation", "LLM translation", "queued", "manual", "selected_work_translation", input, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	task, err := tx.ExecContext(ctx, `INSERT INTO llm_translation_task(workflow_run_id,user_id,work_id,dedup_key,input_hash,policy_hash,config_hash,request_json) VALUES(?,?,?,'example-key','','','',?)`,
		runID, f.userID, f.workID, mustJSON(llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}}))
	if err != nil {
		t.Fatal(err)
	}
	taskID, _ := task.LastInsertId()
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "translate", NodeType: "llm_translation", DisplayName: "Translate for review", Position: 1, Status: "queued", Input: input})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: "llm_translation", Status: "queued", ResourceKey: "llm:translation",
		Payload: map[string]any{"task_id": taskID, "requested_by_user_id": f.userID}, Recoverable: true, MaxRetries: 3}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	if err := f.server.runNextQueuedWorkflowJob(ctx); err == nil {
		t.Fatal("the LLM translation job succeeded")
	}
	var state, code, runStatus string
	var previews int
	if err := f.db.QueryRow(`SELECT task.state, task.failure_code, run.status, (SELECT COUNT(*) FROM llm_translation_preview)
		FROM llm_translation_task AS task INNER JOIN workflow_run AS run ON run.id = task.workflow_run_id WHERE task.id = ?`, taskID).Scan(&state, &code, &runStatus, &previews); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 0 || state != "invalid" || code != llmTranslationReplaced || runStatus != "failed" || previews != 0 {
		t.Fatalf("requests=%d task=%s/%s run=%s previews=%d", requests.Load(), state, code, runStatus, previews)
	}
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.retryLLMTranslationRun(ctx, actor, runID); !errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		t.Fatalf("retry = %v", err)
	}
}
