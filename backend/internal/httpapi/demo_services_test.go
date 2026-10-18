package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

func demoServiceRequest(f manualOverrideFixture, method, target, body string) *http.Request {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	return r.WithContext(context.WithValue(r.Context(), currentUserKey, account.User{ID: f.userID, Username: "__demo__"}))
}

// Demo lists sample services over the real presets for inspection, and every
// one names an origin no request can reach.
func TestDemoListsSampleServicesOverRealPresets(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{Mode: "demo", HostProxyHost: "192.0.2.10"})

	var services struct {
		Providers   []asrProviderResponse `json:"providers"`
		Presets     []asr.Preset          `json:"presets"`
		HostAddress string                `json:"hostAddress"`
	}
	w := httptest.NewRecorder()
	f.server.listASRProviders(w, demoServiceRequest(f, http.MethodGet, "/api/asr/providers", ""))
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &services) != nil {
		t.Fatalf("Demo ASR status=%d body=%s", w.Code, w.Body.String())
	}
	if len(services.Providers) == 0 || len(services.Presets) != len(asr.Presets) {
		t.Fatalf("Demo ASR list = %+v", services)
	}

	var providers struct {
		Providers      []llmProviderResponse `json:"providers"`
		Presets        []llm.Preset          `json:"presets"`
		NoticeAccepted bool                  `json:"noticeAccepted"`
		HostAddress    string                `json:"hostAddress"`
	}
	w = httptest.NewRecorder()
	f.server.listLLMProviders(w, demoServiceRequest(f, http.MethodGet, "/api/llm/providers", ""))
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &providers) != nil {
		t.Fatalf("Demo LLM status=%d body=%s", w.Code, w.Body.String())
	}
	if len(providers.Providers) == 0 || len(providers.Presets) != len(llm.Presets) || !providers.NoticeAccepted {
		t.Fatalf("Demo LLM list = %+v", providers)
	}

	origins := []string{services.HostAddress, providers.HostAddress}
	for _, service := range services.Providers {
		origins = append(origins, service.BaseURL)
	}
	for _, provider := range providers.Providers {
		origins = append(origins, provider.BaseURL)
	}
	for _, origin := range origins {
		host := origin
		if parsed, err := url.Parse(origin); err == nil && parsed.Host != "" {
			host = parsed.Hostname()
		}
		if !strings.HasSuffix(host, ".invalid") {
			t.Fatalf("Demo sample %q reaches a real host", origin)
		}
	}
}

func TestDemoRefusesServiceConfiguration(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{Mode: "demo"})
	for name, call := range map[string]struct {
		handler http.HandlerFunc
		method  string
		target  string
		body    string
	}{
		"add ASR":          {f.server.saveASRProvider, http.MethodPost, "/api/asr/providers", `{"presetId":"custom-openai","baseUrl":"https://asr.example.invalid"}`},
		"edit ASR":         {f.server.saveASRProvider, http.MethodPut, "/api/asr/providers/demo-asr", `{"enabled":false}`},
		"delete ASR":       {f.server.deleteASRProvider, http.MethodDelete, "/api/asr/providers/demo-asr", ""},
		"fetch ASR models": {f.server.fetchASRModels, http.MethodPost, "/api/asr/providers/demo-asr/fetch-models", ""},
		"add LLM":          {f.server.saveLLMProvider, http.MethodPost, "/api/llm/providers", `{"presetId":"custom-openai","baseUrl":"https://llm.example.invalid"}`},
		"edit LLM":         {f.server.saveLLMProvider, http.MethodPut, "/api/llm/providers/demo-llm", `{"enabled":false}`},
		"delete LLM":       {f.server.deleteLLMProvider, http.MethodDelete, "/api/llm/providers/demo-llm", ""},
		"fetch LLM models": {f.server.fetchLLMModels, http.MethodPost, "/api/llm/providers/demo-llm/fetch-models", ""},
		"save policy":      {f.server.updateLLMPolicy, http.MethodPut, "/api/llm/policy", `{}`},
	} {
		r := demoServiceRequest(f, call.method, call.target, call.body)
		if id := strings.TrimPrefix(call.target, "/api/asr/providers/"); id != call.target {
			r.SetPathValue("id", strings.TrimSuffix(id, "/fetch-models"))
		}
		if id := strings.TrimPrefix(call.target, "/api/llm/providers/"); id != call.target {
			r.SetPathValue("id", strings.TrimSuffix(id, "/fetch-models"))
		}
		w := httptest.NewRecorder()
		call.handler(w, r)
		if w.Code != http.StatusForbidden {
			t.Fatalf("%s in Demo: status=%d body=%s", name, w.Code, w.Body.String())
		}
	}
}
