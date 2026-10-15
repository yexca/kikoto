package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// llmModelRecorder answers every translation and records the requested model.
func llmModelRecorder(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	models := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		models = append(models, body.Model)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
	}))
	t.Cleanup(upstream.Close)
	return upstream, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string{}, models...)
	}
}

func TestLLMTranslationSendsTheChosenEnabledModel(t *testing.T) {
	upstream, sent := llmModelRecorder(t)
	f := newManualOverrideFixture(t, config.Config{})
	_, _ = f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID)
	p := llmTestProvider(t, f, upstream.URL, "external", "safe")
	p.EnabledModels = []string{"example-model", "second-model"}
	p, err := f.server.llmStore.Mutate(context.Background(), p.ID, p, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	translate := func(model string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(llmTranslatePayload{ProviderID: p.ID, Model: model, Target: "zh-cn", Fields: []string{"title"}})
		w := httptest.NewRecorder()
		f.server.translateWorkWithLLM(w, llmTestRequest(f, "POST", string(body)))
		return w
	}
	if w := translate("unlisted-model"); w.Code != 422 {
		t.Fatalf("unlisted model: %d %s", w.Code, w.Body.String())
	}
	w := translate("second-model")
	var result struct {
		ID    string `json:"previewId"`
		Model string `json:"model"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.Model != "second-model" {
		t.Fatalf("translate: %d %s", w.Code, w.Body.String())
	}
	apply := httptest.NewRecorder()
	f.server.applyLLMTranslation(apply, llmTestRequest(f, "PUT", `{"previewId":"`+result.ID+`"}`))
	if apply.Code != 200 {
		t.Fatal(apply.Body.String())
	}
	var stored string
	if err := f.db.QueryRow("SELECT model FROM work_llm_translation WHERE work_id=?", f.workID).Scan(&stored); err != nil || stored != "second-model" {
		t.Fatalf("stored model=%q err=%v", stored, err)
	}
	if w := translate(""); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if got := sent(); len(got) != 2 || got[0] != "second-model" || got[1] != "example-model" {
		t.Fatalf("sent models=%v", got)
	}
}

func TestLLMQueuedTranslationKeepsItsModel(t *testing.T) {
	for _, change := range []string{"default_changed", "model_disabled"} {
		t.Run(change, func(t *testing.T) {
			upstream, sent := llmModelRecorder(t)
			f := newManualOverrideFixture(t, config.Config{})
			_, _ = f.db.Exec("UPDATE user_account SET role='admin' WHERE id=?", f.userID)
			_, _ = f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID)
			p := llmTestProvider(t, f, upstream.URL, "external", "safe")
			ctx := context.Background()
			runs, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}})
			if err != nil {
				t.Fatal(err)
			}
			p.EnabledModels, p.DefaultModel = []string{"example-model", "second-model"}, "second-model"
			if change == "model_disabled" {
				p.EnabledModels = []string{"second-model"}
			}
			if _, err := f.server.llmStore.Mutate(ctx, p.ID, p, nil, false); err != nil {
				t.Fatal(err)
			}
			err = f.server.runNextQueuedWorkflowJob(ctx)
			var state, code string
			_ = f.db.QueryRow("SELECT state,COALESCE(failure_code,'') FROM llm_translation_task WHERE workflow_run_id=?", runs[0].RunID).Scan(&state, &code)
			if change == "default_changed" {
				if err != nil || state != "ready" {
					t.Fatalf("err=%v state=%s code=%s", err, state, code)
				}
				if got := sent(); len(got) != 1 || got[0] != "example-model" {
					t.Fatalf("sent models=%v", got)
				}
				return
			}
			if state != "invalid" || code != "provider_changed" || len(sent()) != 0 {
				t.Fatalf("state=%s code=%s sent=%v", state, code, sent())
			}
		})
	}
}
