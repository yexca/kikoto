package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

const recoveryTranscript = "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nSynthetic line\n"

func queuedTranslationFromSpeech(t *testing.T) (asrFixture, aiTranslationRunResponse, *atomic.Int32) {
	t.Helper()
	f, provider, requests := newTranslationASRFixture(t)
	disableAutoAccept(t, f.db)
	actor := translationActor(t, f.server, f.userID)
	response, err := f.server.submitAITranslation(context.Background(), actor, f.workID, aiTranslationRequest{
		Languages: []string{"en-us"}, ProviderID: provider.ID, ASRProviderID: f.provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: f.audioID, TargetLanguage: "en-us"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return f, response, requests
}

// A task result may commit immediately before the process stops. Recovery
// consumes that persisted result without sending the speech request again.
func TestAITranslationRecoveryReconcilesTranscriptionResults(t *testing.T) {
	for _, test := range []struct {
		name, taskState, code, itemState string
		translations                     int32
	}{
		{name: "ready", taskState: "ready", itemState: "ready", translations: 1},
		{name: "publishing", taskState: "publishing", itemState: "ready", translations: 1},
		{name: "accepted", taskState: "accepted", itemState: "ready", translations: 1},
		{name: "failed", taskState: "failed", code: "upstream_rejected", itemState: "failed"},
		{name: "unknown", taskState: "failed", code: asrResultUnknown, itemState: "uncertain"},
		{name: "rejected", taskState: "rejected", itemState: "rejected"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, response, requests := queuedTranslationFromSpeech(t)
			if _, err := f.db.Exec("UPDATE asr_transcription SET state=?, failure_code=?, value_text=? WHERE workflow_run_id=?", test.taskState, test.code, recoveryTranscript, response.RunID); err != nil {
				t.Fatal(err)
			}
			if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
				t.Fatal(err)
			}
			var matching, active int
			if err := f.db.QueryRow("SELECT COUNT(*) FROM translation_item WHERE workflow_run_id=? AND state=?", response.RunID, test.itemState).Scan(&matching); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow("SELECT COUNT(*) FROM translation_item WHERE workflow_run_id=? AND state IN ('queued','waiting_transcription','requesting')", response.RunID).Scan(&active); err != nil {
				t.Fatal(err)
			}
			if matching != 2 || active != 0 || f.requests.Load() != 0 || requests.Load() != test.translations {
				t.Fatalf("matching=%d active=%d speech requests=%d translations=%d", matching, active, f.requests.Load(), requests.Load())
			}
		})
	}
}

