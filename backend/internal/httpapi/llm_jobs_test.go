package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLLMJobsDeduplicateResumeAndRefuseUncertainRetry(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
	}))
	defer upstream.Close()
	for _, scenario := range []string{"success", "restart_before_send", "restart_after_send", "source_changed", "maximum_changed", "permission_changed", "cancelled", "safe_retry"} {
		t.Run(scenario, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			_, _ = f.db.Exec("UPDATE user_account SET role='admin' WHERE id=?", f.userID)
			_, _ = f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID)
			p := llmTestProvider(t, f, upstream.URL, "external", "safe")
			payload := llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}}
			ctx := context.Background()
			runs, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, payload)
			if err != nil {
				t.Fatal(err)
			}
			repeated, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, payload)
			if err != nil || !repeated[0].Deduplicated || repeated[0].RunID != runs[0].RunID {
				t.Fatalf("dedup=%+v err=%v", repeated, err)
			}
			runID := runs[0].RunID
			before := requests.Load()
			switch scenario {
			case "restart_before_send", "restart_after_send":
				_, _ = f.db.Exec("UPDATE workflow_job SET status='running',locked_by='old-runner' WHERE workflow_run_id=?", runID)
				_, _ = f.db.Exec("UPDATE workflow_run SET status='running' WHERE id=?", runID)
				if scenario == "restart_after_send" {
					_, _ = f.db.Exec("UPDATE llm_translation_task SET state='requesting' WHERE workflow_run_id=?", runID)
				}
				f.server = NewServer(f.db, config.Config{})
				if err := f.server.RecoverInterruptedWorkflows(ctx); err != nil {
					t.Fatal(err)
				}
			case "maximum_changed":
				p.MaxContentClass = "restricted"
				if _, err := f.server.llmStore.Mutate(ctx, p.ID, p, nil, false); err != nil {
					t.Fatal(err)
				}
			case "source_changed":
				_, _ = f.db.Exec("UPDATE work SET title='Changed source' WHERE id=?", f.workID)
			case "permission_changed":
				_, _ = f.db.Exec("UPDATE user_account SET role='user' WHERE id=?", f.userID)
			case "cancelled":
				r := llmTestRequest(f, "POST", "")
				r.SetPathValue("id", jsonNumber(runID))
				actor, _ := f.server.accountStore.LoadByID(ctx, f.userID)
				r = r.WithContext(context.WithValue(ctx, currentUserKey, actor))
				w := httptest.NewRecorder()
				f.server.cancelWorkflowRun(w, r)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			case "safe_retry":
				_, _ = f.db.Exec("UPDATE workflow_job SET status='failed' WHERE workflow_run_id=?", runID)
				_, _ = f.db.Exec("UPDATE workflow_run SET status='failed' WHERE id=?", runID)
				_, _ = f.db.Exec("UPDATE llm_translation_task SET state='failed',failure_code='upstream_rejected' WHERE workflow_run_id=?", runID)
				actor, _ := f.server.accountStore.LoadByID(ctx, f.userID)
				if _, err := f.server.retryLLMTranslationRun(ctx, actor, runID); err != nil {
					t.Fatal(err)
				}
			}
			err = f.server.runNextQueuedWorkflowJob(ctx)
			good := scenario == "success" || scenario == "restart_before_send" || scenario == "safe_retry"
			if good && err != nil {
				t.Fatal(err)
			}
			want := int32(0)
			if good {
				want = 1
			}
			if requests.Load()-before != want {
				t.Fatalf("requests=%d want=%d", requests.Load()-before, want)
			}
			if scenario == "restart_after_send" {
				actor, _ := f.server.accountStore.LoadByID(ctx, f.userID)
				if _, err := f.server.retryLLMTranslationRun(ctx, actor, runID); err == nil {
					t.Fatal("uncertain request can be retried")
				}
			}
			if good {
				var state, preview string
				var accepted int
				if err := f.db.QueryRow("SELECT state,preview_id FROM llm_translation_task WHERE workflow_run_id=?", runID).Scan(&state, &preview); err != nil {
					t.Fatal(err)
				}
				_ = f.db.QueryRow("SELECT COUNT(*) FROM work_llm_translation").Scan(&accepted)
				if state != "ready" || preview == "" || accepted != 0 {
					t.Fatalf("review state %q preview %q accepted %d", state, preview, accepted)
				}
			}
		})
	}
}

func TestLLMJobsOnlyTranslateExplicitExistingWorks(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	_, _ = f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID)
	p := llmTestProvider(t, f, "https://example.invalid", "external", "safe")
	_, err := f.server.enqueueLLMTranslations(context.Background(), f.userID, []int64{f.workID, 999}, llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}})
	if err == nil {
		t.Fatal("unknown work was queued")
	}
	var count int
	_ = f.db.QueryRow("SELECT COUNT(*) FROM workflow_run").Scan(&count)
	if count != 0 {
		t.Fatalf("partially queued invalid batch: %d", count)
	}
	var invalid llmRequestError
	if !errors.As(llmInvalid("example", "Example"), &invalid) {
		t.Fatal("request error boundary")
	}
}
