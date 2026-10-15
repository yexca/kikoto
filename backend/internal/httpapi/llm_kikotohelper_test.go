package httpapi

import (
	"context"
	"encoding/json"
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

	answer.Store("not_installed")
	ctx := context.Background()
	runs, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}})
	if err != nil {
		t.Fatal(err)
	}
	_ = f.server.runNextQueuedWorkflowJob(ctx)
	var state, code string
	_ = f.db.QueryRow("SELECT state,COALESCE(failure_code,'') FROM llm_translation_task WHERE workflow_run_id=?", runs[0].RunID).Scan(&state, &code)
	if state != "failed" || code != "service_not_ready" {
		t.Fatalf("queued translation state=%s code=%s", state, code)
	}
}
