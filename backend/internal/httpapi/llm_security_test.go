package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

func llmTestRequest(f manualOverrideFixture, method, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/works/1/llm-translate", strings.NewReader(body))
	r.SetPathValue("id", strconv.FormatInt(f.workID, 10))
	return r.WithContext(context.WithValue(r.Context(), currentUserKey, account.User{ID: f.userID, Permissions: []string{"metadata:sync", "library:write", "sources:write"}}))
}
func llmTestProvider(t *testing.T, f manualOverrideFixture, url, boundary string, allow bool) llm.Provider {
	t.Helper()
	if _, err := f.db.Exec("UPDATE user_account SET role='admin' WHERE id=?", f.userID); err != nil {
		t.Fatal(err)
	}
	p, err := f.server.llmStore.Mutate(context.Background(), "", llm.Provider{PresetID: "custom-openai", BaseURL: url, Boundary: boundary, AllowSensitive: allow, Enabled: true, EnabledModels: []string{"example-model"}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func llmTestTranslate(t *testing.T, f manualOverrideFixture, p llm.Provider) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(llmTranslatePayload{ProviderID: p.ID, Target: "zh-cn", Fields: []string{"title"}})
	w := httptest.NewRecorder()
	f.server.translateWorkWithLLM(w, llmTestRequest(f, "POST", string(body)))
	return w
}
func TestLLMPolicyDenialMakesNoUpstreamRequest(t *testing.T) {
	var requests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
	}))
	defer upstream.Close()
	for _, tc := range []struct {
		name, age, boundary string
		allow               bool
		policy              llm.Policy
		want                int
	}{
		{"unknown", "", "private", true, llm.DefaultPolicy(), 422},
		{"unknown substring", "not-adult-known", "private", true, llm.DefaultPolicy(), 422},
		{"sensitive external", "adult", "external", true, llm.DefaultPolicy(), 422},
		{"sensitive private not authorized", "adult", "private", false, llm.DefaultPolicy(), 422},
		{"sensitive private authorized", "adult", "private", true, llm.DefaultPolicy(), 200},
		{"blocked private", "general", "private", true, llm.Policy{Keywords: []llm.KeywordRule{{ID: "block", Term: "Example", Fields: []string{"title"}, Action: "blocked"}}}, 422},
		{"unselected description blocked", "general", "private", true, llm.Policy{Keywords: []llm.KeywordRule{{ID: "block", Term: "restricted phrase", Fields: []string{"description"}, Action: "blocked"}}}, 422},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			if _, err := f.db.Exec("UPDATE work SET age_rating=?,description='restricted phrase' WHERE id=?", tc.age, f.workID); err != nil {
				t.Fatal(err)
			}
			if err := f.server.llmStore.SavePolicy(context.Background(), tc.policy); err != nil {
				t.Fatal(err)
			}
			p := llmTestProvider(t, f, upstream.URL, tc.boundary, tc.allow)
			before := requests.Load()
			w := llmTestTranslate(t, f, p)
			if w.Code != tc.want {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			expected := int64(0)
			if tc.want == 200 {
				expected = 1
			}
			if requests.Load()-before != expected {
				t.Fatalf("upstream requests=%d", requests.Load()-before)
			}
		})
	}
}
func TestLLMPreviewBindsActorAndRevalidatesSnapshots(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
	}))
	defer upstream.Close()
	for _, change := range []string{"source", "policy", "connection", "model", "other_model", "maximum", "replay", "restart", "actor", "work"} {
		t.Run(change, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			_, _ = f.db.Exec("UPDATE work SET age_rating='general',description='Original description' WHERE id=?", f.workID)
			p := llmTestProvider(t, f, upstream.URL, "external", false)
			if change == "maximum" {
				p.MaxContentClass = "sensitive"
				var err error
				p, err = f.server.llmStore.Mutate(context.Background(), p.ID, p, nil, false)
				if err != nil {
					t.Fatal(err)
				}
			}
			w := llmTestTranslate(t, f, p)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			var result struct {
				ID string `json:"previewId"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			switch change {
			case "source":
				_, _ = f.db.Exec("UPDATE work SET title='Changed source' WHERE id=?", f.workID)
			case "policy":
				if err := f.server.llmStore.SavePolicy(context.Background(), llm.DefaultPolicy()); err != nil {
					t.Fatal(err)
				}
			case "connection", "model", "other_model", "maximum":
				switch change {
				case "connection":
					p.BaseURL = "https://new.example.invalid"
				case "maximum":
					p.MaxContentClass = "safe"
				case "model":
					// The model the preview used is no longer offered.
					p.EnabledModels = []string{"another-model"}
				default:
					// Offering another model and making it the default leaves the preview valid.
					p.EnabledModels, p.DefaultModel = []string{"example-model", "another-model"}, "another-model"
				}
				if _, err := f.server.llmStore.Mutate(context.Background(), p.ID, p, nil, false); err != nil {
					t.Fatal(err)
				}
			case "restart":
				f.server = NewServer(f.db, config.Config{})
			}
			apply := func() *httptest.ResponseRecorder {
				r := llmTestRequest(f, "PUT", `{"previewId":"`+result.ID+`"}`)
				if change == "actor" {
					r = r.WithContext(context.WithValue(r.Context(), currentUserKey, account.User{ID: 999, Permissions: []string{"library:write", "metadata:sync"}}))
				}
				if change == "work" {
					r.SetPathValue("id", "999")
				}
				w := httptest.NewRecorder()
				f.server.applyLLMTranslation(w, r)
				return w
			}
			w = apply()
			want := 409
			if change == "restart" || change == "replay" || change == "other_model" {
				want = 200
			}
			if change == "actor" || change == "work" {
				want = 404
			}
			if w.Code != want {
				t.Fatalf("apply %s: %d %s", change, w.Code, w.Body.String())
			}
			if change == "replay" {
				if w = apply(); w.Code != 404 {
					t.Fatal("preview was applied twice")
				}
			}
			var count int
			_ = f.db.QueryRow("SELECT COUNT(*) FROM work_llm_translation").Scan(&count)
			if (want == 200) != (count == 1) {
				t.Fatalf("writes=%d status=%d", count, w.Code)
			}
			if want == 200 {
				input, err := loadWorkTitleInputs(context.Background(), f.db, []int64{f.workID}, false)
				if err != nil {
					t.Fatal(err)
				}
				if len(input[f.workID].Variants) != 1 || input[f.workID].Variants[0].Title != "Example translation" {
					t.Fatalf("card inputs=%+v", input)
				}
				detail, err := f.server.loadWorkDetail(context.Background(), f.userID, f.workID, false)
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, v := range detail.MetadataView.Variants {
					if v.Key == "llm:zh-cn" && v.TitleSource == "llm" && v.Description == "Original description" {
						found = true
					}
				}
				if !found {
					t.Fatalf("machine language missing: %+v", detail.MetadataView)
				}
			}
		})
	}
}
func TestLLMEndpointChangeDropsCredentialsAndModels(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	acceptServiceNoticeForTest(t, f)
	p := llmTestProvider(t, f, "https://first.example.invalid", "external", false)
	key := "synthetic-token"
	var err error
	p, err = f.server.llmStore.Mutate(context.Background(), p.ID, p, &key, false)
	if err != nil {
		t.Fatal(err)
	}
	p, err = f.server.llmStore.Models(context.Background(), p, []llm.Model{{ID: "example-model"}})
	if err != nil {
		t.Fatal(err)
	}
	// The handler starts with the current provider, including its server-side key.
	r := llmTestRequest(f, "PUT", `{"baseUrl":"https://second.example.invalid","enabledModels":["example-model"]}`)
	r.SetPathValue("id", p.ID)
	w := httptest.NewRecorder()
	f.server.saveLLMProvider(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	p, err = f.server.llmProvider(context.Background(), p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if p.APIKey != "" || len(p.Models) != 0 {
		t.Fatalf("connection inherited credential or models: %+v", p)
	}
}
func TestLLMOllamaLocalURLCannotBeOverridden(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	acceptServiceNoticeForTest(t, f)
	r := llmTestRequest(f, "POST", `{"presetId":"ollama","ollamaScope":"local_machine","baseUrl":"https://attacker.example.invalid","enabled":true}`)
	r.SetPathValue("id", "")
	w := httptest.NewRecorder()
	f.server.saveLLMProvider(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	providers, err := f.server.llmStore.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(providers) != 1 || providers[0].BaseURL != "" || strings.Contains(providers[0].Endpoint(f.server.cfg.HostProxyAddress()), "attacker") {
		t.Fatal("request overrode server-computed Ollama origin")
	}
}
