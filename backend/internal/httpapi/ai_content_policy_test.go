package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
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
				{`"boundary":"external"`, 200, "safe"},
				{`"boundary":"private"`, 200, "safe"},
				{`"boundary":"private","maxContentClass":"sensitive"`, 200, "sensitive"},
				{`"allowSensitive":true`, 400, ""},
				{`"allowSensitive":false`, 400, ""},
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
				if _, exists := response["allowSensitive"]; exists {
					t.Fatal("response contains removed receive setting")
				}
				r = llmTestRequest(f, http.MethodPut, `{"name":"Renamed service"}`)
				r.SetPathValue("id", response["id"].(string))
				w = httptest.NewRecorder()
				save(w, r)
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"maxContentClass":"`+tc.maximum+`"`) {
					t.Fatalf("partial edit: %d %s", w.Code, w.Body.String())
				}
				r = llmTestRequest(f, http.MethodPut, `{"maxContentClass":"safe"}`)
				r.SetPathValue("id", response["id"].(string))
				w = httptest.NewRecorder()
				save(w, r)
				if w.Code != 200 || !strings.Contains(w.Body.String(), `"maxContentClass":"safe"`) {
					t.Fatalf("lowered maximum: %d %s", w.Code, w.Body.String())
				}
			}
		})
	}
}
