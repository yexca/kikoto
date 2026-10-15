package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestServiceConfigurationWaitsForTheExternalServiceNotice(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{HostProxyHost: "gateway.example.invalid"})
	if _, err := fixture.db.Exec("UPDATE user_account SET role = 'admin' WHERE id = ?", fixture.userID); err != nil {
		t.Fatal(err)
	}
	actor, err := fixture.server.accountStore.LoadByID(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	call := func(handler http.HandlerFunc, method, path, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
		response := httptest.NewRecorder()
		handler(response, request)
		return response
	}
	noticeAccepted := func() bool {
		response := call(fixture.server.listLLMProviders, http.MethodGet, "/api/llm/providers", "")
		var list struct {
			NoticeAccepted bool `json:"noticeAccepted"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &list); err != nil || response.Code != http.StatusOK {
			t.Fatalf("list = %d %s", response.Code, response.Body.String())
		}
		return list.NoticeAccepted
	}

	if noticeAccepted() {
		t.Fatal("a new instance reports the notice as accepted")
	}
	refused := map[string]*httptest.ResponseRecorder{
		"LLM provider": call(fixture.server.saveLLMProvider, http.MethodPost, "/api/llm/providers", `{"presetId":"custom-openai","baseUrl":"https://llm.example.invalid"}`),
		"ASR service":  call(fixture.server.saveASRProvider, http.MethodPost, "/api/asr/providers", `{"presetId":"local","scope":"local_machine","port":8000}`),
		"policy":       call(fixture.server.updateLLMPolicy, http.MethodPut, "/api/llm/policy", `{"alwaysScanAllAges":true,"tagRules":[],"keywords":[]}`),
	}
	for name, response := range refused {
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "service_notice_required") {
			t.Fatalf("%s before the notice = %d %s", name, response.Code, response.Body.String())
		}
	}
	if providers, err := fixture.server.asrStore.List(context.Background()); err != nil || len(providers) != 0 {
		t.Fatalf("refused save stored %+v, %v", providers, err)
	}

	if response := call(fixture.server.acceptServiceNotice, http.MethodPost, "/api/llm/notice-acceptance", ""); response.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", response.Code, response.Body.String())
	}
	if !noticeAccepted() {
		t.Fatal("the accepted notice is not reported")
	}
	if response := call(fixture.server.saveASRProvider, http.MethodPost, "/api/asr/providers", `{"presetId":"local","scope":"local_machine","port":8000}`); response.Code != http.StatusOK {
		t.Fatalf("ASR service after the notice = %d %s", response.Code, response.Body.String())
	}
}

// acceptServiceNoticeForTest lets a test configure services through the handlers.
func acceptServiceNoticeForTest(t *testing.T, f manualOverrideFixture) {
	t.Helper()
	if err := f.server.llmStore.AcceptNotice(context.Background(), f.userID, time.Now()); err != nil {
		t.Fatal(err)
	}
}
