package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A batch reports each work's outcome, and a refused work does not stop the
// works after it.
func TestAITranslationBatchQueuesEachWorkAndReportsRefusals(t *testing.T) {
	var requests atomic.Int32
	upstream := prefixingLLM(t, &requests)
	f := newManualOverrideFixture(t, config.Config{})
	provider := llmTestProvider(t, f, upstream.URL, "external", "safe")
	if _, err := f.db.Exec("UPDATE work SET age_rating = 'general', description = 'Example description' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	result, err := f.db.Exec("INSERT INTO work (primary_code, title, description, age_rating) VALUES ('RJ00000001', 'Second Work', 'Second description', 'general')")
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	request := aiTranslationRequest{Languages: []string{"zh-cn"}, Categories: []string{"description"}, ProviderID: provider.ID}
	// The first work's description is already being translated.
	if _, err := f.server.submitAITranslation(context.Background(), actor, f.workID, request); err != nil {
		t.Fatal(err)
	}

	body := fmt.Sprintf(`{"workIds":[%d,999999,%d,%d],"languages":["zh-cn"],"categories":["description"],"providerId":%q}`,
		f.workID, secondID, secondID, provider.ID)
	r := httptest.NewRequest(http.MethodPost, "/api/translation/batch", strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	f.server.createAITranslationBatch(response, r)
	if response.Code != http.StatusOK {
		t.Fatalf("batch = %d %s", response.Code, response.Body.String())
	}
	var decoded struct {
		Results []aiTranslationBatchResult `json:"results"`
	}
	if err := json.NewDecoder(response.Body).Decode(&decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Results) != 3 {
		t.Fatalf("results = %+v, want one per distinct work", decoded.Results)
	}
	first, missing, second := decoded.Results[0], decoded.Results[1], decoded.Results[2]
	if first.Code != "nothing_to_translate" || missing.Code != "work_not_found" {
		t.Fatalf("refusals = %+v %+v", first, missing)
	}
	if second.WorkID != secondID || second.Code != "" || second.RunID == 0 || second.Items != 1 {
		t.Fatalf("queued = %+v", second)
	}

	empty := httptest.NewRequest(http.MethodPost, "/api/translation/batch", strings.NewReader(`{"workIds":[]}`))
	empty = empty.WithContext(context.WithValue(empty.Context(), currentUserKey, actor))
	refused := httptest.NewRecorder()
	f.server.createAITranslationBatch(refused, empty)
	if refused.Code != http.StatusBadRequest {
		t.Fatalf("empty batch = %d %s", refused.Code, refused.Body.String())
	}
}
