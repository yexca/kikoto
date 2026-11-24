package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/record"
)

const recordDetailsVideoProbe = `{"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360}],"format":{"duration":"12"}}`

// withRecordProber gives the fixture's store a prober that answers every file
// as a twelve-second video and counts its calls.
func (s recordTestServer) withRecordProber() *atomic.Int32 {
	calls := &atomic.Int32{}
	s.server.recordStore = record.NewStore(s.server.db, s.root, record.WithProber(func(context.Context, string) ([]byte, error) {
		calls.Add(1)
		return []byte(recordDetailsVideoProbe), nil
	}))
	return calls
}

func (s recordTestServer) listingDetails(t *testing.T, query string) (pending int, durations map[string]*float64) {
	t.Helper()
	response := s.get("/api/records/tree"+query, true)
	if response.Code != http.StatusOK {
		t.Fatalf("record tree %q = %d %s", query, response.Code, response.Body.String())
	}
	var body struct {
		MediaDetailsPending int `json:"mediaDetailsPending"`
		Sections            map[string]struct {
			Items []struct {
				Name            string   `json:"name"`
				DurationSeconds *float64 `json:"durationSeconds"`
			} `json:"items"`
		} `json:"sections"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	durations = map[string]*float64{}
	for _, item := range body.Sections["videos"].Items {
		durations[item.Name] = item.DurationSeconds
	}
	return body.MediaDetailsPending, durations
}

func (s recordTestServer) waitForRecordMediaDetails(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		details := &s.server.recordMediaDetails
		details.mu.Lock()
		running := details.running
		details.mu.Unlock()
		if !running {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("record media details did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Opening a folder reads the media details of its pending files behind the
// response and says how many are pending; the next listing shows them. A
// folder that lists no such files reads nothing.
func TestOpeningARecordFolderReadsItsPendingMediaDetails(t *testing.T) {
	srv := newRecordTestServer(t)
	calls := srv.withRecordProber()

	if pending, _ := srv.listingDetails(t, ""); pending != 0 {
		t.Fatalf("root listing pending = %d, want 0", pending)
	}
	srv.waitForRecordMediaDetails(t)
	if calls.Load() != 0 {
		t.Fatalf("the root listing read %d files", calls.Load())
	}

	var folderID int64
	if err := srv.server.db.QueryRow(`SELECT id FROM record_folder WHERE name = 'trip'`).Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	query := "?folderId=" + strconv.FormatInt(folderID, 10)
	pending, durations := srv.listingDetails(t, query)
	if pending != 2 || durations["Day 1.mp4"] != nil {
		t.Fatalf("first listing pending = %d, durations %v", pending, durations)
	}
	srv.waitForRecordMediaDetails(t)
	pending, durations = srv.listingDetails(t, query)
	if pending != 0 || durations["Day 1.mp4"] == nil || *durations["Day 1.mp4"] != 12 || durations["Day 2.mp4"] == nil {
		t.Fatalf("listing after the read pending = %d, durations %v", pending, durations)
	}
	if calls.Load() != 2 {
		t.Fatalf("probe calls = %d, want 2", calls.Load())
	}
}

// A startup trigger queues the whole-library media details run, which records
// its outcome on the trigger. Automating it needs library:write, and while
// Record is off the trigger queues nothing.
func TestRecordMediaDetailsStartupTriggerQueuesARunAndRecordsItsOutcome(t *testing.T) {
	ctx := context.Background()
	srv := newRecordTestServer(t)
	s := srv.server
	srv.withRecordProber()
	ownerID := insertWorkflowGraphAPIUser(t, s.db, "record-details-owner")
	if err := s.ensureSystemWorkflowDefinitions(ctx); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := s.db.QueryRow("SELECT id FROM workflow_definition WHERE code = ?", recordProbeWorkflowCode).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	create := func(permissions ...string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"workflowDefinitionId":%d,"displayName":"Media details on startup","triggerType":"startup","enabled":true,"configJson":"{}"}`, definitionID)
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: permissions}))
		response := httptest.NewRecorder()
		s.createWorkflowTrigger(response, request)
		return response
	}
	if response := create("workflows:run", "metadata:sync"); response.Code == http.StatusCreated {
		t.Fatalf("a trigger without library:write was created: %s", response.Body.String())
	}
	if response := create("workflows:run", "library:write"); response.Code != http.StatusCreated {
		t.Fatalf("startup trigger = %d %s", response.Code, response.Body.String())
	}
	// Only this trigger starts anything, so the next queued job is its run.
	if _, err := s.db.Exec("DELETE FROM workflow_trigger WHERE workflow_definition_id <> ?", definitionID); err != nil {
		t.Fatal(err)
	}
	if err := s.dispatchStartupSystemWorkflowTriggers(ctx); err != nil {
		t.Fatal(err)
	}
	var runID int64
	if err := s.db.QueryRow("SELECT id FROM workflow_run WHERE workflow_code = ? AND trigger_id IS NOT NULL", recordProbeWorkflowCode).Scan(&runID); err != nil {
		t.Fatalf("startup run: %v", err)
	}
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if status := srv.runStatus(t, runID); status != "succeeded" {
		t.Fatalf("startup run = %s", status)
	}
	var lastSuccess *string
	if err := s.db.QueryRow("SELECT last_success_at FROM workflow_trigger WHERE workflow_definition_id = ?", definitionID).Scan(&lastSuccess); err != nil || lastSuccess == nil {
		t.Fatalf("trigger last success = %v, %v", lastSuccess, err)
	}

	if _, err := s.db.Exec(`UPDATE app_setting SET value_json = 'false' WHERE key = ?`, recordLibraryEnabledSetting); err != nil {
		t.Fatal(err)
	}
	if err := s.dispatchStartupSystemWorkflowTriggers(ctx); err != nil {
		t.Fatal(err)
	}
	var runs int
	var message string
	if err := s.db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", recordProbeWorkflowCode).Scan(&runs); err != nil || runs != 1 {
		t.Fatalf("runs while Record is off = %d, %v", runs, err)
	}
	if err := s.db.QueryRow("SELECT last_error_message FROM workflow_trigger WHERE workflow_definition_id = ?", definitionID).Scan(&message); err != nil || message == "" {
		t.Fatalf("trigger message while Record is off = %q, %v", message, err)
	}
}
