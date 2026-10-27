package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A resend accepted while a later language is in flight must still run, and
// cancellation during that same window must keep the run cancelled.
func TestAITranslationResendWhileAnotherLanguageRuns(t *testing.T) {
	for _, cancel := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancel_%t", cancel), func(t *testing.T) {
			var calls atomic.Int32
			entered, release := make(chan struct{}), make(chan struct{})
			var releaseOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				call := calls.Add(1)
				if call == 1 {
					http.Error(w, "Synthetic rejection", http.StatusUnprocessableEntity)
					return
				}
				if call == 2 {
					close(entered)
					<-release
				}
				_, _ = fmt.Fprintf(w, `{"choices":[{"message":{"content":"{\"title\":\"Example translated title %d\"}"}}]}`, call)
			}))
			t.Cleanup(upstream.Close)
			t.Cleanup(unblock)
			f := newManualOverrideFixture(t, config.Config{})
			disableAutoAccept(t, f.db)
			if _, err := f.db.Exec("UPDATE work SET age_rating='general' WHERE id=?", f.workID); err != nil {
				t.Fatal(err)
			}
			provider := llmTestProvider(t, f, upstream.URL, "external", "safe")
			actor := translationActor(t, f.server, f.userID)
			ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
			defer stop()
			queued, err := f.server.submitAITranslation(ctx, actor, f.workID, aiTranslationRequest{
				Languages: []string{"en-us", "ko-kr"}, Categories: []string{"title"}, ProviderID: provider.ID,
			})
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- f.server.runNextQueuedWorkflowJob(ctx) }()
			select {
			case <-entered:
			case <-ctx.Done():
				t.Fatal("the later language never reached the provider")
			}
			var id int64
			if err := f.db.QueryRow("SELECT id FROM translation_item WHERE workflow_run_id=? AND language='en-us'", queued.RunID).Scan(&id); err != nil {
				t.Fatal(err)
			}
			if result := resendTranslation(t, asrFixture{db: f.db, server: f.server, userID: f.userID}, id, false); !result.OK {
				t.Fatalf("resend=%+v", result)
			}
			if cancel {
				actor.Permissions = append(actor.Permissions, "workflows:run")
				r := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/"+jsonNumber(queued.RunID)+"/cancel", nil)
				r.SetPathValue("id", jsonNumber(queued.RunID))
				r = r.WithContext(context.WithValue(ctx, currentUserKey, actor))
				w := httptest.NewRecorder()
				f.server.cancelWorkflowRun(w, r)
				if w.Code != http.StatusOK {
					t.Fatalf("cancel=%d %s", w.Code, w.Body.String())
				}
			}
			unblock()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			var status string
			if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id=?", queued.RunID).Scan(&status); err != nil {
				t.Fatal(err)
			}
			if cancel {
				if status != "cancelled" || calls.Load() != 2 {
					t.Fatalf("cancelled run revived: status=%s requests=%d", status, calls.Load())
				}
				return
			}
			if status != "queued" {
				t.Fatalf("accepted resend is stranded: run=%s", status)
			}
			// Make the scheduled continuation due without waiting on wall time.
			if _, err := f.db.Exec("UPDATE workflow_job SET available_at=CURRENT_TIMESTAMP WHERE workflow_run_id=?", queued.RunID); err != nil {
				t.Fatal(err)
			}
			if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			var ready int
			var laterResult string
			if err := f.db.QueryRow("SELECT COUNT(*) FROM translation_item WHERE workflow_run_id=? AND state='ready'", queued.RunID).Scan(&ready); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow("SELECT result_text FROM translation_item WHERE workflow_run_id=? AND language='ko-kr'", queued.RunID).Scan(&laterResult); err != nil {
				t.Fatal(err)
			}
			if ready != 2 || calls.Load() != 3 || laterResult != "Example translated title 2" {
				t.Fatalf("ready=%d requests=%d completed result=%q", ready, calls.Load(), laterResult)
			}
		})
	}
}

func TestAITranslationSettlementKeepsUnfinishedRequestUnknown(t *testing.T) {
	f, response, _ := queuedLyricsTranslation(t)
	ctx := context.Background()
	job, claimed, err := f.server.claimNextQueuedWorkflowJob(ctx, "translation-settlement-test")
	if err != nil || !claimed {
		t.Fatalf("claim=%v error=%v", claimed, err)
	}
	if _, err := f.db.Exec("UPDATE translation_item SET state='requesting' WHERE workflow_run_id=?", response.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.finishAITranslationJob(ctx, job); err != nil {
		t.Fatal(err)
	}
	var state, code, status string
	if err := f.db.QueryRow("SELECT state, failure_code FROM translation_item WHERE workflow_run_id=?", response.RunID).Scan(&state, &code); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id=?", response.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if state != "uncertain" || code != "upstream_result_unknown" || status != "failed" {
		t.Fatalf("unsettled request=%s/%s run=%s", state, code, status)
	}
}
