package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/asr"
)

// The service receives a complete upload, then loses the response. Only an
// explicitly requested second upload receives the synthetic transcript.
func speechProviderWithLostResponse(t *testing.T, f asrFixture) (asr.Provider, *atomic.Int32) {
	t.Helper()
	requests := &atomic.Int32{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if requests.Add(1) == 1 {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = connection.Close()
			}
			return
		}
		_, _ = io.WriteString(w, `{"text":"Synthetic line","segments":[{"start":0.5,"end":1.5,"text":"Synthetic line"}]}`)
	}))
	t.Cleanup(upstream.Close)
	provider := f.provider
	provider.BaseURL = upstream.URL
	changed, err := f.server.asrStore.Mutate(context.Background(), provider.ID, provider, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	return changed, requests
}

func TestAITranslationLostSpeechResponseRequiresAcknowledgement(t *testing.T) {
	f, llmProvider, _ := newTranslationASRFixture(t)
	disableAutoAccept(t, f.db)
	provider, requests := speechProviderWithLostResponse(t, f)
	actor := translationActor(t, f.server, f.userID)
	response, err := f.server.submitAITranslation(context.Background(), actor, f.workID, aiTranslationRequest{
		Languages: []string{"en-us"}, ProviderID: llmProvider.ID, ASRProviderID: provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: f.audioID, TargetLanguage: "en-us"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := f.db.QueryRow("SELECT id FROM translation_item WHERE workflow_run_id=? AND engine='asr'", response.RunID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if result := resendSpeechTranslation(t, f, id, false); result.OK || result.Code != "llm_acknowledgement_required" {
		t.Fatalf("an uploaded request without a response was resent: %+v", result)
	}
	if requests.Load() != 1 {
		t.Fatalf("uploads=%d, want only the original upload", requests.Load())
	}
}

func TestASRTranscriptionLostResponseNeedsExplicitRetry(t *testing.T) {
	f := newASRFixture(t, 2)
	provider, requests := speechProviderWithLostResponse(t, f)
	f.provider = provider
	response, id, runID := f.create(t, "ja-jp")
	if response.Code != http.StatusAccepted {
		t.Fatalf("create=%d %s", response.Code, response.Body.String())
	}
	ctx := context.Background()
	_ = f.server.runNextQueuedWorkflowJob(ctx)
	state, code, _ := f.state(t, id)
	if state != "failed" || code != asrResultUnknown {
		t.Fatalf("lost response=%s/%s", state, code)
	}
	if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatalf("the unknown result was retried automatically: uploads=%d", requests.Load())
	}
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.retryASRTranscriptionRun(ctx, actor, runID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if state, _, _ := f.state(t, id); state != "ready" || requests.Load() != 2 {
		t.Fatalf("explicit retry state=%s uploads=%d", state, requests.Load())
	}
}
