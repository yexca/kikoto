package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// translationItemOutcome is the state and failure code of a run's only item.
func translationItemOutcome(t *testing.T, db *sqlutil.DB, runID int64) string {
	t.Helper()
	var state, code string
	if err := db.QueryRow("SELECT state, failure_code FROM translation_item WHERE workflow_run_id = ?", runID).Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	return state + "/" + code
}

// echoLLM answers every translation with its input and counts the requests.
// Before answering, it runs during, when set.
func echoLLM(t *testing.T, requests *atomic.Int32, during func()) *httptest.Server {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Messages) != 2 {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		if during != nil {
			during()
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": request.Messages[1].Content}}}})
	}))
	t.Cleanup(upstream.Close)
	return upstream
}

// The work's whole metadata, not only the chosen fields, is assessed against
// the provider's receive maximum, and a refusal sends nothing. ASR follows the
// same assessment.
func TestAITranslationPolicyAndReceiveMaximumGateEveryRequest(t *testing.T) {
	var requests atomic.Int32
	upstream := echoLLM(t, &requests, nil)
	keyword := func(field, action string) llm.Policy {
		return llm.Policy{Keywords: []llm.KeywordRule{{ID: "synthetic-rule", Term: "synthetic marker", Fields: []string{field}, Action: action}}}
	}
	for _, tc := range []struct {
		name, age, boundary, maximum string
		policy                       llm.Policy
		sent                         bool
	}{
		{"unknown age", "", "private", "sensitive", llm.DefaultPolicy(), false},
		{"unknown age substring", "not-adult-known", "private", "sensitive", llm.DefaultPolicy(), false},
		{"sensitive above external maximum", "adult", "external", "safe", llm.DefaultPolicy(), false},
		{"sensitive within external maximum", "adult", "external", "sensitive", llm.DefaultPolicy(), true},
		{"sensitive above private maximum", "adult", "private", "safe", llm.DefaultPolicy(), false},
		{"sensitive within private maximum", "adult", "private", "sensitive", llm.DefaultPolicy(), true},
		{"chosen field blocked", "general", "private", "sensitive", keyword("title", "blocked"), false},
		{"unchosen field blocked", "general", "private", "sensitive", keyword("description", "blocked"), false},
		{"restricted above maximum", "general", "external", "sensitive", keyword("description", "restricted"), false},
		{"restricted adult above maximum", "adult", "external", "sensitive", keyword("description", "restricted"), false},
		{"restricted within maximum", "adult", "external", "restricted", keyword("description", "restricted"), true},
		{"blocked within restricted maximum", "general", "external", "restricted", keyword("description", "blocked"), false},
		{"restricted unknown age", "", "external", "restricted", keyword("description", "restricted"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			disableAutoAccept(t, f.db)
			ctx := context.Background()
			if _, err := f.db.Exec("UPDATE work SET age_rating = ?, title = 'Example synthetic marker', description = 'synthetic marker' WHERE id = ?", tc.age, f.workID); err != nil {
				t.Fatal(err)
			}
			if err := f.server.llmStore.SavePolicy(ctx, tc.policy); err != nil {
				t.Fatal(err)
			}
			provider := llmTestProvider(t, f, upstream.URL, tc.boundary, tc.maximum)
			before := requests.Load()
			response, err := f.server.submitAITranslation(ctx, translationActor(t, f.server, f.userID), f.workID,
				aiTranslationRequest{Languages: []string{"zh-cn"}, Categories: []string{"title"}, ProviderID: provider.ID})
			if tc.sent {
				if err != nil {
					t.Fatal(err)
				}
				if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
					t.Fatal(err)
				}
				if outcome := translationItemOutcome(t, f.db, response.RunID); outcome != "ready/" {
					t.Fatalf("outcome = %s", outcome)
				}
			} else if code := requestErrorCode(t, err); code != "llm_policy_blocked" {
				t.Fatalf("refusal = %q", code)
			}
			if sent := requests.Load() - before; sent != map[bool]int32{false: 0, true: 1}[tc.sent] {
				t.Fatalf("requests = %d", sent)
			}
			allowed, err := f.server.asrAllowed(ctx, f.workID, asr.Provider{Boundary: tc.boundary, MaxContentClass: tc.maximum})
			if err != nil || allowed != tc.sent {
				t.Fatalf("ASR allowed = %v %v", allowed, err)
			}
		})
	}
}

