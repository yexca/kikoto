package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

// prefixingLLM answers every translation request with each supplied value
// prefixed by the target language, keeping the request's keys and counts.
func prefixingLLM(t *testing.T, requests *atomic.Int32) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var body struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		data, _ := io.ReadAll(r.Body)
		if json.Unmarshal(data, &body) != nil || len(body.Messages) != 2 {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		language := strings.TrimSuffix(strings.Fields(body.Messages[0].Content)[5], ".")
		var input llm.Text
		if json.Unmarshal([]byte(body.Messages[1].Content), &input) != nil {
			http.Error(w, "unexpected input", http.StatusBadRequest)
			return
		}
		prefix := func(value string) string { return language + ": " + value }
		output := llm.Text{}
		if input.Title != "" {
			output.Title = prefix(input.Title)
		}
		if input.Description != "" {
			output.Description = prefix(input.Description)
		}
		for _, value := range input.Tags {
			output.Tags = append(output.Tags, prefix(value))
		}
		for _, value := range input.Lyrics {
			output.Lyrics = append(output.Lyrics, prefix(value))
		}
		content, _ := json.Marshal(output)
		answer, _ := json.Marshal(map[string]any{"choices": []map[string]any{{"message": map[string]string{"content": string(content)}}}})
		_, _ = w.Write(answer)
	}))
	t.Cleanup(server.Close)
	return server
}

func translationActor(t *testing.T, server *Server, userID int64) currentUser {
	t.Helper()
	actor, err := server.accountStore.LoadByID(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return actor
}

func translationItemStates(t *testing.T, f manualOverrideFixture) map[string]string {
	t.Helper()
	rows, err := f.db.Query("SELECT language || ':' || category || ':' || subject, state FROM translation_item")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	states := map[string]string{}
	for rows.Next() {
		var key, state string
		if err := rows.Scan(&key, &state); err != nil {
			t.Fatal(err)
		}
		states[key] = state
	}
	return states
}

// disableAutoAccept keeps finished items waiting for review.
func disableAutoAccept(t *testing.T, db interface {
	Exec(string, ...any) (sql.Result, error)
}) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO app_setting(key, value_json) VALUES(?, '{\"autoAccept\":false}')", translationSettingKey); err != nil {
		t.Fatal(err)
	}
}

