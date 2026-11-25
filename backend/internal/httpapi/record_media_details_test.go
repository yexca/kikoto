package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// A Record scan Startup trigger scans at startup, and the media details After
// trigger reads the files that scan found new; a scan that finds nothing new
// starts no read. Automating either needs library:write, media details takes
// no Startup trigger, and while Record is off the scan trigger queues nothing.
func TestRecordScanStartupAndMediaDetailsAfterTriggers(t *testing.T) {
	ctx := context.Background()
	srv := newRecordTestServer(t)
	s := srv.server
	srv.withRecordProber()
	ownerID := insertWorkflowGraphAPIUser(t, s.db, "record-trigger-owner")
	if err := s.ensureSystemWorkflowDefinitions(ctx); err != nil {
		t.Fatal(err)
	}
	definitionID := func(code string) int64 {
		var id int64
		if err := s.db.QueryRow("SELECT id FROM workflow_definition WHERE code = ?", code).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	scanDefinition, detailsDefinition := definitionID(recordScanWorkflowCode), definitionID(recordProbeWorkflowCode)
	create := func(definition int64, triggerType, schedule string, permissions ...string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{
			"workflowDefinitionId": definition, "displayName": "Record trigger", "triggerType": triggerType,
			"enabled": true, "scheduleJson": schedule, "configJson": "{}",
		})
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-triggers", strings.NewReader(string(body)))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: ownerID, Permissions: permissions}))
		response := httptest.NewRecorder()
		s.createWorkflowTrigger(response, request)
		return response
	}
	const afterScan = `{"after":"record_library_scan"}`
	if response := create(scanDefinition, "startup", "{}", "workflows:run", "metadata:sync"); response.Code == http.StatusCreated {
		t.Fatalf("a Record scan trigger without library:write was created: %s", response.Body.String())
	}
	if response := create(detailsDefinition, "startup", "{}", "workflows:run", "library:write"); response.Code == http.StatusCreated {
		t.Fatalf("media details took a Startup trigger: %s", response.Body.String())
	}
	if response := create(scanDefinition, "startup", "{}", "workflows:run", "library:write"); response.Code != http.StatusCreated {
		t.Fatalf("Record scan Startup trigger = %d %s", response.Code, response.Body.String())
	}
	if response := create(detailsDefinition, "after_workflow", afterScan, "workflows:run", "library:write"); response.Code != http.StatusCreated {
		t.Fatalf("media details After trigger = %d %s", response.Code, response.Body.String())
	}
	// Only these triggers start anything, so each queued job is one of theirs.
	if _, err := s.db.Exec("DELETE FROM workflow_trigger WHERE workflow_definition_id NOT IN (?, ?)", scanDefinition, detailsDefinition); err != nil {
		t.Fatal(err)
	}
	// The fixture's own scan read nothing, so the media details are read once
	// by hand; the next scan then finds only the new file pending.
	if _, err := s.recordStore.ProbePending(ctx, record.ProbeOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srv.root, "trip", "Day 3.mp4"), []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	countRuns := func(code string) int {
		var runs int
		if err := s.db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", code).Scan(&runs); err != nil {
			t.Fatal(err)
		}
		return runs
	}

	if err := s.dispatchStartupSystemWorkflowTriggers(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	var detailsRunID int64
	var detailsTriggerType string
	if err := s.db.QueryRow("SELECT id, trigger_type FROM workflow_run WHERE workflow_code = ? AND trigger_id IS NOT NULL", recordProbeWorkflowCode).
		Scan(&detailsRunID, &detailsTriggerType); err != nil || detailsTriggerType != "after_workflow" {
		t.Fatalf("media details after the scan = %s, %v", detailsTriggerType, err)
	}
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if status := srv.runStatus(t, detailsRunID); status != "succeeded" {
		t.Fatalf("media details run = %s", status)
	}
	for _, definition := range []int64{scanDefinition, detailsDefinition} {
		var lastSuccess *string
		if err := s.db.QueryRow("SELECT last_success_at FROM workflow_trigger WHERE workflow_definition_id = ?", definition).Scan(&lastSuccess); err != nil || lastSuccess == nil {
			t.Fatalf("trigger of definition %d last success = %v, %v", definition, lastSuccess, err)
		}
	}

	if err := s.dispatchStartupSystemWorkflowTriggers(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if scans, details := countRuns(recordScanWorkflowCode), countRuns(recordProbeWorkflowCode); scans != 2 || details != 1 {
		t.Fatalf("after a scan that found nothing new: scans %d, media details runs %d", scans, details)
	}

	if _, err := s.db.Exec(`UPDATE app_setting SET value_json = 'false' WHERE key = ?`, recordLibraryEnabledSetting); err != nil {
		t.Fatal(err)
	}
	if err := s.dispatchStartupSystemWorkflowTriggers(ctx); err != nil {
		t.Fatal(err)
	}
	var message string
	if scans := countRuns(recordScanWorkflowCode); scans != 2 {
		t.Fatalf("scans while Record is off = %d", scans)
	}
	if err := s.db.QueryRow("SELECT last_error_message FROM workflow_trigger WHERE workflow_definition_id = ?", scanDefinition).Scan(&message); err != nil || message == "" {
		t.Fatalf("trigger message while Record is off = %q, %v", message, err)
	}
}
