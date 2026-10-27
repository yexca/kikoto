package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// queuedLyricsTranslation queues the English lyrics of the fixture's track,
// translated from its lyrics file, for review.
func queuedLyricsTranslation(t *testing.T) (asrFixture, aiTranslationRunResponse, *atomic.Int32) {
	t.Helper()
	f, provider, requests := newTranslationFixture(t)
	disableAutoAccept(t, f.db)
	actor := translationActor(t, f.server, f.userID)
	source := translationLyricsFile(t, f)
	response, err := f.server.submitAITranslation(context.Background(), actor, f.workID, aiTranslationRequest{
		Languages: []string{"en-us"}, ProviderID: provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: f.audioID, TargetLanguage: "en-us", LyricsLocationID: source}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return f, response, requests
}

func TestAITranslationCannotFinishWithUnsettledItems(t *testing.T) {
	f, response, _ := queuedLyricsTranslation(t)
	ctx := context.Background()
	job, claimed, err := f.server.claimNextQueuedWorkflowJob(ctx, "translation-recovery-test")
	if err != nil || !claimed || job.RunID != response.RunID {
		t.Fatalf("claim=%v run=%d error=%v", claimed, job.RunID, err)
	}
	if err := f.server.finishAITranslationJob(ctx, job); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id=?", response.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "queued" {
		t.Fatalf("a run with active items must continue: status=%s", status)
	}
}

func TestAITranslationRecoveryKeepsCommittedLyricsChunks(t *testing.T) {
	f, response, requests := queuedLyricsTranslation(t)
	ctx := context.Background()
	items, err := loadTranslationItems(ctx, f.db, "item.workflow_run_id = ?", response.RunID)
	if err != nil || len(items) != 1 {
		t.Fatalf("items=%+v error=%v", items, err)
	}
	send := &translationSend{actor: translationActor(t, f.server, f.userID)}
	if send.policy, err = f.server.llmStore.Policy(ctx); err != nil {
		t.Fatal(err)
	}
	// The first chunk was translated and committed before the process stopped.
	_, hash, code := f.server.translationLyricsSource(ctx, send, items[0])
	if code != "" {
		t.Fatalf("source=%s", code)
	}
	if _, err := f.db.Exec(`UPDATE translation_item SET state='queued', source_text=?, source_hash=?, request_index=1,
		checkpoint_json='["Example translated line"]' WHERE workflow_run_id=?`, translationSourceLyrics, hash, response.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var state, result string
	if err := f.db.QueryRow("SELECT state, result_text FROM translation_item WHERE workflow_run_id=?", response.RunID).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || !strings.Contains(result, "Example translated line") || requests.Load() != 0 {
		t.Fatalf("state=%s result=%q translation requests=%d", state, result, requests.Load())
	}
}

func resendTranslation(t *testing.T, f asrFixture, id int64, acknowledge bool) translationReviewResult {
	t.Helper()
	body, err := json.Marshal(translationReviewRequest{IDs: []int64{id}, AcknowledgeUncertain: acknowledge})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/translation/items/resend", strings.NewReader(string(body)))
	r = r.WithContext(context.WithValue(r.Context(), currentUserKey, translationActor(t, f.server, f.userID)))
	w := httptest.NewRecorder()
	f.server.resendTranslationItems(w, r)
	var response struct {
		Results []translationReviewResult `json:"results"`
	}
	if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &response) != nil || len(response.Results) != 1 {
		t.Fatalf("resend=%d %s", w.Code, w.Body.String())
	}
	return response.Results[0]
}

// A request in flight when the process stopped is resent only after explicit
// confirmation, and Activity's retry leaves it alone.
func TestAITranslationUnknownResultRequiresAcknowledgement(t *testing.T) {
	f, response, requests := queuedLyricsTranslation(t)
	if _, err := f.db.Exec("UPDATE translation_item SET state='requesting' WHERE workflow_run_id=?", response.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := f.db.QueryRow("SELECT id FROM translation_item WHERE workflow_run_id=? AND state='uncertain'", response.RunID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.retryAITranslationRun(context.Background(), actor, response.RunID); !errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		t.Fatalf("Activity retry=%v", err)
	}
	if result := resendTranslation(t, f, id, false); result.OK || result.Code != "llm_acknowledgement_required" {
		t.Fatalf("unconfirmed resend=%+v", result)
	}
	if result := resendTranslation(t, f, id, true); !result.OK {
		t.Fatalf("confirmed resend=%+v", result)
	}
	if requests.Load() != 0 {
		t.Fatalf("resending sent a request before the job ran: %d", requests.Load())
	}
}

func TestAITranslationProjectsPersistedUnknownFailuresForConfirmation(t *testing.T) {
	for _, code := range []string{"upstream_result_unknown", "cancelled_result_unknown"} {
		t.Run(code, func(t *testing.T) {
			f, response, _ := queuedLyricsTranslation(t)
			if _, err := f.db.Exec("UPDATE translation_item SET state='failed', failure_code=? WHERE workflow_run_id=?", code, response.RunID); err != nil {
				t.Fatal(err)
			}
			items, err := f.server.translationItemResponses(context.Background(), "item.workflow_run_id = ?", response.RunID)
			if err != nil || len(items) != 1 || items[0].State != "uncertain" || items[0].FailureCode != code {
				t.Fatalf("items=%+v error=%v", items, err)
			}
			var stored string
			if err := f.db.QueryRow("SELECT state FROM translation_item WHERE workflow_run_id=?", response.RunID).Scan(&stored); err != nil || stored != "failed" {
				t.Fatalf("projection changed stored state: %q %v", stored, err)
			}
		})
	}
}

func TestAITranslationActivityRetryRequiresNewRequestForInvalidatedSource(t *testing.T) {
	f, response, _ := queuedLyricsTranslation(t)
	if _, err := f.db.Exec("UPDATE translation_item SET state='failed', failure_code='source_changed' WHERE workflow_run_id=?", response.RunID); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.retryAITranslationRun(context.Background(), actor, response.RunID); !errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		t.Fatalf("Activity retry=%v", err)
	}
}

func TestAITranslationActivityRetryKeepsFinishedResult(t *testing.T) {
	f, response, requests := queuedLyricsTranslation(t)
	ctx := context.Background()
	if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	sent := requests.Load()
	var result string
	if err := f.db.QueryRow("SELECT result_text FROM translation_item WHERE workflow_run_id=?", response.RunID).Scan(&result); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE translation_item SET state='failed', failure_code='accept_failed' WHERE workflow_run_id=?", response.RunID); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.retryAITranslationRun(ctx, actor, response.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	var state, kept string
	if err := f.db.QueryRow("SELECT state, result_text FROM translation_item WHERE workflow_run_id=?", response.RunID).Scan(&state, &kept); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || kept != result || requests.Load() != sent {
		t.Fatalf("state=%s result preserved=%v translations=%d", state, kept == result, requests.Load())
	}
}