func TestAITranslationTranslatesOnlyWhatIsMissingAndSharesItsReview(t *testing.T) {
	var requests atomic.Int32
	upstream := prefixingLLM(t, &requests)
	f := newManualOverrideFixture(t, config.Config{})
	disableAutoAccept(t, f.db)
	ctx := context.Background()
	if _, err := f.db.Exec("UPDATE work SET age_rating = 'general', description = 'Example description' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	provider := llmTestProvider(t, f, upstream.URL, "external", "safe")
	// A manual English title counts as present.
	if _, err := f.db.Exec(`INSERT INTO work_manual_override(work_id, field_name, language, value_json) VALUES (?, 'title', 'en-us', '"Example English title"')`, f.workID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('second-reviewer', 'Example Reviewer', 'admin')"); err != nil {
		t.Fatal(err)
	}
	var reviewerID int64
	if err := f.db.QueryRow("SELECT id FROM user_account WHERE username = 'second-reviewer'").Scan(&reviewerID); err != nil {
		t.Fatal(err)
	}
	requester := translationActor(t, f.server, f.userID)
	request := aiTranslationRequest{Languages: []string{"zh-cn", "en-us"}, Categories: []string{"title", "description"}, ProviderID: provider.ID}
	response, err := f.server.submitAITranslation(ctx, requester, f.workID, request)
	if err != nil {
		t.Fatal(err)
	}
	if response.Items != 3 {
		t.Fatalf("items = %d, want title and description in Chinese and the English description", response.Items)
	}
	// Queued items are not missing, so a second request has nothing to do.
	if _, err := f.server.submitAITranslation(ctx, requester, f.workID, request); err == nil || !strings.Contains(err.Error(), "already has a value") {
		t.Fatalf("repeated request = %v", err)
	}
	if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if got := requests.Load(); got != 2 {
		t.Fatalf("requests = %d, want one per language", got)
	}
	states := translationItemStates(t, f)
	for _, key := range []string{"zh-cn:title:", "zh-cn:description:", "en-us:description:"} {
		if states[key] != "ready" {
			t.Fatalf("%s = %q (%v)", key, states[key], states)
		}
	}
	var runStatus string
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", response.RunID).Scan(&runStatus); err != nil || runStatus != "succeeded" {
		t.Fatalf("run = %q %v", runStatus, err)
	}

	// Any reviewer accepts; the second acceptance of the same item settles nothing.
	var titleID, descriptionID int64
	if err := f.db.QueryRow("SELECT id FROM translation_item WHERE language = 'zh-cn' AND category = 'title'").Scan(&titleID); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow("SELECT id FROM translation_item WHERE language = 'en-us' AND category = 'description'").Scan(&descriptionID); err != nil {
		t.Fatal(err)
	}
	reviewer := translationActor(t, f.server, reviewerID)
	if code, err := f.server.acceptTranslationItem(ctx, reviewer, titleID); code != "" || err != nil {
		t.Fatalf("accept = %q %v", code, err)
	}
	if code, err := f.server.acceptTranslationItem(ctx, requester, titleID); code != "already_handled" || err != nil {
		t.Fatalf("second accept = %q %v", code, err)
	}
	var value string
	if err := f.db.QueryRow("SELECT value_text FROM work_llm_translation WHERE work_id = ? AND language = 'zh-cn' AND field_name = 'title' AND status = 'accepted'", f.workID).Scan(&value); err != nil || value != "zh-cn: Example Work" {
		t.Fatalf("accepted title = %q %v", value, err)
	}
	if code, err := f.server.rejectTranslationItem(ctx, reviewer, descriptionID); code != "" || err != nil {
		t.Fatalf("reject = %q %v", code, err)
	}
	plan, err := f.server.planAITranslation(ctx, requester, f.workID, []string{"zh-cn", "en-us"})
	if err != nil {
		t.Fatal(err)
	}
	if zh := plan.Languages[0]; zh.Title.Missing != 0 || zh.Title.Active != 0 || zh.Description.Active != 1 {
		t.Fatalf("Chinese plan = %+v", zh)
	}
	// A rejected translation leaves the description missing again.
	if en := plan.Languages[1]; en.Title.Missing != 0 || en.Description.Missing != 1 {
		t.Fatalf("English plan = %+v", en)
	}
}

