package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

func TestLLMTextPolicyScopesPrecheckSendAndAcceptanceWithoutChangingASR(t *testing.T) {
	for _, age := range []string{"r15", "adult", ""} {
		t.Run(age, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			acceptServiceNoticeForTest(t, f)
			if _, err := f.db.Exec("UPDATE work SET age_rating=?,description='synthetic marker' WHERE id=?", age, f.workID); err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
			}))
			defer upstream.Close()
			provider := llmTestProvider(t, f, upstream.URL, "external", "safe")
			policy := llm.Policy{Keywords: []llm.KeywordRule{{ID: "description-block", Term: "synthetic marker", Fields: []string{"description"}, Action: "blocked"}}}
			if err := f.server.llmStore.SavePolicy(context.Background(), policy); err != nil {
				t.Fatal(err)
			}
			if w := llmTestTranslate(t, f, provider); w.Code != 422 || requests.Load() != 0 {
				t.Fatalf("default mode sent blocked metadata: %d %s", w.Code, w.Body.String())
			}
			policy.LLMTranslationTextOnly = true
			body, _ := json.Marshal(policy)
			w := httptest.NewRecorder()
			f.server.updateLLMPolicy(w, llmTestRequest(f, http.MethodPut, string(body)))
			if w.Code != http.StatusOK {
				t.Fatal(w.Body.String())
			}
			saved, err := f.server.llmStore.Policy(context.Background())
			if err != nil || !saved.LLMTranslationTextOnly {
				t.Fatalf("text mode not persisted: %+v %v", saved, err)
			}
			for _, fields := range [][]string{{"title"}, {"description"}} {
				payload := llmTranslatePayload{ProviderID: provider.ID, Target: "ja-jp", Fields: fields}
				body, _ := json.Marshal(payload)
				w := httptest.NewRecorder()
				f.server.precheckLLMWork(w, llmTestRequest(f, http.MethodPost, string(body)))
				var result struct {
					Assessment    llm.Assessment `json:"assessment"`
					CheckedFields []string       `json:"checkedFields"`
					SentFields    []string       `json:"sentFields"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 {
					t.Fatalf("precheck: %d %s %v", w.Code, w.Body.String(), err)
				}
				want := "safe"
				if fields[0] == "description" {
					want = "blocked"
				}
				if result.Assessment.Class != want || result.Assessment.Mode != "translation_text" || len(result.CheckedFields) != 1 || result.CheckedFields[0] != fields[0] || len(result.SentFields) != 0 || requests.Load() != 0 {
					t.Fatalf("precheck scope: %+v, requests=%d", result, requests.Load())
				}
				if want == "blocked" {
					w = httptest.NewRecorder()
					f.server.translateWorkWithLLM(w, llmTestRequest(f, http.MethodPost, string(body)))
					if w.Code != 422 || requests.Load() != 0 {
						t.Fatalf("blocked selected field sent: %d %s", w.Code, w.Body.String())
					}
				}
			}
			allowed, err := f.server.asrAllowed(context.Background(), f.workID, asr.Provider{MaxContentClass: "restricted"})
			if err != nil || allowed {
				t.Fatalf("ASR ignored metadata: allowed=%v err=%v", allowed, err)
			}
			w = llmTestTranslate(t, f, provider)
			var preview struct {
				ID string `json:"previewId"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil || w.Code != 200 || requests.Load() != 1 {
				t.Fatalf("translate: %d %s %v, requests=%d", w.Code, w.Body.String(), err, requests.Load())
			}
			w = httptest.NewRecorder()
			f.server.applyLLMTranslation(w, llmTestRequest(f, http.MethodPut, `{"previewId":"`+preview.ID+`"}`))
			if w.Code != 200 {
				t.Fatalf("accept: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
