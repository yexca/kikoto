package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestAITranslationTagAcceptanceUsesItsTransaction(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	if _, err := f.db.Exec("UPDATE work SET age_rating = 'general' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	provider := llmTestProvider(t, f, "https://source.example.invalid", "external", "safe")
	actor := translationActor(t, f.server, f.userID)
	result, err := f.db.Exec("INSERT INTO tag(namespace, normalized_name, display_name) VALUES('metadata', 'example tag', 'Example Tag')")
	if err != nil {
		t.Fatal(err)
	}
	tagID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("INSERT INTO metadata_tag(tag_id) VALUES(?)", tagID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("INSERT INTO work_tag(work_id, tag_id) VALUES(?, ?)", f.workID, tagID); err != nil {
		t.Fatal(err)
	}
	queued, err := f.server.submitAITranslation(context.Background(), actor, f.workID, aiTranslationRequest{
		Languages: []string{"en-us"}, Categories: []string{"tags"}, ProviderID: provider.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	var itemID int64
	if err := f.db.QueryRow("SELECT id FROM translation_item WHERE workflow_run_id = ? AND category = 'tag'", queued.RunID).Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE translation_item SET state = 'ready', result_text = 'Example translated tag' WHERE id = ?", itemID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if code, err := f.server.acceptTranslationItem(ctx, actor, itemID); code != "" || err != nil {
		t.Fatalf("accept tag on the single-connection database: %q %v", code, err)
	}
	var state, name string
	if err := f.db.QueryRow("SELECT state FROM translation_item WHERE id = ?", itemID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow("SELECT name FROM metadata_tag_llm_name WHERE tag_id = ? AND language = 'en-us'", tagID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || name != "Example translated tag" {
		t.Fatalf("accepted item = %s, tag = %q", state, name)
	}
}

func translationAccessRequest(actor currentUser, id int64) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/translation/runs/"+jsonNumber(id)+"/cancel", nil)
	r.SetPathValue("id", jsonNumber(id))
	return r.WithContext(context.WithValue(r.Context(), currentUserKey, actor))
}

func insertTranslationAccessRun(t *testing.T, f manualOverrideFixture, code, status string, requesterID int64) int64 {
	t.Helper()
	result, err := f.db.Exec(`INSERT INTO workflow_run(workflow_code, display_name, status, trigger_type, input_json)
		VALUES(?, 'Example translation run', ?, 'manual', ?)`, code, status,
		mustJSON(map[string]any{workflowRunRequesterKey: requesterID, "work_id": f.workID}))
	if err != nil {
		t.Fatal(err)
	}
	runID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("INSERT INTO workflow_job(workflow_run_id, worker_type, status) VALUES(?, ?, ?)", runID, code, status); err != nil {
		t.Fatal(err)
	}
	return runID
}

func TestAITranslationCancellationEnforcesFeatureAndOwnership(t *testing.T) {
	for _, tc := range []struct {
		name, code, status string
		own, administrator bool
		permissions        []string
		want               int
	}{
		{name: "own queued translation", code: aiTranslationWorkflowCode, status: "queued", own: true, want: http.StatusOK},
		{name: "own running translation", code: aiTranslationWorkflowCode, status: "running", own: true, want: http.StatusOK},
		{name: "another translator", code: aiTranslationWorkflowCode, status: "running", want: http.StatusForbidden},
		{name: "workflow administrator", code: aiTranslationWorkflowCode, status: "running", administrator: true, want: http.StatusOK},
		{name: "unrelated workflow", code: "local_library_scan", status: "queued", own: true, want: http.StatusNotFound},
		{name: "finished translation", code: aiTranslationWorkflowCode, status: "succeeded", own: true, want: http.StatusConflict},
		{name: "read only", code: aiTranslationWorkflowCode, status: "queued", own: true, permissions: []string{"library:read"}, want: http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newManualOverrideFixture(t, config.Config{})
			if _, err := f.db.Exec("INSERT INTO user_account(username, display_name, role) VALUES('second-translator', 'Example Translator', 'user')"); err != nil {
				t.Fatal(err)
			}
			var otherID int64
			if err := f.db.QueryRow("SELECT id FROM user_account WHERE username = 'second-translator'").Scan(&otherID); err != nil {
				t.Fatal(err)
			}
			owner := otherID
			if tc.own {
				owner = f.userID
			}
			runID := insertTranslationAccessRun(t, f, tc.code, tc.status, owner)
			actor := currentUser{ID: f.userID, Permissions: []string{"library:write"}}
			if tc.permissions != nil {
				actor.Permissions = tc.permissions
			}
			if tc.administrator {
				actor.Permissions = append(actor.Permissions, "sources:write")
			}
			response := httptest.NewRecorder()
			f.server.cancelAITranslationRun(response, translationAccessRequest(actor, runID))
			if response.Code != tc.want {
				t.Fatalf("cancel = %d %s, want %d", response.Code, response.Body.String(), tc.want)
			}
			var runStatus, jobStatus string
			if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&runStatus); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow("SELECT status FROM workflow_job WHERE workflow_run_id = ?", runID).Scan(&jobStatus); err != nil {
				t.Fatal(err)
			}
			wantStatus := tc.status
			if tc.want == http.StatusOK {
				wantStatus = "cancelled"
			}
			if runStatus != wantStatus || jobStatus != wantStatus {
				t.Fatalf("run/job = %s/%s, want %s", runStatus, jobStatus, wantStatus)
			}
		})
	}
}

func TestAITranslationCancellationRejectsAnonymousAndDemo(t *testing.T) {
	for _, mode := range []config.Mode{"", config.ModeDemo} {
		f := newManualOverrideFixture(t, config.Config{Mode: mode})
		runID := insertTranslationAccessRun(t, f, aiTranslationWorkflowCode, "queued", f.userID)
		r := httptest.NewRequest(http.MethodPost, "/api/translation/runs/"+jsonNumber(runID)+"/cancel", nil)
		r.SetPathValue("id", jsonNumber(runID))
		want := http.StatusUnauthorized
		if mode == config.ModeDemo {
			r = translationAccessRequest(currentUser{ID: f.userID, Permissions: []string{"system:admin"}}, runID)
			want = http.StatusForbidden
		}
		response := httptest.NewRecorder()
		f.server.cancelAITranslationRun(response, r)
		if response.Code != want {
			t.Fatalf("mode %q cancel = %d %s, want %d", mode, response.Code, response.Body.String(), want)
		}
		var state string
		if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&state); err != nil || state != "queued" {
			t.Fatalf("run = %q %v", state, err)
		}
	}
}

func TestAITranslationPermissionDoesNotGrantGeneralWorkflowCancellation(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	runID := insertTranslationAccessRun(t, f, aiTranslationWorkflowCode, "queued", f.userID)
	actor := currentUser{ID: f.userID, Permissions: []string{"library:write"}}
	response := httptest.NewRecorder()
	f.server.cancelWorkflowRun(response, translationAccessRequest(actor, runID))
	if response.Code != http.StatusForbidden {
		t.Fatalf("general workflow cancellation = %d %s", response.Code, response.Body.String())
	}
	var state string
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&state); err != nil || state != "queued" {
		t.Fatalf("run = %q %v", state, err)
	}
}