func TestAITranslationRefusesAcceptanceAfterTheSourceChanged(t *testing.T) {
	var requests atomic.Int32
	upstream := prefixingLLM(t, &requests)
	f := newManualOverrideFixture(t, config.Config{})
	disableAutoAccept(t, f.db)
	ctx := context.Background()
	if _, err := f.db.Exec("UPDATE work SET age_rating = 'general' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	provider := llmTestProvider(t, f, upstream.URL, "external", "safe")
	actor := translationActor(t, f.server, f.userID)
	if _, err := f.server.submitAITranslation(ctx, actor, f.workID, aiTranslationRequest{Languages: []string{"ko-kr"}, Categories: []string{"title"}, ProviderID: provider.ID}); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := f.db.QueryRow("SELECT id FROM translation_item WHERE state = 'ready'").Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE work SET title = 'Changed example title' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	if code, err := f.server.acceptTranslationItem(ctx, actor, id); code != "source_changed" || err != nil {
		t.Fatalf("accept = %q %v", code, err)
	}
	var state string
	if err := f.db.QueryRow("SELECT state FROM translation_item WHERE id = ?", id).Scan(&state); err != nil || state != "invalid" {
		t.Fatalf("state = %q %v", state, err)
	}
}

func TestAITranslationCancelledRunStopsUnsentItems(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{})
	ctx := context.Background()
	if _, err := f.db.Exec("UPDATE work SET age_rating = 'general' WHERE id = ?", f.workID); err != nil {
		t.Fatal(err)
	}
	provider := llmTestProvider(t, f, "https://example.invalid", "external", "safe")
	actor := translationActor(t, f.server, f.userID)
	response, err := f.server.submitAITranslation(ctx, actor, f.workID, aiTranslationRequest{Languages: []string{"zh-tw"}, Categories: []string{"title"}, ProviderID: provider.ID})
	if err != nil {
		t.Fatal(err)
	}
	r := llmTestRequest(f, "POST", "")
	r.SetPathValue("id", jsonNumber(response.RunID))
	r = r.WithContext(context.WithValue(ctx, currentUserKey, actor))
	w := httptest.NewRecorder()
	f.server.cancelWorkflowRun(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if states := translationItemStates(t, f); states["zh-tw:title:"] != "cancelled" {
		t.Fatalf("states = %v", states)
	}
	// A cancelled item is missing again.
	if _, err := f.server.submitAITranslation(ctx, actor, f.workID, aiTranslationRequest{Languages: []string{"zh-tw"}, Categories: []string{"title"}, ProviderID: provider.ID}); err != nil {
		t.Fatalf("request after cancellation = %v", err)
	}
}

// newTranslationASRFixture adds a Japanese original edition and an LLM
// provider to the speech fixture.
func newTranslationASRFixture(t *testing.T) (asrFixture, llm.Provider, *atomic.Int32) {
	t.Helper()
	fixture := newASRFixture(t, 2)
	for _, statement := range []string{
		"INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, ?, 'RJ00000001')",
		"INSERT INTO work_edition (work_id, logical_work_id, primary_code, metadata_language, is_canonical) VALUES (?, 1, 'RJ00000001', 'JPN', 1)",
	} {
		if _, err := fixture.db.Exec(statement, fixture.workID); err != nil {
			t.Fatal(err)
		}
	}
	requests := &atomic.Int32{}
	upstream := prefixingLLM(t, requests)
	provider, err := fixture.server.llmStore.Mutate(context.Background(), "", llm.Provider{PresetID: "custom-openai", BaseURL: upstream.URL, Boundary: "external", MaxContentClass: "safe", Enabled: true, EnabledModels: []string{"example-llm"}}, nil, false)
	if err != nil {
		t.Fatal(err)
	}
	return fixture, provider, requests
}

func TestAITranslationTranscribesOnceThenTranslatesAndPublishesBoth(t *testing.T) {
	fixture, provider, requests := newTranslationASRFixture(t)
	disableAutoAccept(t, fixture.db)
	ctx := context.Background()
	actor := translationActor(t, fixture.server, fixture.userID)
	response, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{
		Languages: []string{"zh-cn", "en-us"}, ProviderID: provider.ID, ASRProviderID: fixture.provider.ID, DirectASR: true,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: fixture.audioID, TargetLanguage: "zh-cn"}, {AudioMediaItemID: fixture.audioID, TargetLanguage: "en-us"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	// The original transcription and one translation per language.
	if response.Items != 3 {
		t.Fatalf("items = %d %+v", response.Items, response.Skipped)
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if fixture.requests.Load() != 1 || requests.Load() != 2 {
		t.Fatalf("speech requests = %d, translation requests = %d", fixture.requests.Load(), requests.Load())
	}
	var chinese int64
	var result string
	if err := fixture.db.QueryRow("SELECT id, result_text FROM translation_item WHERE language = 'zh-cn' AND engine = 'llm' AND state = 'ready'").Scan(&chinese, &result); err != nil {
		t.Fatal(err)
	}
	// The translation names both models, as its own first cue, and never
	// sends the transcript's attribution.
	want := "WEBVTT\n\n00:00:00.000 --> 00:00:00.500\n当前歌词由 example-model 生成，example-llm 翻译\n\n00:00:00.500 --> 00:00:01.500\nzh-cn: Synthetic line\n"
	if result != want {
		t.Fatalf("translation = %q", result)
	}
	if code, err := fixture.server.acceptTranslationItem(ctx, actor, chinese); code != "" || err != nil {
		t.Fatalf("accept = %q %v", code, err)
	}
	folder := filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_kikoto")
	original, err := os.ReadFile(filepath.Join(folder, "ja", "mp3", "Track1.vtt"))
	if err != nil || !strings.Contains(string(original), "この歌詞は example-model によって生成されました") || !strings.Contains(string(original), "\nSynthetic line\n") {
		t.Fatalf("original = %q %v", original, err)
	}
	translated, err := os.ReadFile(filepath.Join(folder, "zh-hans", "mp3", "Track1.vtt"))
	if err != nil || string(translated) != want {
		t.Fatalf("translated = %q %v", translated, err)
	}
	var sources int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_lyrics_ai_source WHERE asr_model = 'example-model'").Scan(&sources); err != nil || sources != 2 {
		t.Fatalf("AI sources = %d %v", sources, err)
	}

	// Discarding the transcription discards what was translated from it.
	var transcript, english int64
	if err := fixture.db.QueryRow("SELECT id FROM translation_item WHERE engine = 'asr'").Scan(&transcript); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT id FROM translation_item WHERE language = 'en-us'").Scan(&english); err != nil {
		t.Fatal(err)
	}
	if code, err := fixture.server.rejectTranslationItem(ctx, actor, transcript); code != "already_handled" || err != nil {
		t.Fatalf("rejecting an accepted transcription = %q %v", code, err)
	}
	if _, err := fixture.db.Exec("UPDATE translation_item SET state = 'ready' WHERE id = ?", transcript); err != nil {
		t.Fatal(err)
	}
	if code, err := fixture.server.rejectTranslationItem(ctx, actor, transcript); code != "" || err != nil {
		t.Fatalf("reject = %q %v", code, err)
	}
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM translation_item WHERE id = ?", english).Scan(&state); err != nil || state != "rejected" {
		t.Fatalf("dependent = %q %v", state, err)
	}
}