func TestAITranslationRecoveryAutomaticallyPublishesReadyTranscription(t *testing.T) {
	f, _, _ := newTranslationASRFixture(t)
	actor := translationActor(t, f.server, f.userID)
	response, err := f.server.submitAITranslation(context.Background(), actor, f.workID, aiTranslationRequest{
		Languages: []string{"ja-jp"}, ASRProviderID: f.provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: f.audioID, TargetLanguage: "ja-jp"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE asr_transcription SET state='ready', value_text=? WHERE workflow_run_id=?", recoveryTranscript, response.RunID); err != nil {
		t.Fatal(err)
	}
	// The item's review result also committed, but automatic acceptance did not.
	if _, err := f.db.Exec("UPDATE translation_item SET state='ready', result_text=? WHERE workflow_run_id=?", recoveryTranscript, response.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var accepted int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM translation_item WHERE workflow_run_id=? AND state='accepted'", response.RunID).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	text, err := os.ReadFile(filepath.Join(f.dataRoot, filepath.FromSlash(f.root), "lyrics_kikoto", "ja", "mp3", "Track1.vtt"))
	if accepted != 1 || err != nil || !strings.Contains(string(text), "Synthetic line") || f.requests.Load() != 0 {
		t.Fatalf("accepted=%d speech requests=%d lyrics=%q error=%v", accepted, f.requests.Load(), text, err)
	}
}

func TestAITranslationCannotFinishWithUnsettledItems(t *testing.T) {
	f, response, _ := queuedTranslationFromSpeech(t)
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
	f, response, requests := queuedTranslationFromSpeech(t)
	if _, err := f.db.Exec("UPDATE asr_transcription SET state='ready', value_text=? WHERE workflow_run_id=?", recoveryTranscript, response.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE translation_item SET state='ready', result_text=? WHERE workflow_run_id=? AND engine='asr'", recoveryTranscript, response.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`UPDATE translation_item SET state='queued', source_text=?, source_hash=?, request_index=1,
		checkpoint_json='["Example translated line"]' WHERE workflow_run_id=? AND engine='llm'`, recoveryTranscript, llmValueHash(recoveryTranscript), response.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var state, result string
	if err := f.db.QueryRow("SELECT state, result_text FROM translation_item WHERE workflow_run_id=? AND engine='llm'", response.RunID).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || !strings.Contains(result, "Example translated line") || requests.Load() != 0 || f.requests.Load() != 0 {
		t.Fatalf("state=%s result=%q speech requests=%d translation requests=%d", state, result, f.requests.Load(), requests.Load())
	}
}

func resendSpeechTranslation(t *testing.T, f asrFixture, id int64, acknowledge bool) translationReviewResult {
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

// Confirming one item must cover its shared transcription; sending either
// the transcription or a dependent translation cannot bypass that decision.
func TestAITranslationUnknownSpeechRequiresAcknowledgementForEveryEntry(t *testing.T) {
	for _, engine := range []string{"asr", "llm"} {
		t.Run(engine, func(t *testing.T) {
			f, response, _ := queuedTranslationFromSpeech(t)
			if _, err := f.db.Exec("UPDATE asr_transcription SET state='requesting' WHERE workflow_run_id=?", response.RunID); err != nil {
				t.Fatal(err)
			}
			if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
				t.Fatal(err)
			}
			var id int64
			if err := f.db.QueryRow("SELECT id FROM translation_item WHERE workflow_run_id=? AND engine=?", response.RunID, engine).Scan(&id); err != nil {
				t.Fatal(err)
			}
			if result := resendSpeechTranslation(t, f, id, false); result.OK || result.Code != "llm_acknowledgement_required" {
				t.Fatalf("unconfirmed resend=%+v", result)
			}
			if result := resendSpeechTranslation(t, f, id, true); !result.OK {
				t.Fatalf("confirmed resend=%+v", result)
			}
			var pending, active int
			if err := f.db.QueryRow("SELECT COUNT(*) FROM asr_transcription WHERE workflow_run_id=? AND state='pending'", response.RunID).Scan(&pending); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow("SELECT COUNT(*) FROM translation_item WHERE workflow_run_id=? AND state IN ('queued','waiting_transcription')", response.RunID).Scan(&active); err != nil {
				t.Fatal(err)
			}
			if pending != 1 || active != 2 {
				t.Fatalf("confirmed transcription pending=%d items=%d", pending, active)
			}
		})
	}
}

// An older persisted failure can still contain an unknown ASR result even
// when its dependent item only says transcription_failed.
func TestAITranslationActivityRetryPreservesUnknownSpeechResult(t *testing.T) {
	f, response, _ := queuedTranslationFromSpeech(t)
	if _, err := f.db.Exec("UPDATE asr_transcription SET state='failed', failure_code=? WHERE workflow_run_id=?", asrResultUnknown, response.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE translation_item SET state='failed', failure_code=CASE WHEN engine='asr' THEN ? ELSE 'transcription_failed' END WHERE workflow_run_id=?", asrResultUnknown, response.RunID); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.retryAITranslationRun(context.Background(), actor, response.RunID); !errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		t.Fatalf("Activity retry=%v", err)
	}
	var failed int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM translation_item WHERE workflow_run_id=? AND state='failed'", response.RunID).Scan(&failed); err != nil {
		t.Fatal(err)
	}
	if failed != 2 {
		t.Fatalf("retry changed unknown items: failed=%d", failed)
	}
}

func TestAITranslationProjectsPersistedUnknownSpeechFailuresForConfirmation(t *testing.T) {
	for _, code := range []string{asrResultUnknown, "cancelled_result_unknown"} {
		t.Run(code, func(t *testing.T) {
			f, response, _ := queuedTranslationFromSpeech(t)
			if _, err := f.db.Exec("UPDATE asr_transcription SET state='failed', failure_code=? WHERE workflow_run_id=?", code, response.RunID); err != nil {
				t.Fatal(err)
			}
			for _, state := range []string{"failed", "ready", "accepted", "queued"} {
				if _, err := f.db.Exec("UPDATE translation_item SET state=?, failure_code=CASE WHEN engine='asr' THEN ? ELSE 'transcription_failed' END WHERE workflow_run_id=?", state, code, response.RunID); err != nil {
					t.Fatal(err)
				}
				items, err := f.server.translationItemResponses(context.Background(), "item.workflow_run_id = ?", response.RunID)
				if err != nil || len(items) != 2 {
					t.Fatalf("items=%+v error=%v", items, err)
				}
				for _, item := range items {
					want := state
					if state == "failed" {
						want = "uncertain"
						if item.FailureCode != code {
							t.Fatalf("unknown reason=%q, want %q", item.FailureCode, code)
						}
					}
					if item.State != want {
						t.Fatalf("projected state=%q, want %q", item.State, want)
					}
				}
				var stored int
				if err := f.db.QueryRow("SELECT COUNT(*) FROM translation_item WHERE workflow_run_id=? AND state=?", response.RunID, state).Scan(&stored); err != nil || stored != 2 {
					t.Fatalf("projection changed stored state: count=%d error=%v", stored, err)
				}
			}
		})
	}
}

func TestAITranslationActivityRetryRequiresNewRequestForInvalidatedSource(t *testing.T) {
	f, response, _ := queuedTranslationFromSpeech(t)
	if _, err := f.db.Exec("UPDATE asr_transcription SET state='failed', failure_code='source_changed' WHERE workflow_run_id=?", response.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE translation_item SET state='failed', failure_code=CASE WHEN engine='asr' THEN 'source_changed' ELSE 'transcription_failed' END WHERE workflow_run_id=?", response.RunID); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.retryAITranslationRun(context.Background(), actor, response.RunID); !errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		t.Fatalf("Activity retry=%v", err)
	}
}

func TestAITranslationActivityRetryKeepsFinishedResult(t *testing.T) {
	f, response, requests := queuedTranslationFromSpeech(t)
	ctx := context.Background()
	if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	sent := requests.Load()
	var result string
	if err := f.db.QueryRow("SELECT result_text FROM translation_item WHERE workflow_run_id=? AND engine='llm'", response.RunID).Scan(&result); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE translation_item SET state='failed', failure_code='accept_failed' WHERE workflow_run_id=? AND engine='llm'", response.RunID); err != nil {
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
	if err := f.db.QueryRow("SELECT state, result_text FROM translation_item WHERE workflow_run_id=? AND engine='llm'", response.RunID).Scan(&state, &kept); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || kept != result || requests.Load() != sent || f.requests.Load() != 1 {
		t.Fatalf("state=%s result preserved=%v speech requests=%d translations=%d", state, kept == result, f.requests.Load(), requests.Load())
	}
}
