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

// The precheck assesses lyrics as a whole, so a blocked phrase split across
// two chunks is still found.
func TestLLMTextLyricsPrecheckAssessesTheWholeInput(t *testing.T) {
	for _, scenario := range []string{"success", "cross_chunk_block"} {
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
		})
	}
}