func TestAITranslationKeepsATranscriptWhosePolicyBlocksTranslation(t *testing.T) {
	fixture, provider, requests := newTranslationASRFixture(t)
	ctx := context.Background()
	policy := llm.DefaultPolicy()
	policy.Keywords = []llm.KeywordRule{{ID: "example-rule", Term: "Synthetic", Fields: []string{"lyrics"}, Action: "blocked"}}
	if err := fixture.server.llmStore.SavePolicy(ctx, policy); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, fixture.server, fixture.userID)
	if _, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{
		Languages: []string{"ko-kr"}, ProviderID: provider.ID, ASRProviderID: fixture.provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: fixture.audioID, TargetLanguage: "ko-kr"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 0 {
		t.Fatal("a blocked transcript reached the translation provider")
	}
	var asrState, llmState string
	if err := fixture.db.QueryRow("SELECT state FROM translation_item WHERE engine = 'asr'").Scan(&asrState); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT state FROM translation_item WHERE engine = 'llm'").Scan(&llmState); err != nil {
		t.Fatal(err)
	}
	// The transcription becomes the original lyrics either way.
	if asrState != "accepted" || llmState != "policy_blocked" {
		t.Fatalf("transcript = %s, translation = %s", asrState, llmState)
	}
}

func TestAITranslationTranslatesDisplayNamesAndSkipsNumberedOnes(t *testing.T) {
	fixture, provider, requests := newTranslationASRFixture(t)
	ctx := context.Background()
	folder := filepath.Join(fixture.dataRoot, "RJ00000001", "mp3")
	audio, err := os.ReadFile(filepath.Join(folder, "Track1.wav"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "Example opening.wav"), audio, 0o644); err != nil {
		t.Fatal(err)
	}
	var fileSourceID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE work_id = ?", fixture.workID).Scan(&fileSourceID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.indexLocalMediaForWork(ctx, fixture.workID, fileSourceID, fixture.root); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, fixture.server, fixture.userID)
	plan, err := fixture.server.planAITranslation(ctx, actor, fixture.workID, []string{"zh-cn"})
	if err != nil {
		t.Fatal(err)
	}
	// "mp3" and "Track1" hold only numbering, so only one name is missing.
	if files := plan.Languages[0].Files; files.Missing != 1 || files.Skipped != 2 {
		t.Fatalf("plan = %+v", files)
	}
	// Real names are already in the original language.
	if _, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{Languages: []string{"ja-jp"}, Categories: []string{"files"}, ProviderID: provider.ID}); err == nil {
		t.Fatal("names were translated into their own language")
	}
	if _, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{Languages: []string{"zh-cn"}, Categories: []string{"files"}, ProviderID: provider.ID}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests = %d", requests.Load())
	}
	// The finished name applies at once.
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM translation_item WHERE category = 'file_name'").Scan(&state); err != nil || state != "accepted" {
		t.Fatalf("state = %q %v", state, err)
	}
	mediaWorkID, err := fixture.server.resolveMediaWorkIDForRequest(ctx, fixture.workID)
	if err != nil {
		t.Fatal(err)
	}
	names, err := fixture.server.loadFileDisplayNames(ctx, fixture.workID, mediaWorkID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, file := range names.Files {
		if file.Path == "mp3/Example opening.wav" {
			found = file.Names["zh-cn"] == "zh-cn: Example opening" && len(file.LLMLanguages) == 1 && file.LLMLanguages[0] == "zh-cn"
		}
	}
	if !found {
		t.Fatalf("names = %+v", names.Files)
	}
}