func TestAITranslationRunListReportsCancellationPermission(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	actor := currentUser{ID: f.userID, Permissions: []string{"library:write"}}
	if _, err := f.db.Exec("INSERT INTO user_account(username, display_name, role) VALUES('other-translator', 'Example Translator', 'user')"); err != nil {
		t.Fatal(err)
	}
	var otherID int64
	if err := f.db.QueryRow("SELECT id FROM user_account WHERE username = 'other-translator'").Scan(&otherID); err != nil {
		t.Fatal(err)
	}
	own := insertTranslationAccessRun(t, f, aiTranslationWorkflowCode, "queued", f.userID)
	other := insertTranslationAccessRun(t, f, aiTranslationWorkflowCode, "queued", otherID)
	for _, administrator := range []bool{false, true} {
		viewer := actor
		if administrator {
			viewer.Permissions = append([]string{"sources:write"}, actor.Permissions...)
		}
		r := httptest.NewRequest(http.MethodGet, "/api/translation/runs?view=queued", nil)
		r = r.WithContext(context.WithValue(r.Context(), currentUserKey, viewer))
		response := httptest.NewRecorder()
		f.server.listTranslationRuns(response, r)
		var body struct {
			Runs []translationRunResponse `json:"runs"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil {
			t.Fatalf("list = %d %s", response.Code, response.Body.String())
		}
		if len(body.Runs) != 2 {
			t.Fatalf("runs = %+v", body.Runs)
		}
		for _, run := range body.Runs {
			if want := administrator || run.RunID == own; run.CanCancel != want {
				t.Errorf("run %d canCancel = %v, want %v (other run %d)", run.RunID, run.CanCancel, want, other)
			}
		}
	}
}

func TestAITranslationCancellationKeepsInFlightASRUnknown(t *testing.T) {
	f, provider, _ := newTranslationASRFixture(t)
	actor := translationActor(t, f.server, f.userID)
	queued, err := f.server.submitAITranslation(context.Background(), actor, f.workID, aiTranslationRequest{
		Languages: []string{"en-us"}, Categories: []string{"title"}, ProviderID: provider.ID, ASRProviderID: f.provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: f.audioID, TargetLanguage: "en-us"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE asr_transcription SET state = 'requesting' WHERE workflow_run_id = ?", queued.RunID); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	f.server.cancelAITranslationRun(response, translationAccessRequest(actor, queued.RunID))
	if response.Code != http.StatusOK {
		t.Fatalf("cancel = %d %s", response.Code, response.Body.String())
	}
	rows, err := f.db.Query("SELECT category, state, failure_code FROM translation_item WHERE workflow_run_id = ?", queued.RunID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var category, state, failure string
		if err := rows.Scan(&category, &state, &failure); err != nil {
			t.Fatal(err)
		}
		wantState, wantCode := "cancelled", "cancelled"
		if category == translationLyrics {
			wantState, wantCode = "uncertain", "cancelled_result_unknown"
		}
		if state != wantState || failure != wantCode {
			t.Errorf("%s = %s/%s, want %s/%s", category, state, failure, wantState, wantCode)
		}
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	var state, failure string
	if err := f.db.QueryRow("SELECT state, failure_code FROM asr_transcription WHERE workflow_run_id = ?", queued.RunID).Scan(&state, &failure); err != nil {
		t.Fatal(err)
	}
	if state != "cancelled" || failure != "cancelled_result_unknown" {
		t.Fatalf("transcription = %s/%s", state, failure)
	}
}
