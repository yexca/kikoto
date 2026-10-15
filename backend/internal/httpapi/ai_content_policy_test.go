package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

func TestAIProviderReceiveMaximumAPI(t *testing.T) {
	for _, kind := range []string{"llm", "asr"} {
		t.Run(kind, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			acceptServiceNoticeForTest(t, f)
			save := f.server.saveLLMProvider
			if kind == "asr" {
				save = f.server.saveASRProvider
			}
			for _, tc := range []struct {
				fields  string
				status  int
				maximum string
			}{
				{`"boundary":"external","allowSensitive":true`, 200, "safe"},
				{`"boundary":"private","allowSensitive":true`, 200, "sensitive"},
				{`"boundary":"private","allowSensitive":false`, 200, "safe"},
				{`"boundary":"external","maxContentClass":"sensitive"`, 200, "sensitive"},
				{`"boundary":"external","maxContentClass":"restricted"`, 200, "restricted"},
				{`"maxContentClass":"blocked"`, 400, ""},
				{`"maxContentClass":"unknown"`, 400, ""},
				{`"maxContentClass":""`, 400, ""},
				{`"maxContentClass":"restricted","allowSensitive":true`, 400, ""},
			} {
				r := llmTestRequest(f, http.MethodPost, `{"presetId":"custom-openai","baseUrl":"https://service.example.invalid",`+tc.fields+`}`)
				r.SetPathValue("id", "")
				w := httptest.NewRecorder()
				save(w, r)
				var response map[string]any
				if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				if w.Code != tc.status || tc.status == 200 && response["maxContentClass"] != tc.maximum {
					t.Fatalf("%s: status=%d body=%s", tc.fields, w.Code, w.Body.String())
				}
				if tc.status != 200 {
					continue
				}
				r = llmTestRequest(f, http.MethodPut, `{"name":"Renamed service"}`)
				r.SetPathValue("id", response["id"].(string))
				w = httptest.NewRecorder()
				save(w, r)
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"maxContentClass":"`+tc.maximum+`"`) {
					t.Fatalf("partial edit: %d %s", w.Code, w.Body.String())
				}
				r = llmTestRequest(f, http.MethodPut, `{"allowSensitive":false}`)
				r.SetPathValue("id", response["id"].(string))
				w = httptest.NewRecorder()
				save(w, r)
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"maxContentClass":"safe"`) {
					t.Fatalf("legacy opt-out: %d %s", w.Code, w.Body.String())
				}
			}
		})
	}
}

func TestLLMExplicitReceiveMaximumGuardsOutboundRequests(t *testing.T) {
	var requests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
	}))
	defer upstream.Close()
	for _, tc := range []struct {
		age, action, maximum string
		want                 int
	}{
		{"adult", "", "sensitive", 200},
		{"general", "restricted", "sensitive", 422},
		{"adult", "restricted", "sensitive", 422},
		{"adult", "restricted", "restricted", 200},
		{"general", "blocked", "restricted", 422},
		{"", "restricted", "restricted", 422},
	} {
		t.Run(tc.age+"/"+tc.action+"/"+tc.maximum, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			_, _ = f.db.Exec("UPDATE work SET age_rating=?,description='synthetic marker' WHERE id=?", tc.age, f.workID)
			if tc.action != "" {
				if err := f.server.llmStore.SavePolicy(context.Background(), llm.Policy{Keywords: []llm.KeywordRule{{ID: "synthetic-rule", Term: "synthetic marker", Fields: []string{"description"}, Action: tc.action}}}); err != nil {
					t.Fatal(err)
				}
			}
			p := llmTestProvider(t, f, upstream.URL, "external", false)
			p.MaxContentClass = tc.maximum
			var err error
			p, err = f.server.llmStore.Mutate(context.Background(), p.ID, p, nil, false)
			if err != nil {
				t.Fatal(err)
			}
			before := requests.Load()
			w := llmTestTranslate(t, f, p)
			wantRequests := int32(0)
			if tc.want == 200 {
				wantRequests = 1
			}
			if w.Code != tc.want || requests.Load()-before != wantRequests {
				t.Fatalf("status=%d body=%s requests=%d", w.Code, w.Body.String(), requests.Load()-before)
			}
			allowed, err := f.server.asrAllowed(context.Background(), f.workID, asr.Provider{Boundary: "external", MaxContentClass: tc.maximum})
			if err != nil || allowed != (tc.want == 200) {
				t.Fatalf("ASR allowed=%v err=%v", allowed, err)
			}
		})
	}
}

func TestLLMChunkSendRechecksLoweredReceiveMaximum(t *testing.T) {
	var requests atomic.Int32
	f := newManualOverrideFixture(t, config.Config{})
	_, _ = f.db.Exec("UPDATE work SET age_rating='adult' WHERE id=?", f.workID)
	var provider llm.Provider
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		provider.MaxContentClass = "safe"
		if _, err := f.server.llmStore.Mutate(r.Context(), provider.ID, provider, nil, false); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"title\":\"Example translation\"}"}}]}`))
	}))
	defer upstream.Close()
	provider = llmTestProvider(t, f, upstream.URL, "private", true)
	payload := llmTranslatePayload{ProviderID: provider.ID, Target: "zh-cn", Fields: []string{"title"}}
	plan, err := f.server.prepareLLMTranslation(context.Background(), f.workID, payload)
	if err != nil {
		t.Fatal(err)
	}
	plan.Text.Lyrics = []string{"Synthetic line"}
	_, err = f.server.requestLLMTranslation(context.Background(), plan, payload.Target, func(ctx context.Context) error {
		return f.server.validateLLMSend(ctx, f.userID, f.workID, payload, plan)
	})
	if err == nil || requests.Load() != 1 {
		t.Fatalf("requests=%d err=%v", requests.Load(), err)
	}
}