func TestAITranslationAppliesFinishedItemsAndResendsOneThatCouldNotApply(t *testing.T) {
	fixture, provider, requests := newTranslationASRFixture(t)
	ctx := context.Background()
	// A file where the Simplified Chinese lyrics folder belongs stops that
	// language's lyrics from being written.
	workRoot := filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root))
	ownLyricsRoot(t, workRoot)
	blocker := filepath.Join(workRoot, "lyrics_kikoto", "zh-hans")
	if err := os.WriteFile(blocker, []byte("example"), 0o644); err != nil {
		t.Fatal(err)
	}
	actor := translationActor(t, fixture.server, fixture.userID)
	if _, err := fixture.server.submitAITranslation(ctx, actor, fixture.workID, aiTranslationRequest{
		Languages: []string{"zh-cn"}, Categories: []string{"title"}, ProviderID: provider.ID, ASRProviderID: fixture.provider.ID,
		Lyrics: []aiLyricsTarget{{AudioMediaItemID: fixture.audioID, TargetLanguage: "zh-cn"}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	rows, err := fixture.db.Query("SELECT language || ':' || category || ':' || engine, state || ':' || failure_code FROM translation_item")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var key, state string
		if err := rows.Scan(&key, &state); err != nil {
			t.Fatal(err)
		}
		states[key] = state
	}
	_ = rows.Close()
	// The title and the original lyrics apply; the blocked lyrics fail with the reason and keep their result.
	if states["zh-cn:title:llm"] != "accepted:" || states["ja-jp:lyrics:asr"] != "accepted:" || states["zh-cn:lyrics:llm"] != "failed:lyrics_folder_blocked" {
		t.Fatalf("states = %v", states)
	}
	var title string
	if err := fixture.db.QueryRow("SELECT value_text FROM work_llm_translation WHERE work_id = ? AND language = 'zh-cn' AND field_name = 'title'", fixture.workID).Scan(&title); err != nil || title == "" {
		t.Fatalf("title = %q %v", title, err)
	}
	if _, err := os.Stat(filepath.Join(workRoot, "lyrics_kikoto", "ja", "mp3", "Track1.vtt")); err != nil {
		t.Fatalf("original lyrics: %v", err)
	}
	sent := requests.Load()
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := fixture.db.QueryRow("SELECT id FROM translation_item WHERE language = 'zh-cn' AND category = 'lyrics'").Scan(&id); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(translationReviewRequest{IDs: []int64{id}})
	request := httptest.NewRequest(http.MethodPost, "/api/translation/items/resend", strings.NewReader(string(body)))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	fixture.server.resendTranslationItems(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("resend = %d %s", response.Code, response.Body.String())
	}
	// Sending it again applies the kept result without another request.
	if requests.Load() != sent {
		t.Fatalf("requests = %d, want %d", requests.Load(), sent)
	}
	translated, err := os.ReadFile(filepath.Join(workRoot, "lyrics_kikoto", "zh-hans", "mp3", "Track1.vtt"))
	if err != nil || !strings.Contains(string(translated), "zh-cn: Synthetic line") {
		t.Fatalf("translated = %q %v", translated, err)
	}
	var appliedPath string
	if err := fixture.db.QueryRow("SELECT json_extract(detail_json, '$.appliedPath') FROM translation_item WHERE id = ?", id).Scan(&appliedPath); err != nil || !strings.HasSuffix(appliedPath, "lyrics_kikoto/zh-hans/mp3/Track1.vtt") {
		t.Fatalf("applied path = %q %v", appliedPath, err)
	}
}
