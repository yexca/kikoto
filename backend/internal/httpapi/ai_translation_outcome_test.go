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
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

// translationAddNamedFile adds a file with a translatable name beside the
// fixture's track and returns its media item.
func translationAddNamedFile(t *testing.T, fixture asrFixture) int64 {
	t.Helper()
	folder := filepath.Join(fixture.dataRoot, "RJ00000001", "mp3")
	audio, err := os.ReadFile(filepath.Join(folder, "Track1.wav"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "Example opening.wav"), audio, 0o644); err != nil {
		t.Fatal(err)
	}
	var fileSourceID, itemID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE work_id = ?", fixture.workID).Scan(&fileSourceID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.indexLocalMediaForWork(context.Background(), fixture.workID, fileSourceID, fixture.root); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT media_item_id FROM media_file_location WHERE path LIKE '%/Example opening.wav'").Scan(&itemID); err != nil {
		t.Fatal(err)
	}
	return itemID
}

func translationItemOutcomes(t *testing.T, fixture asrFixture) map[string]string {
	t.Helper()
	rows, err := fixture.db.Query("SELECT language || ':' || category, state || ':' || failure_code FROM translation_item")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	outcomes := map[string]string{}
	for rows.Next() {
		var key, outcome string
		if err := rows.Scan(&key, &outcome); err != nil {
			t.Fatal(err)
		}
		outcomes[key] = outcome
	}
	return outcomes
}

func resendTranslationItemsAs(t *testing.T, server *Server, actor currentUser, ids ...int64) string {
	t.Helper()
	body, _ := json.Marshal(translationReviewRequest{IDs: ids})
	request := httptest.NewRequest(http.MethodPost, "/api/translation/items/resend", strings.NewReader(string(body)))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	server.resendTranslationItems(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("resend = %d %s", response.Code, response.Body.String())
	}
	return response.Body.String()
}

// A display name or lyrics someone set while a run waited is kept, and the
// item says why its result was not applied.
func TestAITranslationKeepsValuesSetWhileARunWaits(t *testing.T) {
	fixture, provider, _ := newTranslationFixture(t)
	ctx := context.Background()
	actor := translationActor(t, fixture.server, fixture.userID)
	fileID := translationAddNamedFile(t, fixture)
	source := translationLyricsFile(t, fixture)
	if _, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{
		Languages: []string{"zh-cn"}, Categories: []string{"files"}, ProviderID: provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: fixture.audioID, TargetLanguage: "zh-cn", LyricsLocationID: source}},
	}); err != nil {
		t.Fatal(err)
	}
	var sourceItemID int64
	if err := fixture.db.QueryRow("SELECT media_item_id FROM media_file_location WHERE id = ?", source).Scan(&sourceItemID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{"INSERT INTO media_item_display_name (media_item_id, language, name) VALUES (?, 'zh-cn', 'Example chosen name')", []any{fileID}},
		{"INSERT INTO media_lyrics_assignment (audio_media_item_id, language, lyrics_media_item_id) VALUES (?, 'zh-cn', ?)", []any{fixture.audioID, sourceItemID}},
	} {
		if _, err := fixture.db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if outcomes := translationItemOutcomes(t, fixture); outcomes["zh-cn:file_name"] != "failed:name_exists" || outcomes["zh-cn:lyrics"] != "failed:lyrics_exist" {
		t.Fatalf("outcomes = %v", outcomes)
	}
	var name string
	var assigned int64
	if err := fixture.db.QueryRow(`SELECT (SELECT name FROM media_item_display_name WHERE media_item_id = ? AND language = 'zh-cn'),
		(SELECT lyrics_media_item_id FROM media_lyrics_assignment WHERE audio_media_item_id = ? AND language = 'zh-cn')`, fileID, fixture.audioID).Scan(&name, &assigned); err != nil {
		t.Fatal(err)
	}
	if name != "Example chosen name" || assigned != sourceItemID {
		t.Fatalf("name = %q, lyrics = %d", name, assigned)
	}
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_kikoto", "zh-hans")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lyrics folder = %v", err)
	}
	var lyricsItem int64
	if err := fixture.db.QueryRow("SELECT id FROM translation_item WHERE category = 'lyrics'").Scan(&lyricsItem); err != nil {
		t.Fatal(err)
	}
	// The object has a value now, so sending the item again is no way to apply it.
	if body := resendTranslationItemsAs(t, fixture.server, actor, lyricsItem); !strings.Contains(body, `"code":"not_resendable"`) {
		t.Fatalf("resend = %s", body)
	}
}

