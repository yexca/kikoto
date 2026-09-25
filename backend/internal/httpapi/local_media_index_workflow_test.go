package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

type localMediaIndexFixture struct {
	db       *sql.DB
	server   *Server
	sourceID int64
	root     string
}

func newLocalMediaIndexFixture(t *testing.T) localMediaIndexFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	root := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
	if err := server.EnsureLocalSource(context.Background()); err != nil {
		t.Fatal(err)
	}
	var sourceID int64
	if err := db.QueryRow("SELECT id FROM file_source WHERE code = 'main_local_library'").Scan(&sourceID); err != nil {
		t.Fatal(err)
	}
	return localMediaIndexFixture{db: db, server: server, sourceID: sourceID, root: root}
}

// addWork creates a discovered local work folder with one track and a local
// presence whose file tree is either already scanned or not.
func (f localMediaIndexFixture) addWork(t *testing.T, code string, availability string, scanned bool) int64 {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(f.root, code), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.root, code, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := f.db.Exec("INSERT INTO work (primary_code, work_type, title) VALUES (?, 'audio', 'Synthetic local work')", code)
	if err != nil {
		t.Fatal(err)
	}
	workID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	rawJSON := "{}"
	if scanned {
		rawJSON = `{"file_tree_scanned":true}`
	}
	if _, err := f.db.Exec(`
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability, raw_json)
		VALUES (?, ?, 'local', ?, ?, ?)
	`, workID, f.sourceID, code, availability, rawJSON); err != nil {
		t.Fatal(err)
	}
	return workID
}

