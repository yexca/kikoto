package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

func TestAIPolicyRequiresExplicitRules(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	acceptServiceNoticeForTest(t, f)
	for _, body := range []string{
		`{"tagIds":[1],"keywords":[]}`,
		`{"tagRules":[],"keywords":[{"term":"synthetic marker","fields":["all"],"action":"blocked"}]}`,
	} {
		w := httptest.NewRecorder()
		f.server.updateLLMPolicy(w, llmTestRequest(f, http.MethodPut, body))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid policy accepted: %d %s", w.Code, w.Body.String())
		}
		if _, err := f.db.Exec("INSERT INTO app_setting(key,value_json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json", llm.PolicyKey, body); err != nil {
			t.Fatal(err)
		}
		if _, err := f.server.llmStore.Policy(context.Background()); err == nil {
			t.Fatal("unsupported stored rules were silently discarded")
		}
	}
}

func TestASRRechecksSendBoundaryAfterDecoding(t *testing.T) {
	for _, scenario := range []string{"disabled", "maximum", "model", "policy", "permission", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			f := newASRFixture(t, 2)
			response, id, runID := f.create(t, "ja-jp")
			if response.Code != http.StatusAccepted {
				t.Fatal(response.Body.String())
			}
			ctx := context.Background()
			job, ok, err := f.server.claimNextQueuedWorkflowJob(ctx, "asr-boundary-test")
			if err != nil || !ok || job.RunID != runID {
				t.Fatalf("claim: %+v %v %v", job, ok, err)
			}
			decoded := false
			err = f.server.executeASRTranscriptionWithDecoder(ctx, job, func(context.Context, string, string, int64, int) ([]byte, error) {
				decoded = true
				switch scenario {
				case "disabled", "maximum", "model":
					p := f.provider
					switch scenario {
					case "disabled":
						p.Enabled = false
					case "maximum":
						p.MaxContentClass = "restricted"
					case "model":
						p.EnabledModels = []string{"other-model"}
					}
					if _, err := f.server.asrStore.Mutate(ctx, p.ID, p, nil, false); err != nil {
						t.Fatal(err)
					}
				case "policy":
					if _, err := f.db.Exec("UPDATE work SET age_rating='adult' WHERE id=?", f.workID); err != nil {
						t.Fatal(err)
					}
				case "permission":
					if _, err := f.db.Exec("UPDATE user_account SET role='user' WHERE id=?", f.userID); err != nil {
						t.Fatal(err)
					}
				case "cancelled":
					w := httptest.NewRecorder()
					f.server.cancelWorkflowRun(w, f.request(t, http.MethodPost, "/", "", map[string]string{"id": jsonNumber(runID)}))
					if w.Code != http.StatusOK {
						t.Fatal(w.Body.String())
					}
				}
				return make([]byte, asr.BytesPerSecond), nil
			})
			if !decoded || err == nil || f.requests.Load() != 0 {
				t.Fatalf("decoded=%t requests=%d err=%v", decoded, f.requests.Load(), err)
			}
			state, failure, offset := f.state(t, id)
			want := "failed/provider_changed"
			switch scenario {
			case "policy":
				want = "failed/policy_blocked"
			case "permission":
				want = "failed/permission_changed"
			case "cancelled":
				want = "cancelled/cancelled"
			}
			if state+"/"+failure != want || offset != 0 {
				t.Fatalf("state=%s/%s offset=%d want=%s", state, failure, offset, want)
			}
		})
	}
}

func TestLLMCompletedPreviewDoesNotPermanentlyDeduplicate(t *testing.T) {
	for _, status := range []string{"proposed", "expired", "rejected", "accepted", "elapsed"} {
		t.Run(status, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			if _, err := f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID); err != nil {
				t.Fatal(err)
			}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
			}))
			defer upstream.Close()
			p := llmTestProvider(t, f, upstream.URL, "external", "safe")
			payload := llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}}
			ctx := context.Background()
			runs, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, payload)
			if err != nil {
				t.Fatal(err)
			}
			if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			if status == "elapsed" {
				_, err = f.db.Exec("UPDATE llm_translation_preview SET expires_at=0")
			} else {
				_, err = f.db.Exec("UPDATE llm_translation_preview SET status=?", status)
			}
			if err != nil {
				t.Fatal(err)
			}
			repeat, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, payload)
			if err != nil {
				t.Fatal(err)
			}
			reuse := status == "proposed"
			if repeat[0].Deduplicated != reuse || (repeat[0].RunID == runs[0].RunID) != reuse {
				t.Fatalf("repeat=%+v original=%+v", repeat, runs)
			}
			if reuse {
				return
			}
			// Retiring the key keeps the completed result and its Activity run.
			var oldKey string
			if err := f.db.QueryRow("SELECT dedup_key FROM llm_translation_task WHERE workflow_run_id=? AND state='ready'", runs[0].RunID).Scan(&oldKey); err != nil || !strings.Contains(oldKey, ":completed:") {
				t.Fatalf("old task lost: %q %v", oldKey, err)
			}
			if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			joined, err := f.server.enqueueLLMTranslations(ctx, f.userID, []int64{f.workID}, payload)
			if err != nil || !joined[0].Deduplicated || joined[0].RunID != repeat[0].RunID {
				t.Fatalf("new result not reusable: %+v %v", joined, err)
			}
		})
	}
}
