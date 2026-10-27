package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikotohelper"
	"github.com/yexca/kikoto/backend/internal/llm"
)

// A helper rejection that retrying cannot fix names its cause, both for an
// interactive translation and for a queued one.
func TestKikotoHelperRejectionsNameTheirCause(t *testing.T) {
	var answer atomic.Value
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != kikotohelper.TranslatePath || r.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		switch answer.Load() {
		case "pair":
			w.WriteHeader(http.StatusUnprocessableEntity)
			_, _ = w.Write([]byte(`{"error":{"message":"unsupported","type":"unsupported_language_pair","code":"unsupported_language_pair"}}`))
		case "not_installed":
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"message":"not installed","type":"not_installed","code":"not_installed"}}`))
		case "out_of_memory":
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"message":"could not start","type":"start_failed","code":"start_failed","reason":"out_of_memory"}}`))
		case "agreement":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"error":{"message":"accept the notice","type":"abliterated_agreement_required","code":"abliterated_agreement_required"}}`))
		default:
			_, _ = w.Write([]byte(`{"text":{"title":"Example translation"},"model":"example-helper-model"}`))
		}
	}))
	defer upstream.Close()
	f := newManualOverrideFixture(t, config.Config{})
	_, _ = f.db.Exec("UPDATE user_account SET role='admin' WHERE id=?", f.userID)
	_, _ = f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID)
	key := "synthetic-token"
	p, err := f.server.llmStore.Mutate(context.Background(), "", llm.Provider{PresetID: kikotohelper.Kind, Scope: llm.ScopeOtherMachine, BaseURL: upstream.URL, Enabled: true, EnabledModels: []string{"example-helper-model"}}, &key, false)
	if err != nil {
		t.Fatal(err)
	}

	answer.Store("ok")
	if w := llmTestTranslate(t, f, p); w.Code != http.StatusOK {
		t.Fatalf("translate: %d %s", w.Code, w.Body.String())
	}
	answer.Store("pair")
	w := llmTestTranslate(t, f, p)
	var failure struct {
		Code string `json:"code"`
	}
	if w.Code != http.StatusUnprocessableEntity || json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Code != "llm_unsupported_language_pair" {
		t.Fatalf("unsupported pair: %d %s", w.Code, w.Body.String())
	}

	// A model that ran out of memory while loading is not a missing model.
	answer.Store("out_of_memory")
	if w := llmTestTranslate(t, f, p); w.Code != http.StatusUnprocessableEntity || json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Code != "llm_service_out_of_memory" {
		t.Fatalf("out of memory: %d %s", w.Code, w.Body.String())
	}

	// A model whose risk notice is not accepted in the helper says so.
	answer.Store("agreement")
	if w := llmTestTranslate(t, f, p); w.Code != http.StatusUnprocessableEntity || json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Code != "llm_service_agreement_required" {
		t.Fatalf("agreement required: %d %s", w.Code, w.Body.String())
	}

	// A queued translation names the cause, and a start failure stays
	// retryable once memory is freed.
	ctx := context.Background()
	answer.Store("not_installed")
	runs, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}})
	if err != nil {
		t.Fatal(err)
	}
	actor, _ := f.server.accountStore.LoadByID(ctx, f.userID)
	for i, want := range []struct{ answer, code string }{{"not_installed", "service_not_ready"}, {"out_of_memory", "service_out_of_memory"}, {"agreement", "service_agreement_required"}} {
		answer.Store(want.answer)
		if i > 0 {
			if _, err := f.server.retryLLMTranslationRun(ctx, actor, runs[0].RunID); err != nil {
				t.Fatal(err)
			}
		}
		_ = f.server.runNextQueuedWorkflowJob(ctx)
		var state, code string
		_ = f.db.QueryRow("SELECT state,COALESCE(failure_code,'') FROM llm_translation_task WHERE workflow_run_id=?", runs[0].RunID).Scan(&state, &code)
		if state != "failed" || code != want.code {
			t.Fatalf("%s: queued translation state=%s code=%s", want.answer, state, code)
		}
	}
}

// A direction the helper's model does not declare is refused before a task is
// queued or the helper receives a request, and the translation choices name
// the model's targets.
func TestKikotoHelperDeclaredPairsLimitTranslationTargets(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"text":{"title":"Example translation"},"model":"example-helper-model"}`))
	}))
	defer upstream.Close()
	f := newManualOverrideFixture(t, config.Config{})
	_, _ = f.db.Exec("UPDATE user_account SET role='admin' WHERE id=?", f.userID)
	_, _ = f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID)
	ctx := context.Background()
	key := "synthetic-token"
	p, err := f.server.llmStore.Mutate(ctx, "", llm.Provider{PresetID: kikotohelper.Kind, Scope: llm.ScopeOtherMachine, BaseURL: upstream.URL, Enabled: true, EnabledModels: []string{"example-helper-model"}}, &key, false)
	if err != nil {
		t.Fatal(err)
	}
	if p, err = f.server.llmStore.Models(ctx, p, []llm.Model{{ID: "example-helper-model", Pairs: []llm.LanguagePair{{Source: "ja-jp", Target: "zh-cn"}}}}); err != nil {
		t.Fatal(err)
	}

	r := llmTestRequest(f, "GET", "")
	r.URL.RawQuery = "workId=" + jsonNumber(f.workID)
	w := httptest.NewRecorder()
	f.server.listLLMTranslationModels(w, r)
	var choices []struct {
		ModelTargets map[string][]string           `json:"modelTargets"`
		ModelPairs   map[string][]llm.LanguagePair `json:"modelPairs"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &choices) != nil || len(choices) != 1 || len(choices[0].ModelTargets["example-helper-model"]) != 1 || choices[0].ModelTargets["example-helper-model"][0] != "zh-cn" ||
		len(choices[0].ModelPairs["example-helper-model"]) != 1 || choices[0].ModelPairs["example-helper-model"][0] != (llm.LanguagePair{Source: "ja-jp", Target: "zh-cn"}) {
		t.Fatalf("translation models: %d %s", w.Code, w.Body.String())
	}

	_, err = f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, llmTranslatePayload{ProviderID: p.ID, Target: "en-us", Fields: []string{"title"}})
	var refused llmRequestError
	var runs int
	_ = f.db.QueryRow("SELECT COUNT(*) FROM workflow_run").Scan(&runs)
	if !errors.As(err, &refused) || refused.Code != "llm_unsupported_language_pair" || runs != 0 || requests.Load() != 0 {
		t.Fatalf("unsupported direction: err=%v runs=%d requests=%d", err, runs, requests.Load())
	}

	// A model that changes its pairs while a translation waits stops the task
	// without a request.
	queued, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.server.llmStore.Models(ctx, p, []llm.Model{{ID: "example-helper-model", Pairs: []llm.LanguagePair{{Source: "ja-jp", Target: "ko-kr"}}}}); err != nil {
		t.Fatal(err)
	}
	_ = f.server.runNextQueuedWorkflowJob(ctx)
	var state, code string
	_ = f.db.QueryRow("SELECT state,COALESCE(failure_code,'') FROM llm_translation_task WHERE workflow_run_id=?", queued[0].RunID).Scan(&state, &code)
	if state != "invalid" || code != "unsupported_language_pair" || requests.Load() != 0 {
		t.Fatalf("queued translation state=%s code=%s requests=%d", state, code, requests.Load())
	}
}
