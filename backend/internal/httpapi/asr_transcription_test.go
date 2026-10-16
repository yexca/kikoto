package httpapi

import (
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/storagepool"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type asrUpload struct {
	Fields map[string]string
	WAV    []byte
}

type asrFixture struct {
	server   *Server
	db       *sql.DB
	dataRoot string
	root     string
	workID   int64
	audioID  int64
	userID   int64
	provider asr.Provider
	requests *atomic.Int32
	mu       *sync.Mutex
	uploads  *[]asrUpload
}

// newASRFixture scans a local work whose only track is audioSeconds of
// synthetic tone, and configures a private service answering every chunk with
// one segment.
func newASRFixture(t *testing.T, audioSeconds int) asrFixture {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is unavailable")
	}
	fixture := asrFixture{requests: &atomic.Int32{}, mu: &sync.Mutex{}, uploads: &[]asrUpload{}}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.requests.Add(1)
		if r.URL.Path != "/v1/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer synthetic-token" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		if err := r.ParseMultipartForm(64 << 20); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		upload := asrUpload{Fields: map[string]string{}}
		for key, values := range r.MultipartForm.Value {
			upload.Fields[key] = values[0]
		}
		file, _, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		upload.WAV, _ = io.ReadAll(file)
		fixture.mu.Lock()
		*fixture.uploads = append(*fixture.uploads, upload)
		fixture.mu.Unlock()
		_, _ = io.WriteString(w, `{"text":"Synthetic line","language":"japanese","segments":[{"start":0.5,"end":1.5,"text":" Synthetic line"}]}`)
	}))
	t.Cleanup(upstream.Close)

	fixture.dataRoot = t.TempDir()
	audioDir := filepath.Join(fixture.dataRoot, "RJ00000001", "mp3")
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		t.Fatal(err)
	}
	generate := exec.Command(ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000", "-t", jsonNumber(int64(audioSeconds)), "-ac", "1", "-c:a", "pcm_s16le", filepath.Join(audioDir, "Track1.wav"))
	if output, err := generate.CombinedOutput(); err != nil {
		t.Fatalf("generate audio: %v: %s", err, output)
	}
	if err := storagepool.WriteMarker(fixture.dataRoot, "synthetic-library"); err != nil {
		t.Fatal(err)
	}
	fixture.db = openMigratedTestDB(t)
	fixture.server = NewServer(fixture.db, config.Config{DataRoot: fixture.dataRoot, LocalScanDepth: 2})
	executeLocalScanForTest(t, fixture.server)
	ctx := context.Background()
	var fileSourceID int64
	if err := fixture.db.QueryRow(`
		SELECT folder.work_id, folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN work ON work.id = folder.work_id
		WHERE work.primary_code = 'RJ00000001'
	`).Scan(&fixture.workID, &fileSourceID, &fixture.root); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.indexLocalMediaForWork(ctx, fixture.workID, fileSourceID, fixture.root); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT id FROM media_item WHERE work_id = ? AND kind = 'audio'", fixture.workID).Scan(&fixture.audioID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{query: "UPDATE work SET age_rating = 'general' WHERE id = ?", args: []any{fixture.workID}},
		{query: "INSERT INTO user_account (username, display_name, role) VALUES ('asr-test-user', 'Example User', 'admin')"},
	} {
		if _, err := fixture.db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.db.QueryRow("SELECT id FROM user_account WHERE username = 'asr-test-user'").Scan(&fixture.userID); err != nil {
		t.Fatal(err)
	}
	key := "synthetic-token"
	fixture.provider, err = fixture.server.asrStore.Mutate(ctx, "", asr.Provider{PresetID: "local", Scope: asr.ScopeOtherMachine, BaseURL: upstream.URL, Enabled: true, EnabledModels: []string{"example-model"}}, &key, false)
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture asrFixture) request(t *testing.T, method string, target string, body string, pathValues map[string]string) *http.Request {
	t.Helper()
	actor, err := fixture.server.accountStore.LoadByID(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	for key, value := range pathValues {
		request.SetPathValue(key, value)
	}
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
}

func (fixture asrFixture) create(t *testing.T, language string) (*httptest.ResponseRecorder, string, int64) {
	t.Helper()
	body, _ := json.Marshal(asrTranscriptionRequest{AudioMediaItemID: fixture.audioID, ProviderID: fixture.provider.ID, Language: language})
	workID := jsonNumber(fixture.workID)
	response := httptest.NewRecorder()
	fixture.server.createASRTranscription(response, fixture.request(t, http.MethodPost, "/api/works/"+workID+"/asr-transcriptions", string(body), map[string]string{"id": workID}))
	var result struct {
		ID    string `json:"id"`
		RunID int64  `json:"runId"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &result)
	return response, result.ID, result.RunID
}

func (fixture asrFixture) state(t *testing.T, id string) (string, string, int64) {
	t.Helper()
	var state, failure string
	var offset int64
	if err := fixture.db.QueryRow("SELECT state, failure_code, offset_ms FROM asr_transcription WHERE id = ?", id).Scan(&state, &failure, &offset); err != nil {
		t.Fatal(err)
	}
	return state, failure, offset
}

func (fixture asrFixture) accept(t *testing.T, id string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	fixture.server.acceptASRTranscription(response, fixture.request(t, http.MethodPost, "/api/asr/transcriptions/"+id+"/accept", "", map[string]string{"transcription": id}))
	return response
}

func TestASRTranscriptionIsReviewedThenPublishedAsAssignedLyrics(t *testing.T) {
	fixture := newASRFixture(t, 3)
	ctx := context.Background()
	response, id, runID := fixture.create(t, "ja-jp")
	if response.Code != http.StatusAccepted || id == "" {
		t.Fatalf("create = %d %s", response.Code, response.Body.String())
	}
	// A second request for a track already queued joins it.
	repeated, repeatedID, _ := fixture.create(t, "ja-jp")
	if repeated.Code != http.StatusOK || repeatedID != id {
		t.Fatalf("repeat = %d %s", repeated.Code, repeated.Body.String())
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if state, failure, _ := fixture.state(t, id); state != "ready" {
		t.Fatalf("state = %s (%s)", state, failure)
	}
	if fixture.requests.Load() != 1 || len(*fixture.uploads) != 1 {
		t.Fatalf("requests = %d", fixture.requests.Load())
	}
	upload := (*fixture.uploads)[0]
	if upload.Fields["model"] != "example-model" || upload.Fields["response_format"] != "verbose_json" || upload.Fields["language"] != "ja" {
		t.Fatalf("fields = %v", upload.Fields)
	}
	// The upload is a self-consistent 16 kHz mono 16-bit WAV of the track.
	wav := upload.WAV
	if len(wav) < 44 || string(wav[0:4]) != "RIFF" || string(wav[8:12]) != "WAVE" ||
		binary.LittleEndian.Uint32(wav[24:]) != asr.SampleRate || binary.LittleEndian.Uint16(wav[22:]) != 1 ||
		int(binary.LittleEndian.Uint32(wav[40:])) != len(wav)-44 || int(binary.LittleEndian.Uint32(wav[4:])) != len(wav)-8 {
		t.Fatalf("upload is not the expected WAV (%d bytes)", len(wav))
	}
	if seconds := float64(len(wav)-44) / asr.BytesPerSecond; seconds < 2.9 || seconds > 3.1 {
		t.Fatalf("upload holds %.2f s of audio", seconds)
	}
	var runStatus string
	if err := fixture.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&runStatus); err != nil || runStatus != "succeeded" {
		t.Fatalf("run status = %q, %v", runStatus, err)
	}

	text := httptest.NewRecorder()
	fixture.server.asrTranscriptionText(text, fixture.request(t, http.MethodGet, "/api/asr/transcriptions/"+id+"/text", "", map[string]string{"transcription": id}))
	if text.Code != http.StatusOK || text.Body.String() != "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nSynthetic line\n" {
		t.Fatalf("text = %d %q", text.Code, text.Body.String())
	}

	if accepted := fixture.accept(t, id); accepted.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", accepted.Code, accepted.Body.String())
	}
	published, err := os.ReadFile(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_kikoto", "ja", "mp3", "Track1.vtt"))
	if err != nil || string(published) != text.Body.String() {
		t.Fatalf("published = %q, %v", published, err)
	}
	var origin, assignedPath string
	if err := fixture.db.QueryRow(`
		SELECT assignment.origin, location.path
		FROM media_lyrics_assignment AS assignment
		INNER JOIN media_file_location AS location ON location.media_item_id = assignment.lyrics_media_item_id
		WHERE assignment.audio_media_item_id = ? AND assignment.language = 'ja-jp'
	`, fixture.audioID).Scan(&origin, &assignedPath); err != nil {
		t.Fatal(err)
	}
	if origin != "transcription" || assignedPath != fixture.root+"/lyrics_kikoto/ja/mp3/Track1.vtt" {
		t.Fatalf("assignment = %s %s", origin, assignedPath)
	}
	if state, _, _ := fixture.state(t, id); state != "accepted" {
		t.Fatalf("state after accept = %s", state)
	}
	if again := fixture.accept(t, id); again.Code != http.StatusOK {
		t.Fatalf("accepting again = %d", again.Code)
	}
}

func TestASRTranscriptionKeepsAnExistingLyricsFile(t *testing.T) {
	fixture := newASRFixture(t, 2)
	_, id, _ := fixture.create(t, "")
	if err := fixture.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	ownLyricsRoot(t, filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root)))
	folder := filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_kikoto", "fallback", "mp3")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "Track1.vtt"), []byte("WEBVTT\n\nhand-made\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if accepted := fixture.accept(t, id); accepted.Code != http.StatusOK {
		t.Fatalf("accept = %d %s", accepted.Code, accepted.Body.String())
	}
	existing, _ := os.ReadFile(filepath.Join(folder, "Track1.vtt"))
	added, err := os.ReadFile(filepath.Join(folder, "Track1 (2).vtt"))
	if string(existing) != "WEBVTT\n\nhand-made\n" || err != nil || !strings.Contains(string(added), "Synthetic line") {
		t.Fatalf("existing = %q, added = %q, %v", existing, added, err)
	}
}

func TestASRTranscriptionRefusesWhatThePolicyOrLibraryDoesNotAllow(t *testing.T) {
	fixture := newASRFixture(t, 2)
	if _, err := fixture.db.Exec("UPDATE work SET age_rating = '' WHERE id = ?", fixture.workID); err != nil {
		t.Fatal(err)
	}
	if response, _, _ := fixture.create(t, "ja-jp"); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "asr_policy_blocked") {
		t.Fatalf("unknown rating = %d %s", response.Code, response.Body.String())
	}
	if _, err := fixture.db.Exec("UPDATE work SET age_rating = 'adult' WHERE id = ?", fixture.workID); err != nil {
		t.Fatal(err)
	}
	if response, _, _ := fixture.create(t, "ja-jp"); response.Code != http.StatusBadRequest {
		t.Fatalf("sensitive work to a service not allowed to receive it = %d", response.Code)
	}
	if _, err := fixture.server.asrStore.Mutate(context.Background(), fixture.provider.ID, asr.Provider{PresetID: "local", Scope: asr.ScopeOtherMachine, BaseURL: fixture.provider.BaseURL, Boundary: "private", MaxContentClass: "sensitive", Enabled: true, EnabledModels: []string{"example-model"}}, nil, false); err != nil {
		t.Fatal(err)
	}
	if response, _, _ := fixture.create(t, "ja-jp"); response.Code != http.StatusAccepted {
		t.Fatalf("sensitive work to an allowed private service = %d %s", response.Code, response.Body.String())
	}
	if _, err := fixture.db.Exec("UPDATE media_file_location SET availability = 'missing' WHERE media_item_id = ?", fixture.audioID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE asr_transcription SET state = 'cancelled'"); err != nil {
		t.Fatal(err)
	}
	if response, _, _ := fixture.create(t, "ja-jp"); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "asr_audio_unavailable") {
		t.Fatalf("missing audio = %d %s", response.Code, response.Body.String())
	}
	if fixture.requests.Load() != 0 {
		t.Fatal("a refused transcription reached the service")
	}
}

func TestASRPrecheckReportsTheContentClassWithoutStartingWork(t *testing.T) {
	fixture := newASRFixture(t, 2)
	precheck := func(audioID int64) *httptest.ResponseRecorder {
		t.Helper()
		workID := jsonNumber(fixture.workID)
		body, _ := json.Marshal(map[string]int64{"audioMediaItemId": audioID})
		response := httptest.NewRecorder()
		fixture.server.precheckASRTranscription(response, fixture.request(t, http.MethodPost, "/api/works/"+workID+"/asr-precheck", string(body), map[string]string{"id": workID}))
		return response
	}
	for _, rating := range []struct{ age, class string }{{"general", "safe"}, {"adult", "sensitive"}, {"", "unknown"}} {
		if _, err := fixture.db.Exec("UPDATE work SET age_rating = ? WHERE id = ?", rating.age, fixture.workID); err != nil {
			t.Fatal(err)
		}
		response := precheck(fixture.audioID)
		var result struct {
			Class string `json:"class"`
		}
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Class != rating.class {
			t.Fatalf("age %q = %d %s, want class %q", rating.age, response.Code, response.Body.String(), rating.class)
		}
	}
	if _, err := fixture.db.Exec("UPDATE work SET age_rating='general',description='synthetic marker' WHERE id=?", fixture.workID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.llmStore.SavePolicy(context.Background(), llm.Policy{Keywords: []llm.KeywordRule{{ID: "synthetic-high-rule", Term: "synthetic marker", Fields: []string{"description"}, Action: "restricted"}}}); err != nil {
		t.Fatal(err)
	}
	var assessment llm.Assessment
	response := precheck(fixture.audioID)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &assessment) != nil || assessment.Class != "restricted" || len(assessment.Matches) != 1 || assessment.Matches[0].Action != "restricted" {
		t.Fatalf("restricted precheck: %d %s", response.Code, response.Body.String())
	}
	if response := precheck(fixture.audioID + 1000); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "asr_audio_unavailable") {
		t.Fatalf("a track outside the work = %d %s", response.Code, response.Body.String())
	}
	var runs int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM asr_transcription").Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("a precheck created transcriptions: %d %v", runs, err)
	}
	if fixture.requests.Load() != 0 {
		t.Fatal("a precheck reached the service")
	}
}

func TestASRTranscriptionInterruptionsNeverResendSilently(t *testing.T) {
	for _, scenario := range []string{"restart_during_request", "service_changed", "maximum_changed", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newASRFixture(t, 2)
			ctx := context.Background()
			_, id, runID := fixture.create(t, "ja-jp")
			switch scenario {
			case "restart_during_request":
				for _, query := range []string{
					"UPDATE workflow_job SET status = 'running', locked_by = 'old-runner' WHERE workflow_run_id = ?",
					"UPDATE workflow_run SET status = 'running' WHERE id = ?",
					"UPDATE asr_transcription SET state = 'requesting' WHERE workflow_run_id = ?",
				} {
					if _, err := fixture.db.Exec(query, runID); err != nil {
						t.Fatal(err)
					}
				}
				fixture.server = NewServer(fixture.db, fixture.server.cfg)
				if err := fixture.server.RecoverInterruptedWorkflows(ctx); err != nil {
					t.Fatal(err)
				}
			case "maximum_changed":
				provider := fixture.provider
				provider.MaxContentClass = "restricted"
				if _, err := fixture.server.asrStore.Mutate(ctx, provider.ID, provider, nil, false); err != nil {
					t.Fatal(err)
				}
			case "service_changed":
				if _, err := fixture.server.asrStore.Mutate(ctx, fixture.provider.ID, asr.Provider{PresetID: "local", Scope: asr.ScopeOtherMachine, BaseURL: fixture.provider.BaseURL, Enabled: true, EnabledModels: []string{"other-model"}}, nil, false); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				response := httptest.NewRecorder()
				fixture.server.cancelWorkflowRun(response, fixture.request(t, http.MethodPost, "/", "", map[string]string{"id": jsonNumber(runID)}))
				if response.Code != http.StatusOK {
					t.Fatal(response.Body.String())
				}
			}
			_ = fixture.server.runNextQueuedWorkflowJob(ctx)
			if fixture.requests.Load() != 0 {
				t.Fatalf("requests = %d", fixture.requests.Load())
			}
			state, failure, _ := fixture.state(t, id)
			want := map[string]string{"restart_during_request": "failed/upstream_result_unknown", "service_changed": "failed/provider_changed", "maximum_changed": "failed/provider_changed", "cancelled": "cancelled/cancelled"}[scenario]
			if state+"/"+failure != want {
				t.Fatalf("state = %s/%s, want %s", state, failure, want)
			}
			if scenario != "restart_during_request" {
				return
			}
			// Only an explicit retry sends the interrupted chunk again.
			actor, _ := fixture.server.accountStore.LoadByID(ctx, fixture.userID)
			if _, err := fixture.server.retryASRTranscriptionRun(ctx, actor, runID); err != nil {
				t.Fatal(err)
			}
			if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			if state, _, _ := fixture.state(t, id); state != "ready" || fixture.requests.Load() != 1 {
				t.Fatalf("after retry state = %s, requests = %d", state, fixture.requests.Load())
			}
		})
	}
}

func TestASRTranscriptionYieldsBetweenChunksAndResumes(t *testing.T) {
	fixture := newASRFixture(t, asrChunkSeconds+40)
	ctx := context.Background()
	_, id, runID := fixture.create(t, "ja-jp")
	// Another job waiting for the single executor.
	tx, err := fixture.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "example_waiting", "Example waiting work", "", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	otherRun, err := workflow.InsertRun(ctx, tx, definitionID, "example_waiting", "Example waiting work", "queued", "manual", "test", map[string]any{}, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	otherNode, err := workflow.InsertNodeRun(ctx, tx, otherRun, workflow.NodeRunSpec{NodeID: "wait", NodeType: "example_waiting", DisplayName: "Wait", Position: 1, Status: "queued"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := workflow.InsertJob(ctx, tx, otherRun, workflow.JobSpec{NodeRunID: otherNode, WorkerType: "example_waiting", Status: "queued"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	state, _, offset := fixture.state(t, id)
	var jobStatus string
	if err := fixture.db.QueryRow("SELECT status FROM workflow_job WHERE workflow_run_id = ?", runID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	// One chunk, cut in its last minute, then the executor is handed back.
	if state != "pending" || jobStatus != "queued" || fixture.requests.Load() != 1 ||
		offset <= (asrChunkSeconds-asrCutSearchSeconds)*1000 || offset > asrChunkSeconds*1000 {
		t.Fatalf("state = %s, job = %s, requests = %d, offset = %d", state, jobStatus, fixture.requests.Load(), offset)
	}

	if _, err := fixture.db.Exec("UPDATE workflow_job SET status = 'succeeded' WHERE workflow_run_id = ?", otherRun); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET available_at = NULL WHERE workflow_run_id = ?", runID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if state, _, _ := fixture.state(t, id); state != "ready" || fixture.requests.Load() != 2 {
		t.Fatalf("after resume state = %s, requests = %d", state, fixture.requests.Load())
	}
	text := httptest.NewRecorder()
	fixture.server.asrTranscriptionText(text, fixture.request(t, http.MethodGet, "/", "", map[string]string{"transcription": id}))
	// The second chunk's cue sits after the first chunk's audio.
	cues := strings.Split(strings.TrimSpace(text.Body.String()), "\n\n")
	if len(cues) != 3 || !strings.HasPrefix(cues[2], "00:04:") && !strings.HasPrefix(cues[2], "00:05:") {
		t.Fatalf("vtt = %q", text.Body.String())
	}
	var total int
	for _, upload := range *fixture.uploads {
		total += len(upload.WAV) - 44
	}
	if seconds := float64(total) / asr.BytesPerSecond; seconds < float64(asrChunkSeconds+40)-0.2 || seconds > float64(asrChunkSeconds+40)+0.2 {
		t.Fatalf("chunks hold %.2f s of a %d s track", seconds, asrChunkSeconds+40)
	}
}

func TestASRSameMachineServiceIgnoresAnAddressInTheRequest(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{HostProxyHost: "gateway.example.invalid"})
	if _, err := fixture.db.Exec("UPDATE user_account SET role = 'admin' WHERE id = ?", fixture.userID); err != nil {
		t.Fatal(err)
	}
	actor, err := fixture.server.accountStore.LoadByID(context.Background(), fixture.userID)
	if err != nil {
		t.Fatal(err)
	}
	acceptServiceNoticeForTest(t, fixture)
	request := httptest.NewRequest(http.MethodPost, "/api/asr/providers", strings.NewReader(`{"presetId":"local","scope":"local_machine","port":8000,"baseUrl":"http://203.0.113.9:1"}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	fixture.server.saveASRProvider(response, request)
	var saved asrProviderResponse
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil || response.Code != http.StatusOK {
		t.Fatalf("save = %d %s", response.Code, response.Body.String())
	}
	if saved.BaseURL != "http://gateway.example.invalid:8000" || saved.Scope != asr.ScopeLocalMachine || saved.Boundary != "private" {
		t.Fatalf("saved = %+v", saved)
	}
	stored, err := fixture.server.asrStore.Get(context.Background(), saved.ID)
	if err != nil || stored.BaseURL != "" {
		t.Fatalf("stored = %+v, %v", stored, err)
	}
}

func TestASRClientRefusesRedirectsAndUnboundedResponses(t *testing.T) {
	for _, scenario := range []string{"redirect", "declared_limit", "streamed_limit", "timeout"} {
		t.Run(scenario, func(t *testing.T) {
			var forwarded atomic.Int32
			target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { forwarded.Add(1) }))
			defer target.Close()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				switch scenario {
				case "redirect":
					http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
				case "declared_limit":
					w.Header().Set("Content-Length", jsonNumber(asr.ResponseLimit+1))
					w.WriteHeader(http.StatusOK)
				case "streamed_limit":
					_, _ = io.WriteString(w, strings.Repeat("x", asr.ResponseLimit+1))
				case "timeout":
					<-r.Context().Done()
				}
			}))
			defer upstream.Close()
			fixture := newManualOverrideFixture(t, config.Config{})
			provider, err := asr.Normalize(asr.Provider{PresetID: "custom-openai", BaseURL: upstream.URL, APIKey: "synthetic-token"})
			if err != nil {
				t.Fatal(err)
			}
			client, closeClient, err := fixture.server.asrClient(context.Background(), provider, 50*time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			defer closeClient()
			if _, err := client.Transcribe(context.Background(), "example-model", "", make([]byte, asr.BytesPerSecond)); err == nil {
				t.Fatal("unsafe or unbounded response accepted")
			}
			if forwarded.Load() != 0 {
				t.Fatal("a redirect was followed")
			}
		})
	}
}

