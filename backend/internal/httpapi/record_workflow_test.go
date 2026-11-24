package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/record"
)

type recordActivityResponse struct {
	Activity struct {
		Scan         *recordRunActivity `json:"scan"`
		Probe        *recordRunActivity `json:"probe"`
		PendingFiles int                `json:"pendingFiles"`
	} `json:"activity"`
}

func (s recordTestServer) activity(t *testing.T) recordActivityResponse {
	t.Helper()
	response := s.get("/api/records", true)
	if response.Code != http.StatusOK {
		t.Fatalf("record root = %d %s", response.Code, response.Body.String())
	}
	var body recordActivityResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func (s recordTestServer) runStatus(t *testing.T, runID int64) string {
	t.Helper()
	var status string
	if err := s.server.db.QueryRow(`SELECT status FROM workflow_run WHERE id = ?`, runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

// A record scan ends once its walk does and leaves the files it found pending
// without queueing their media details. A media details run started by hand
// is a workflow of its own: it gives the executor to work queued meanwhile and
// continues afterwards, and the Records page reads both runs from the root.
func TestRecordScanLeavesMediaDetailsToARunOfTheirOwnThatYieldsToQueuedWork(t *testing.T) {
	ctx := context.Background()
	srv := newRecordTestServer(t)
	s := srv.server
	var calls atomic.Int32
	var laterScan recordScanQueuedResult
	s.recordStore = record.NewStore(s.db, srv.root, record.WithProber(func(context.Context, string) ([]byte, error) {
		if calls.Add(1) == 1 {
			var err error
			if laterScan, err = s.enqueueRecordScan(ctx, 1); err != nil {
				t.Error(err)
			}
		}
		return []byte(`{"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360}],"format":{"duration":"12"}}`), nil
	}))

	scan, err := s.enqueueRecordScan(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if status := srv.runStatus(t, scan.RunID); status != "succeeded" || calls.Load() != 0 {
		t.Fatalf("scan run = %s with %d probes", status, calls.Load())
	}
	activity := srv.activity(t).Activity
	if activity.Scan == nil || activity.Scan.RunID != scan.RunID || activity.Scan.Status != "succeeded" ||
		activity.Probe != nil || activity.PendingFiles != 2 {
		t.Fatalf("activity after the scan = %+v scan %+v probe %+v", activity, activity.Scan, activity.Probe)
	}
	var probeRuns int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?`, recordProbeWorkflowCode).Scan(&probeRuns); err != nil || probeRuns != 0 {
		t.Fatalf("media details runs after the scan = %d, %v", probeRuns, err)
	}

	probe, err := s.enqueueRecordProbe(ctx, workflowRunTrigger{Type: "manual", Reason: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	probeRunID := probe.RunID
	if activity := srv.activity(t).Activity; activity.Probe == nil || activity.Probe.RunID != probeRunID || activity.Probe.Status != "queued" {
		t.Fatalf("activity with the queued run = %+v probe %+v", activity, activity.Probe)
	}

	// The probe yields once the scan queued during it waits.
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if status := srv.runStatus(t, probeRunID); status != "queued" || laterScan.RunID == 0 {
		t.Fatalf("probe run after queued work = %s, later scan %+v", status, laterScan)
	}
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if status := srv.runStatus(t, laterScan.RunID); status != "succeeded" {
		t.Fatalf("scan queued during the probe = %s", status)
	}
	if _, err := s.db.Exec(`UPDATE workflow_job SET available_at = NULL WHERE worker_type = ?`, recordProbeWorkerType); err != nil {
		t.Fatal(err)
	}
	if err := s.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	if status := srv.runStatus(t, probeRunID); status != "succeeded" {
		t.Fatalf("resumed probe run = %s", status)
	}
	var summary struct {
		Probed int `json:"probed"`
	}
	var summaryJSON string
	if err := s.db.QueryRow(`SELECT summary_json FROM workflow_run WHERE id = ?`, probeRunID).Scan(&summaryJSON); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(summaryJSON), &summary); err != nil || summary.Probed != 2 || calls.Load() != 2 {
		t.Fatalf("probe summary = %s, %d probes", summaryJSON, calls.Load())
	}
	if activity := srv.activity(t).Activity; activity.Probe != nil || activity.PendingFiles != 0 {
		t.Fatalf("activity after the probe = %+v probe %+v", activity, activity.Probe)
	}
}

// The Record scan is a system workflow from startup, so Workflows can filter
// by it before the first scan, and a scan runs under that same definition.
func TestRecordScanDefinitionExistsBeforeTheFirstScan(t *testing.T) {
	ctx := context.Background()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(ctx); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	var scope string
	if err := db.QueryRowContext(ctx, `SELECT id, scope FROM workflow_definition WHERE code = ?`, recordScanWorkflowCode).Scan(&definitionID, &scope); err != nil {
		t.Fatalf("record scan definition after startup: %v", err)
	}
	if scope != "system" {
		t.Fatalf("record scan definition scope = %q, want system", scope)
	}

	queued, err := server.enqueueRecordScan(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	var runDefinitionID int64
	if err := db.QueryRowContext(ctx, `SELECT workflow_definition_id FROM workflow_run WHERE id = ?`, queued.RunID).Scan(&runDefinitionID); err != nil {
		t.Fatal(err)
	}
	if runDefinitionID != definitionID {
		t.Fatalf("record scan run definition = %d, want %d", runDefinitionID, definitionID)
	}
}

// Workflows starts media details by hand; a second request while one is
// queued answers with that run instead of queueing another.
func TestRecordProbeStartedByHandReusesTheQueuedRun(t *testing.T) {
	srv := newRecordTestServer(t)
	queue := func() recordProbeQueuedResult {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/records/probes", nil)
		request.AddCookie(srv.cookie)
		response := httptest.NewRecorder()
		srv.handler.ServeHTTP(response, request)
		var result recordProbeQueuedResult
		if response.Code != http.StatusAccepted || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.RunID == 0 {
			t.Fatalf("queue probe = %d %s", response.Code, response.Body.String())
		}
		return result
	}
	first := queue()
	second := queue()
	if first.Existing || !second.Existing || second.RunID != first.RunID {
		t.Fatalf("first %+v, second %+v", first, second)
	}
	var triggerType string
	if err := srv.server.db.QueryRow(`SELECT trigger_type FROM workflow_run WHERE id = ?`, first.RunID).Scan(&triggerType); err != nil {
		t.Fatal(err)
	}
	if triggerType != "manual" {
		t.Fatalf("probe trigger = %q, want manual", triggerType)
	}
}