// A queued item is sent only while its requester, source, policy and the
// provider settings it was planned with are unchanged. Offering another model
// and restarting the server leave it valid.
func TestAITranslationRechecksTheSendBoundaryBeforeItsRequest(t *testing.T) {
	var requests atomic.Int32
	upstream := echoLLM(t, &requests, nil)
	for _, tc := range []struct{ change, want string }{
		{"source", "invalid/source_changed"},
		{"age", "policy_blocked/policy_blocked"},
		{"policy", "invalid/policy_changed"},
		{"text_mode", "invalid/policy_changed"},
		{"connection", "invalid/provider_changed"},
		{"model", "invalid/provider_changed"},
		{"maximum", "invalid/provider_changed"},
		{"permission", "invalid/permission_changed"},
		{"other_model", "ready/"},
		{"restart", "ready/"},
	} {
		t.Run(tc.change, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			disableAutoAccept(t, f.db)
			ctx := context.Background()
			if _, err := f.db.Exec("UPDATE work SET age_rating = 'general' WHERE id = ?", f.workID); err != nil {
				t.Fatal(err)
			}
			provider := llmTestProvider(t, f, upstream.URL, "external", "sensitive")
			response, err := f.server.submitAITranslation(ctx, translationActor(t, f.server, f.userID), f.workID,
				aiTranslationRequest{Languages: []string{"zh-cn"}, Categories: []string{"title"}, ProviderID: provider.ID})
			if err != nil {
				t.Fatal(err)
			}
			mutate := func(change func(*llm.Provider)) {
				change(&provider)
				if _, err := f.server.llmStore.Mutate(ctx, provider.ID, provider, nil, false); err != nil {
					t.Fatal(err)
				}
			}
			statement := ""
			switch tc.change {
			case "source":
				statement = "UPDATE work SET title = 'Changed example title' WHERE id = ?"
			case "age":
				statement = "UPDATE work SET age_rating = '' WHERE id = ?"
			case "permission":
				statement = "UPDATE user_account SET role = 'user' WHERE id = ?"
			case "policy":
				err = f.server.llmStore.SavePolicy(ctx, llm.Policy{Keywords: []llm.KeywordRule{{ID: "synthetic-rule", Term: "unrelated phrase", Fields: []string{"title"}, Action: "restricted"}}})
			case "text_mode":
				err = f.server.llmStore.SavePolicy(ctx, llm.Policy{LLMTranslationTextOnly: true})
			case "connection":
				mutate(func(p *llm.Provider) { p.BaseURL = "https://moved.example.invalid" })
			case "model":
				mutate(func(p *llm.Provider) { p.EnabledModels = []string{"another-model"} })
			case "maximum":
				mutate(func(p *llm.Provider) { p.MaxContentClass = "safe" })
			case "other_model":
				mutate(func(p *llm.Provider) {
					p.EnabledModels, p.DefaultModel = []string{"example-model", "another-model"}, "another-model"
				})
			case "restart":
				f.server = NewServer(f.db, config.Config{})
			}
			if err != nil {
				t.Fatal(err)
			}
			if statement != "" {
				id := f.workID
				if tc.change == "permission" {
					id = f.userID
				}
				if _, err := f.db.Exec(statement, id); err != nil {
					t.Fatal(err)
				}
			}
			before := requests.Load()
			if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			if outcome := translationItemOutcome(t, f.db, response.RunID); outcome != tc.want {
				t.Fatalf("outcome = %s, want %s", outcome, tc.want)
			}
			if sent := requests.Load() - before; sent != map[bool]int32{false: 0, true: 1}[tc.want == "ready/"] {
				t.Fatalf("requests = %d", sent)
			}
		})
	}
}