func (f localMediaIndexFixture) localMediaCount(t *testing.T, workID int64) int {
	t.Helper()
	var count int
	if err := f.db.QueryRow(`
		SELECT COUNT(*)
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
	`, workID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (f localMediaIndexFixture) runQueued(t *testing.T, runID int64) map[string]any {
	t.Helper()
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, summaryJSON string
	if err := f.db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", runID).Scan(&status, &summaryJSON); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" {
		t.Fatalf("run %d status = %s, summary %s", runID, status, summaryJSON)
	}
	var summary map[string]any
	if err := json.Unmarshal([]byte(summaryJSON), &summary); err != nil {
		t.Fatal(err)
	}
	return summary
}

func TestLocalMediaIndexIncrementalIndexesOnlyUnscannedWorksAndFullIndexesAll(t *testing.T) {
	fixture := newLocalMediaIndexFixture(t)
	unscanned := fixture.addWork(t, "RJ00000010", "available", false)
	scanned := fixture.addWork(t, "RJ00000011", "available", true)
	missing := fixture.addWork(t, "RJ00000012", "missing", false)
	trigger := workflowRunTrigger{Type: "manual", Reason: "manual"}

	incremental, err := fixture.server.enqueueLocalMediaIndex(context.Background(), trigger, localMediaIndexModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	summary := fixture.runQueued(t, incremental.RunID)
	if summary["selected_works"] != float64(1) || summary["indexed_works"] != float64(1) {
		t.Fatalf("incremental summary = %#v, want one selected and indexed work", summary)
	}
	if fixture.localMediaCount(t, unscanned) != 1 || fixture.localMediaCount(t, scanned) != 0 || fixture.localMediaCount(t, missing) != 0 {
		t.Fatal("incremental run must index only the available unscanned work")
	}

	full, err := fixture.server.enqueueLocalMediaIndex(context.Background(), trigger, localMediaIndexModeFull)
	if err != nil {
		t.Fatal(err)
	}
	summary = fixture.runQueued(t, full.RunID)
	if summary["selected_works"] != float64(2) || summary["indexed_works"] != float64(2) {
		t.Fatalf("full summary = %#v, want both available works", summary)
	}
	if fixture.localMediaCount(t, scanned) != 1 || fixture.localMediaCount(t, missing) != 0 {
		t.Fatal("full run must index every available work folder, including scanned ones")
	}
}

func TestLocalMediaIndexKeepsOneActiveRunAndRetryKeepsMode(t *testing.T) {
	fixture := newLocalMediaIndexFixture(t)
	trigger := workflowRunTrigger{Type: "manual", Reason: "manual"}
	first, err := fixture.server.enqueueLocalMediaIndex(context.Background(), trigger, localMediaIndexModeFull)
	if err != nil {
		t.Fatal(err)
	}
	second, err := fixture.server.enqueueLocalMediaIndex(context.Background(), trigger, localMediaIndexModeIncremental)
	if err != nil {
		t.Fatal(err)
	}
	if !second.Existing || second.RunID != first.RunID || second.Mode != localMediaIndexModeFull {
		t.Fatalf("second enqueue = %#v, want the queued full run %d", second, first.RunID)
	}

	if _, err := fixture.db.Exec("UPDATE workflow_run SET status = 'failed' WHERE id = ?", first.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET status = 'failed' WHERE workflow_run_id = ?", first.RunID); err != nil {
		t.Fatal(err)
	}
	actor := currentUser{ID: 1, Permissions: []string{"workflows:run", "metadata:sync"}}
	run, err := fixture.server.loadWorkflowRun(context.Background(), first.RunID)
	if err != nil {
		t.Fatal(err)
	}
	retried, err := fixture.server.dispatchWorkflowRetry(context.Background(), actor, run, first.RunID)
	if err != nil {
		t.Fatal(err)
	}
	var inputJSON string
	if err := fixture.db.QueryRow("SELECT input_json FROM workflow_run WHERE id = ?", retried.NewRunID).Scan(&inputJSON); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(inputJSON, `"mode":"full"`) {
		t.Fatalf("retried run input = %s, want full mode", inputJSON)
	}
}

func TestCreateLocalMediaIndexRunValidatesMode(t *testing.T) {
	fixture := newLocalMediaIndexFixture(t)
	actor := account.User{ID: 1, Permissions: []string{"workflows:run", "metadata:sync"}}
	post := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/local-media-index", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
		response := httptest.NewRecorder()
		fixture.server.createLocalMediaIndexRun(response, request)
		return response
	}
	if response := post(`{"mode":"everything"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode response = %d, want 400", response.Code)
	}
	response := post("")
	if response.Code != http.StatusAccepted {
		t.Fatalf("default mode response = %d, %s", response.Code, response.Body.String())
	}
	var result localMediaIndexQueuedResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Mode != localMediaIndexModeIncremental || result.Existing {
		t.Fatalf("default run = %#v, want a new incremental run", result)
	}
}

func TestLocalMediaIndexStartupTriggerRunsConfiguredMode(t *testing.T) {
	fixture := newLocalMediaIndexFixture(t)
	ownerID := insertWorkflowGraphAPIUser(t, fixture.db, "local-media-index-owner")
	if err := fixture.server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := fixture.db.QueryRow("SELECT id FROM workflow_definition WHERE code = ?", localMediaIndexWorkflowCode).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"workflowDefinitionId":%d,"displayName":"Refresh on startup","triggerType":"startup","enabled":true,"configJson":"{\"mode\":\"full\"}"}`, definitionID)
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: []string{"workflows:run", "metadata:sync"}}))
	response := httptest.NewRecorder()
	fixture.server.createWorkflowTrigger(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("startup trigger response = %d, %s", response.Code, response.Body.String())
	}
	if err := fixture.server.dispatchStartupSystemWorkflowTriggers(context.Background()); err != nil {
		t.Fatal(err)
	}
	var inputJSON string
	if err := fixture.db.QueryRow("SELECT input_json FROM workflow_run WHERE workflow_code = ? AND trigger_id IS NOT NULL", localMediaIndexWorkflowCode).Scan(&inputJSON); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(inputJSON, `"mode":"full"`) {
		t.Fatalf("startup run input = %s, want full mode", inputJSON)
	}
}
