package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

func llmTestRequest(f manualOverrideFixture, method, body string) *http.Request {
	r := httptest.NewRequest(method, "/api/works/1", strings.NewReader(body))
	r.SetPathValue("id", strconv.FormatInt(f.workID, 10))
	return r.WithContext(context.WithValue(r.Context(), currentUserKey, account.User{ID: f.userID, Permissions: []string{"metadata:sync", "library:write", "sources:write"}}))
}
func llmTestProvider(t *testing.T, f manualOverrideFixture, url, boundary, maximum string) llm.Provider {
	t.Helper()
	if _, err := f.db.Exec("UPDATE user_account SET role='admin' WHERE id=?", f.userID); err != nil {
		t.Fatal(err)
	}
	p, err := f.server.llmStore.Mutate(context.Background(), "", llm.Provider{PresetID: "custom-openai", BaseURL: url, Boundary: boundary, MaxContentClass: maximum, Enabled: true, EnabledModels: []string{"example-model"}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func TestLLMEndpointChangeDropsCredentialsAndModels(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	acceptServiceNoticeForTest(t, f)
	p := llmTestProvider(t, f, "https://first.example.invalid", "external", "safe")
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