// Lyrics are assessed as a whole file before the first chunk leaves, so a
// blocked phrase split across two chunks is found, and the send boundary is
// checked again before each later chunk.
func TestAITranslationLyricsChunksShareOneAssessmentAndRecheckEachSend(t *testing.T) {
	cues := make([]string, llm.LyricsChunkLines+1)
	for i := range cues {
		cues[i] = fmt.Sprintf("00:%02d:%02d.000 --> 00:%02d:%02d.500\nExample line", i/60, i%60, i/60, i%60)
	}
	for _, scenario := range []string{"success", "cross_chunk_block", "lowered_maximum"} {
		t.Run(scenario, func(t *testing.T) {
			fixture, _, _ := newTranslationFixture(t)
			disableAutoAccept(t, fixture.db)
			ctx := context.Background()
			lines := append([]string{}, cues...)
			if scenario == "cross_chunk_block" {
				lines[llm.LyricsChunkLines-1] = strings.Replace(lines[llm.LyricsChunkLines-1], "Example line", "synthetic", 1)
				lines[llm.LyricsChunkLines] = strings.Replace(lines[llm.LyricsChunkLines], "Example line", "marker", 1)
			}
			source := translationLyricsFileWith(t, fixture, "WEBVTT\n\n"+strings.Join(lines, "\n\n")+"\n")
			// Text-only mode keeps the work's description out of the lyrics'
			// assessment.
			if _, err := fixture.db.Exec("UPDATE work SET description = 'synthetic marker' WHERE id = ?", fixture.workID); err != nil {
				t.Fatal(err)
			}
			if err := fixture.server.llmStore.SavePolicy(ctx, llm.Policy{LLMTranslationTextOnly: true, Keywords: []llm.KeywordRule{
				{ID: "metadata-block", Term: "synthetic marker", Fields: []string{"description"}, Action: "blocked"},
				{ID: "lyrics-block", Term: "synthetic marker", Fields: []string{"lyrics"}, Action: "blocked"},
			}}); err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			var provider llm.Provider
			var lower sync.Once
			upstream := echoLLM(t, &requests, func() {
				if scenario == "lowered_maximum" {
					lower.Do(func() {
						provider.MaxContentClass = "safe"
						if _, err := fixture.server.llmStore.Mutate(context.Background(), provider.ID, provider, nil, false); err != nil {
							t.Error(err)
						}
					})
				}
			})
			provider, err := fixture.server.llmStore.Mutate(ctx, "", llm.Provider{PresetID: "custom-openai", BaseURL: upstream.URL, Boundary: "external", MaxContentClass: "sensitive", Enabled: true, EnabledModels: []string{"example-llm"}}, nil, false)
			if err != nil {
				t.Fatal(err)
			}
			response, err := fixture.server.submitAITranslation(ctx, translationActor(t, fixture.server, fixture.userID), fixture.workID, aiTranslationRequest{
				Languages: []string{"zh-cn"}, ProviderID: provider.ID,
				Lyrics: []aiLyricsTarget{{AudioMediaItemID: fixture.audioID, TargetLanguage: "zh-cn", LyricsLocationID: source}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			want := map[string]struct {
				outcome  string
				requests int32
			}{
				"success":           {"ready/", 2},
				"cross_chunk_block": {"policy_blocked/policy_blocked", 0},
				"lowered_maximum":   {"invalid/provider_changed", 1},
			}[scenario]
			if outcome := translationItemOutcome(t, fixture.db, response.RunID); outcome != want.outcome || requests.Load() != want.requests {
				t.Fatalf("outcome = %s, requests = %d, want %s and %d", outcome, requests.Load(), want.outcome, want.requests)
			}
		})
	}
}

// Text-only mode assesses only the text that is sent: a chosen field, never
// the age rating, an unchosen field or a tag's identity. ASR keeps assessing
// the work.
func TestAITranslationTextOnlyPolicyScopesTheSentTextWithoutChangingASR(t *testing.T) {
	for _, age := range []string{"r15", "adult", ""} {
		t.Run(age, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			acceptServiceNoticeForTest(t, f)
			disableAutoAccept(t, f.db)
			ctx := context.Background()
			if _, err := f.db.Exec("UPDATE work SET age_rating = ?, description = 'synthetic marker' WHERE id = ?", age, f.workID); err != nil {
				t.Fatal(err)
			}
			tx, err := f.db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			tagID, err := metadatatags.EnsureLegacyTx(ctx, tx, "Example tag")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO work_tag(work_id, tag_id, source) VALUES(?, ?, 'manual')", f.workID, tagID); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			provider := llmTestProvider(t, f, echoLLM(t, &requests, nil).URL, "external", "safe")
			policy := llm.Policy{
				Keywords: []llm.KeywordRule{{ID: "description-block", Term: "synthetic marker", Fields: []string{"description"}, Action: "blocked"}},
				TagRules: []llm.TagRule{{TagID: tagID, Action: "blocked"}},
			}
			if err := f.server.llmStore.SavePolicy(ctx, policy); err != nil {
				t.Fatal(err)
			}
			actor := translationActor(t, f.server, f.userID)
			submit := func(categories ...string) (aiTranslationRunResponse, error) {
				return f.server.submitAITranslation(ctx, actor, f.workID, aiTranslationRequest{Languages: []string{"en-us"}, Categories: categories, ProviderID: provider.ID})
			}
			if _, err := submit("title"); requestErrorCode(t, err) != "llm_policy_blocked" {
				t.Fatalf("default mode accepted the title of blocked metadata: %v", err)
			}

			policy.LLMTranslationTextOnly = true
			body, _ := json.Marshal(policy)
			w := httptest.NewRecorder()
			f.server.updateLLMPolicy(w, llmTestRequest(f, http.MethodPut, string(body)))
			if w.Code != http.StatusOK {
				t.Fatal(w.Body.String())
			}
			if saved, err := f.server.llmStore.Policy(ctx); err != nil || !saved.LLMTranslationTextOnly {
				t.Fatalf("text mode not persisted: %+v %v", saved, err)
			}
			if _, err := submit("description"); requestErrorCode(t, err) != "llm_policy_blocked" {
				t.Fatalf("text mode accepted a blocked chosen field: %v", err)
			}
			response, err := submit("title", "tags")
			if err != nil || response.Items != 2 {
				t.Fatalf("submit = %+v %v", response, err)
			}
			if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			if states := translationItemStates(t, f); requests.Load() != 1 || states["en-us:title:"] != "ready" || len(states) != 2 {
				t.Fatalf("states = %v, requests = %d", states, requests.Load())
			}
			var titleID int64
			if err := f.db.QueryRow("SELECT id FROM translation_item WHERE category = 'title'").Scan(&titleID); err != nil {
				t.Fatal(err)
			}
			if code, err := f.server.acceptTranslationItem(ctx, actor, titleID); code != "" || err != nil {
				t.Fatalf("accept = %q %v", code, err)
			}
			if allowed, err := f.server.asrAllowed(ctx, f.workID, asr.Provider{MaxContentClass: "restricted"}); err != nil || allowed {
				t.Fatalf("ASR ignored the metadata: allowed = %v %v", allowed, err)
			}
		})
	}
}

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

// A translation sends the chosen enabled model, or the default without one,
// and the accepted value records it.
func TestAITranslationSendsTheChosenEnabledModel(t *testing.T) {
	upstream, sent := llmModelRecorder(t)
	f := newManualOverrideFixture(t, config.Config{})
	ctx := context.Background()
	if _, err := f.db.Exec("UPDATE work SET age_rating = 'general' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	p := llmTestProvider(t, f, upstream.URL, "external", "safe")
	p.EnabledModels = []string{"example-model", "second-model"}
	p, err := f.server.llmStore.Mutate(ctx, p.ID, p, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	translate := func(language, model string) error {
		_, err := f.server.submitAITranslation(ctx, actor, f.workID, aiTranslationRequest{Languages: []string{language}, Categories: []string{"title"}, ProviderID: p.ID, Model: model})
		if err == nil {
			err = f.server.runNextQueuedWorkflowJob(ctx)
		}
		return err
	}
	if err := translate("zh-cn", "unlisted-model"); requestErrorCode(t, err) != "llm_not_ready" {
		t.Fatalf("unlisted model = %v", err)
	}
	if err := translate("zh-cn", "second-model"); err != nil {
		t.Fatal(err)
	}
	var stored string
	if err := f.db.QueryRow("SELECT model FROM work_llm_translation WHERE work_id = ? AND language = 'zh-cn'", f.workID).Scan(&stored); err != nil || stored != "second-model" {
		t.Fatalf("stored model = %q %v", stored, err)
	}
	if err := translate("zh-tw", ""); err != nil {
		t.Fatal(err)
	}
	if got := sent(); len(got) != 2 || got[0] != "second-model" || got[1] != "example-model" {
		t.Fatalf("sent models = %v", got)
	}
}
