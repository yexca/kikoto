package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/llm"
)

func TestLLMTextLyricsAssessesWholeInputAndRechecksModeBetweenChunks(t *testing.T) {
	for _, scenario := range []string{"success", "cross_chunk_block", "mode_changed"} {
		t.Run(scenario, func(t *testing.T) {
			f := newLyricsFetchFixture(t, func(w http.ResponseWriter, r *http.Request) {}, func(origin string) string { return origin + "/example.vtt" })
			if _, err := f.db.Exec("INSERT INTO user_account(username,role) VALUES('synthetic-admin','admin')"); err != nil {
				t.Fatal(err)
			}
			var userID, sourceID int64
			if err := f.db.QueryRow("SELECT id FROM user_account WHERE username='synthetic-admin'").Scan(&userID); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE id=?", f.folderID).Scan(&sourceID); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.Exec("UPDATE work SET age_rating='r15',description='synthetic marker' WHERE id=?", f.workID); err != nil {
				t.Fatal(err)
			}
			lines := make([]string, llm.LyricsChunkLines+1)
			for i := range lines {
				lines[i] = "Example line"
			}
			if scenario == "cross_chunk_block" {
				lines[llm.LyricsChunkLines-1], lines[llm.LyricsChunkLines] = "synthetic", "marker"
			}
			relative := filepath.ToSlash(filepath.Join(f.root, "example.txt"))
			if err := os.WriteFile(filepath.Join(f.dataRoot, filepath.FromSlash(relative)), []byte(strings.Join(lines, "\n")), 0o644); err != nil {
				t.Fatal(err)
			}
			item, err := f.db.Exec("INSERT INTO media_item(work_id,kind,title,fingerprint) VALUES(?,'text','Example lyrics','synthetic-text-lyrics')", f.workID)
			if err != nil {
				t.Fatal(err)
			}
			itemID, _ := item.LastInsertId()
			location, err := f.db.Exec("INSERT INTO media_file_location(media_item_id,file_source_id,location_type,path,availability) VALUES(?,?,'local',?,'available')", itemID, sourceID, relative)
			if err != nil {
				t.Fatal(err)
			}
			locationID, _ := location.LastInsertId()
			policy := llm.Policy{LLMTranslationTextOnly: true, Keywords: []llm.KeywordRule{
				{ID: "metadata-block", Term: "synthetic marker", Fields: []string{"description"}, Action: "blocked"},
				{ID: "lyrics-block", Term: "synthetic marker", Fields: []string{"lyrics"}, Action: "blocked"},
			}}
			if err := f.server.llmStore.SavePolicy(context.Background(), policy); err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				var request struct {
					Messages []struct {
						Content string `json:"content"`
					} `json:"messages"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil || len(request.Messages) != 2 {
					t.Errorf("invalid request: %+v %v", request, err)
					w.WriteHeader(400)
					return
				}
				if scenario == "mode_changed" {
					changed := policy
					changed.LLMTranslationTextOnly = false
					if err := f.server.llmStore.SavePolicy(r.Context(), changed); err != nil {
						t.Error(err)
					}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": request.Messages[1].Content}}}})
			}))
			defer upstream.Close()
			fixture := manualOverrideFixture{db: f.db, server: f.server, userID: userID, workID: f.workID}
			provider := llmTestProvider(t, fixture, upstream.URL, "external", "safe")
			payload := llmTranslatePayload{ProviderID: provider.ID, Target: "ja-jp", Fields: []string{"lyrics"}, LyricsLocationID: locationID, AudioMediaItemID: f.audioID}
			body, _ := json.Marshal(payload)
			w := httptest.NewRecorder()
			f.server.precheckLLMWork(w, llmTestRequest(fixture, http.MethodPost, string(body)))
			wantClass := "safe"
			if scenario == "cross_chunk_block" {
				wantClass = "blocked"
			}
			var precheck struct {
				Assessment llm.Assessment `json:"assessment"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &precheck); err != nil || w.Code != 200 || precheck.Assessment.Class != wantClass || requests.Load() != 0 {
				t.Fatalf("precheck: %d %s %v", w.Code, w.Body.String(), err)
			}
			ctx := context.Background()
			runs, err := f.server.enqueueLLMTranslations(ctx, userID, []int64{f.workID}, payload)
			if scenario == "cross_chunk_block" {
				if err == nil || requests.Load() != 0 {
					t.Fatalf("whole input not blocked: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			err = f.server.runNextQueuedWorkflowJob(ctx)
			wantRequests := int32(2)
			if scenario == "mode_changed" {
				wantRequests = 1
			}
			if requests.Load() != wantRequests {
				t.Fatalf("requests=%d, want=%d, err=%v", requests.Load(), wantRequests, err)
			}
			if scenario == "mode_changed" {
				if err == nil {
					t.Fatal("policy change did not stop the next chunk")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var preview string
			if err := f.db.QueryRow("SELECT preview_id FROM llm_translation_task WHERE workflow_run_id=? AND state='ready'", runs[0].RunID).Scan(&preview); err != nil {
				t.Fatal(err)
			}
			w = httptest.NewRecorder()
			f.server.applyLLMTranslation(w, llmTestRequest(fixture, http.MethodPut, `{"previewId":"`+preview+`"}`))
			if w.Code != 200 {
				t.Fatalf("accept lyrics: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