// Resending lyrics whose translated chunks could not be used translates them
// from the first chunk instead of reusing those chunks.
func TestAITranslationResendTranslatesUnusableLyricsAgain(t *testing.T) {
	fixture, provider, requests := newTranslationFixture(t)
	disableAutoAccept(t, fixture.db)
	ctx := context.Background()
	actor := translationActor(t, fixture.server, fixture.userID)
	source := translationLyricsFile(t, fixture)
	if _, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{
		Languages: []string{"zh-cn"}, ProviderID: provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: fixture.audioID, TargetLanguage: "zh-cn", LyricsLocationID: source}},
	}); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := fixture.db.QueryRow("SELECT id FROM translation_item").Scan(&id); err != nil {
		t.Fatal(err)
	}
	// The one chunk came back with lines the file does not have.
	if _, err := fixture.db.Exec(`UPDATE translation_item SET state = 'failed', failure_code = 'invalid_lyrics_output', request_index = 1,
		checkpoint_json = '["Example extra line","Example extra line"]' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if body := resendTranslationItemsAs(t, fixture.server, actor, id); !strings.Contains(body, `"ok":true`) {
		t.Fatalf("resend = %s", body)
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	var state, result string
	if err := fixture.db.QueryRow("SELECT state, result_text FROM translation_item WHERE id = ?", id).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || !strings.Contains(result, "zh-cn: Synthetic line") || requests.Load() != 1 {
		t.Fatalf("state = %s, requests = %d, result = %q", state, requests.Load(), result)
	}
}

// An answer that fails after its run was cancelled keeps the unknown result
// the cancellation recorded, so Activity cannot retry it without the resend
// acknowledgement.
func TestAITranslationCancellationKeepsTheUnknownResultOfAFailedAnswer(t *testing.T) {
	fixture, _, _ := newTranslationFixture(t)
	ctx := context.Background()
	actor := translationActor(t, fixture.server, fixture.userID)
	translationAddNamedFile(t, fixture)
	var runID int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The run's cancellation commits while the request is out, and the
		// answer, a name no file can take, arrives before the job stops.
		tx, err := fixture.db.BeginTx(ctx, nil)
		if err != nil {
			t.Error(err)
			return
		}
		run, err := fixture.server.loadWorkflowRunTx(ctx, tx, runID)
		if err == nil {
			_, err = fixture.server.cancelWorkflowRunTx(ctx, tx, run, runID)
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			_ = tx.Rollback()
			t.Error(err)
		}
		content, _ := json.Marshal(llm.Text{Tags: []string{"Example/name"}})
		answer, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"message": map[string]string{"content": string(content)}}}})
		_, _ = w.Write(answer)
	}))
	defer upstream.Close()
	provider, err := fixture.server.llmStore.Mutate(ctx, "", llm.Provider{PresetID: "custom-openai", BaseURL: upstream.URL, Boundary: "external", MaxContentClass: "safe", Enabled: true, EnabledModels: []string{"example-llm"}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	response, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{Languages: []string{"zh-cn"}, Categories: []string{"files"}, ProviderID: provider.ID})
	if err != nil {
		t.Fatal(err)
	}
	runID = response.RunID
	_ = fixture.server.runNextQueuedWorkflowJob(ctx)
	if outcomes := translationItemOutcomes(t, fixture); outcomes["zh-cn:file_name"] != "uncertain:cancelled_result_unknown" {
		t.Fatalf("outcomes = %v", outcomes)
	}
	if _, err := fixture.server.retryAITranslationRun(ctx, actor, runID); !errors.Is(err, errWorkflowRetryNoRecoverableJob) {
		t.Fatalf("retry = %v", err)
	}
}

// translationRequestFailure records an unknown result only for a request that
// left; a request that never did, or whose answer is unusable, fails.
func TestAITranslationRequestFailuresNameWhetherTheRequestLeft(t *testing.T) {
	for _, check := range []struct {
		err         error
		state, code string
		description string
	}{
		{llm.ErrRequestTooLarge, "failed", "request_too_large", "oversized request"},
		{errors.New("dial tcp: connection refused"), "failed", "endpoint_unavailable", "unreachable provider"},
		{errors.Join(llm.ErrInvalidResult, errors.New("translation must contain a JSON object")), "failed", "invalid_output", "unusable answer"},
		{errors.Join(llm.ErrResultUnknown, errors.New("EOF")), "uncertain", "upstream_result_unknown", "lost answer"},
		{llm.UpstreamError{Status: http.StatusBadGateway}, "uncertain", "upstream_result_unknown", "gateway error"},
		{llm.UpstreamError{Status: http.StatusTooManyRequests}, "failed", "upstream_rejected", "rate limit"},
	} {
		if state, code := translationRequestFailure(check.err); state != check.state || code != check.code {
			t.Errorf("%s = %s/%s, want %s/%s", check.description, state, code, check.state, check.code)
		}
	}
}

// A fallback title or description replaces every language's, so Translate
// with AI does not offer to translate it.
func TestAITranslationLeavesOutTextAFallbackReplaces(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	ctx := context.Background()
	if _, err := f.db.Exec("UPDATE work SET age_rating = 'general', description = 'Example description' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, f.server, f.userID)
	plan, err := f.server.planAITranslation(ctx, actor, f.workID, []string{"en-us"})
	if err != nil {
		t.Fatal(err)
	}
	if en := plan.Languages[0]; en.Title.Missing != 1 || en.Description.Missing != 1 {
		t.Fatalf("plan before = %+v", en)
	}
	for _, field := range []string{"title", "description"} {
		if _, err := f.db.Exec(`INSERT INTO work_manual_override(work_id, field_name, language, value_json) VALUES (?, ?, '', '"Example fallback"')`, f.workID, field); err != nil {
			t.Fatal(err)
		}
	}
	if plan, err = f.server.planAITranslation(ctx, actor, f.workID, []string{"en-us"}); err != nil {
		t.Fatal(err)
	}
	if en := plan.Languages[0]; en.Title.Missing != 0 || en.Description.Missing != 0 {
		t.Fatalf("plan with fallbacks = %+v", en)
	}
}

// Demo translates nothing: its Translation page lists no runs or items
// instead of refusing.
func TestAITranslationDemoListsNothing(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{Mode: config.ModeDemo})
	insertTranslationAccessRun(t, f, aiTranslationWorkflowCode, "queued", f.userID)
	viewer := currentUser{ID: f.userID, Permissions: []string{"library:read"}}
	for path, handler := range map[string]http.HandlerFunc{
		"/api/translation/runs?view=queued":   f.server.listTranslationRuns,
		"/api/translation/items?view=history": f.server.listTranslationItems,
	} {
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r = r.WithContext(context.WithValue(r.Context(), currentUserKey, viewer))
		response := httptest.NewRecorder()
		handler(response, r)
		if response.Code != http.StatusOK || strings.Contains(response.Body.String(), `"runId"`) {
			t.Fatalf("%s = %d %s", path, response.Code, response.Body.String())
		}
	}
}