func TestASRTranscriptionRecordsTheChosenEnabledModel(t *testing.T) {
	fixture := newASRFixture(t, 3)
	provider := fixture.provider
	provider.EnabledModels = []string{"example-model", "second-model"}
	if _, err := fixture.server.asrStore.Mutate(context.Background(), provider.ID, provider, nil, false); err != nil {
		t.Fatal(err)
	}
	create := func(model string) (*httptest.ResponseRecorder, string) {
		body, _ := json.Marshal(asrTranscriptionRequest{AudioMediaItemID: fixture.audioID, ProviderID: provider.ID, Model: model, Language: "ja-jp"})
		workID := jsonNumber(fixture.workID)
		response := httptest.NewRecorder()
		fixture.server.createASRTranscription(response, fixture.request(t, http.MethodPost, "/api/works/"+workID+"/asr-transcriptions", string(body), map[string]string{"id": workID}))
		var result struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &result)
		return response, result.ID
	}
	if response, _ := create("unlisted-model"); response.Code != http.StatusBadRequest {
		t.Fatalf("unlisted model = %d %s", response.Code, response.Body.String())
	}
	response, id := create("second-model")
	if response.Code != http.StatusAccepted {
		t.Fatalf("create = %d %s", response.Code, response.Body.String())
	}
	var model string
	if err := fixture.db.QueryRow("SELECT model FROM asr_transcription WHERE id = ?", id).Scan(&model); err != nil || model != "second-model" {
		t.Fatalf("model = %q, %v", model, err)
	}
}
