package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

func TestDetectedMediaUpsertsReuseExistingRowsWithoutReturningClauses(t *testing.T) {
	db := openMigratedTestDB(t)
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	folder := localfs.WorkFolder{Code: "TEST-WORK-LOCAL-001", Title: "Detected work", RelPath: "TEST-WORK-LOCAL-001"}
	workID, err := upsertDetectedWork(context.Background(), tx, folder)
	if err != nil {
		t.Fatal(err)
	}
	sourceID, err := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2}).upsertLocalFileSource(context.Background(), tx, 2)
	if err != nil {
		t.Fatal(err)
	}
	file := localfs.LocalFile{RelPath: "TEST-WORK-LOCAL-001/track.mp3", WorkRelPath: "track.mp3", Title: "Track", SizeBytes: 100}
	firstItemID, err := upsertDetectedMediaItem(context.Background(), tx, workID, folder, file, "audio", 1)
	if err != nil {
		t.Fatal(err)
	}
	firstLocationID, err := upsertDetectedLocation(context.Background(), tx, firstItemID, sourceID, file)
	if err != nil {
		t.Fatal(err)
	}
	file.Title = "Renamed track"
	file.SizeBytes = 200
	secondItemID, err := upsertDetectedMediaItem(context.Background(), tx, workID, folder, file, "audio", 1)
	if err != nil {
		t.Fatal(err)
	}
	secondLocationID, err := upsertDetectedLocation(context.Background(), tx, secondItemID, sourceID, file)
	if err != nil {
		t.Fatal(err)
	}
	if firstItemID != secondItemID || firstLocationID != secondLocationID {
		t.Fatalf("upsert ids changed: item %d/%d, location %d/%d", firstItemID, secondItemID, firstLocationID, secondLocationID)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	var title string
	var itemSize, locationSize int64
	if err := db.QueryRow("SELECT title, size_bytes FROM media_item WHERE id = ?", firstItemID).Scan(&title, &itemSize); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT size_bytes FROM media_file_location WHERE id = ?", firstLocationID).Scan(&locationSize); err != nil {
		t.Fatal(err)
	}
	if title != "Renamed track" || itemSize != 200 || locationSize != 200 {
		t.Fatalf("updated media = title %q, item size %d, location size %d", title, itemSize, locationSize)
	}
}

func TestLocalLibraryScanDefaultsToLocalPresenceOnly(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	code := "RJ00000011"
	writeDemoScanFile(t, dataRoot, code, "track.mp3", "audio")
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	server.dlsiteClient = &fakeDemoScanDLsiteClient{
		products: map[string]dlsite.Product{
			code: demoScanProduct(code, "Scanned work", "general", nil, nil, nil),
		},
		errors: map[string]error{}, calls: map[string]int{},
	}

	first, err := server.enqueueLocalScan(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.enqueueLocalScan(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "queued" || second.Status != "queued" || first.RunID == second.RunID {
		t.Fatalf("queued local scan results = %#v / %#v", first, second)
	}
	var snapshotCountBefore int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&snapshotCountBefore); err != nil {
		t.Fatal(err)
	}
	if snapshotCountBefore != 0 {
		t.Fatalf("metadata snapshots before worker execution = %d", snapshotCountBefore)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "local-scan-test")
	if err != nil || !ok {
		t.Fatalf("claim local scan job = %#v, %t, %v", job, ok, err)
	}
	if job.RunID != first.RunID || job.WorkerType != "local_library_scan" || job.ResourceKey != "local:scan" {
		t.Fatalf("claimed local scan job = %#v", job)
	}
	// A transaction must use its own connection for every query. Restricting
	// the pool to one connection turns accidental pool re-entry into a
	// deterministic regression instead of a production-only lock cycle.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	executionCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.executeLocalScanJob(executionCtx, job); err != nil {
		t.Fatal(err)
	}

	var runCount, nodeCount, jobCount, snapshotCount, remotePresenceCount, metadataRunCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM workflow_run
		WHERE workflow_code IN ('local_library_scan', 'startup_library_refresh', 'metadata_sync')
	`).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ?", first.RunID).Scan(&nodeCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE workflow_run_id = ?", first.RunID).Scan(&jobCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM metadata_snapshot AS snapshot
		INNER JOIN work ON work.id = snapshot.work_id
		WHERE work.primary_code = ?
	`, code).Scan(&snapshotCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE work.primary_code = ? AND presence.presence_type = ?
	`, code, sourcePresenceTypeRemoteSource).Scan(&remotePresenceCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'metadata_sync'").Scan(&metadataRunCount); err != nil {
		t.Fatal(err)
	}
	var firstStatus, secondStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", first.RunID).Scan(&firstStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", second.RunID).Scan(&secondStatus); err != nil {
		t.Fatal(err)
	}
	if runCount != 2 || nodeCount != 4 || jobCount != 1 || snapshotCount != 0 || remotePresenceCount != 0 || metadataRunCount != 0 || firstStatus != "succeeded" || secondStatus != "queued" {
		t.Fatalf("local-only run counts = runs %d nodes %d jobs %d snapshots %d remote presence %d metadata runs %d", runCount, nodeCount, jobCount, snapshotCount, remotePresenceCount, metadataRunCount)
	}
	if server.dlsiteClient.(*fakeDemoScanDLsiteClient).calls[code] != 0 {
		t.Fatalf("metadata provider calls = %d, want 0", server.dlsiteClient.(*fakeDemoScanDLsiteClient).calls[code])
	}
}

func TestLocalLibraryScanFollowUpQueuesIndependentMetadataRun(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	code := "RJ00000012"
	writeDemoScanFile(t, dataRoot, code, "track.mp3", "audio")
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	client := &fakeDemoScanDLsiteClient{
		products: map[string]dlsite.Product{code: demoScanProduct(code, "Follow-up work", "general", nil, nil, nil)},
		errors:   map[string]error{},
		calls:    map[string]int{},
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	server.dlsiteClient = client

	scan, err := server.enqueueLocalScanWithOptions(context.Background(), "manual", "manual", 0, true)
	if err != nil {
		t.Fatal(err)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "local-scan-follow-up-test")
	if err != nil || !ok || job.RunID != scan.RunID {
		t.Fatalf("claim local scan job = %#v, %t, %v", job, ok, err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := server.executeLocalScanJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	var metadataRunID int64
	var metadataStatus, triggerType, triggerReason, inputJSON string
	if err := db.QueryRow(`
		SELECT id, status, trigger_type, trigger_reason, input_json
		FROM workflow_run
		WHERE workflow_code = 'metadata_sync'
	`).Scan(&metadataRunID, &metadataStatus, &triggerType, &triggerReason, &inputJSON); err != nil {
		t.Fatal(err)
	}
	var metadataInput metadataSyncRunInput
	if err := json.Unmarshal([]byte(inputJSON), &metadataInput); err != nil {
		t.Fatal(err)
	}
	var scanStatus string
	var scanNodes, scanCandidates, snapshotsBefore int
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", scan.RunID).Scan(&scanStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ?", scan.RunID).Scan(&scanNodes); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_candidate WHERE workflow_run_id = ?", scan.RunID).Scan(&scanCandidates); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&snapshotsBefore); err != nil {
		t.Fatal(err)
	}
	if scanStatus != "succeeded" || scanNodes != 4 || scanCandidates != 0 || metadataStatus != "queued" || triggerType != "follow_up" || triggerReason != "local_scan_follow_up" || metadataInput.SourceRunID != scan.RunID || snapshotsBefore != 0 || client.calls[code] != 0 {
		t.Fatalf("separate runs = scan %s/%d nodes/%d candidates, metadata %d %s %s/%s input %#v snapshots %d calls %d", scanStatus, scanNodes, scanCandidates, metadataRunID, metadataStatus, triggerType, triggerReason, metadataInput, snapshotsBefore, client.calls[code])
	}

	metadataJob, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "metadata-follow-up-test")
	if err != nil || !ok || metadataJob.RunID != metadataRunID || metadataJob.WorkerType != "metadata_sync" {
		t.Fatalf("claim metadata follow-up = %#v, %t, %v", metadataJob, ok, err)
	}
	if err := server.executeDLsiteMetadataSyncJob(context.Background(), metadataJob); err != nil {
		t.Fatal(err)
	}
	var snapshotsAfter int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&snapshotsAfter); err != nil {
		t.Fatal(err)
	}
	if snapshotsAfter != 1 || client.calls[code] != 1 {
		t.Fatalf("metadata follow-up = snapshots %d calls %d", snapshotsAfter, client.calls[code])
	}
}

func TestLocalLibraryScanFollowUpCoalescesIntoQueuedMetadataRun(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2})
	scan, err := server.enqueueLocalScanWithOptions(context.Background(), "manual", "manual", 0, true)
	if err != nil {
		t.Fatal(err)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "local-scan-coalesce-test")
	if err != nil || !ok || job.RunID != scan.RunID {
		t.Fatalf("claim local scan job = %#v, %t, %v", job, ok, err)
	}
	existing, err := server.enqueueDLsiteMetadataSync(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if err := server.executeLocalScanJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	var metadataRuns int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'metadata_sync'").Scan(&metadataRuns); err != nil {
		t.Fatal(err)
	}
	var detailJSON string
	if err := db.QueryRow("SELECT detail_json FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'local_library_scan.follow_up_queued'", scan.RunID).Scan(&detailJSON); err != nil {
		t.Fatal(err)
	}
	var detail struct {
		MetadataRunID int64 `json:"metadata_run_id"`
		Coalesced     bool  `json:"coalesced"`
	}
	if err := json.Unmarshal([]byte(detailJSON), &detail); err != nil {
		t.Fatal(err)
	}
	if metadataRuns != 1 || detail.MetadataRunID != existing.RunID || !detail.Coalesced {
		t.Fatalf("coalesced follow-up = runs %d detail %#v existing %d", metadataRuns, detail, existing.RunID)
	}
}

func TestCreateLocalScanRunAcceptsOptionalFollowUp(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2})
	actor := account.User{ID: 1, Permissions: []string{"workflows:run", "metadata:sync"}}

	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/local-scan", strings.NewReader(`{"followUpRun":true}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	server.createLocalScanRun(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("follow-up local scan response = %d, %s", response.Code, response.Body.String())
	}
	var result localScanResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	var inputJSON string
	if err := db.QueryRow("SELECT input_json FROM workflow_run WHERE id = ?", result.RunID).Scan(&inputJSON); err != nil {
		t.Fatal(err)
	}
	var payload localScanJobPayload
	if err := json.Unmarshal([]byte(inputJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if !result.FollowUpRun || !payload.FollowUpRun {
		t.Fatalf("follow-up request = result %#v payload %#v", result, payload)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/workflow-runs/local-scan", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response = httptest.NewRecorder()
	server.createLocalScanRun(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("default local scan response = %d, %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.FollowUpRun {
		t.Fatalf("default local scan follow-up = %#v", result)
	}
}

func TestRetryLocalScanPreservesFollowUpChoice(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2})
	original, err := server.enqueueLocalScanWithOptions(context.Background(), "manual", "manual", 0, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE workflow_run SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?", original.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE workflow_job SET status = 'failed' WHERE workflow_run_id = ?", original.RunID); err != nil {
		t.Fatal(err)
	}
	response := requestWorkflowRunAction(t, server.retryWorkflowRun, original.RunID, account.User{
		ID: 1, Permissions: []string{"workflows:run", "metadata:sync"},
	})
	if response.Code != http.StatusAccepted {
		t.Fatalf("retry local scan response = %d, %s", response.Code, response.Body.String())
	}
	var inputJSON string
	if err := db.QueryRow("SELECT input_json FROM workflow_run WHERE id != ? AND workflow_code = 'local_library_scan' ORDER BY id DESC LIMIT 1", original.RunID).Scan(&inputJSON); err != nil {
		t.Fatal(err)
	}
	var payload localScanJobPayload
	if err := json.Unmarshal([]byte(inputJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.FollowUpRun {
		t.Fatalf("retried local scan input = %s", inputJSON)
	}
}

func TestDLsiteMetadataSyncQueuesIndependentRuns(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})

	first, err := server.enqueueDLsiteMetadataSync(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.enqueueDLsiteMetadataSync(context.Background(), "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	if first.Status != "queued" || second.Status != "queued" || first.RunID == second.RunID {
		t.Fatalf("queued metadata results = %#v / %#v", first, second)
	}
	var queuedRuns, queuedJobs int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'metadata_sync' AND status = 'queued'").Scan(&queuedRuns); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE worker_type = 'metadata_sync' AND status = 'queued'").Scan(&queuedJobs); err != nil {
		t.Fatal(err)
	}
	if queuedRuns != 2 || queuedJobs != 2 {
		t.Fatalf("queued metadata runs/jobs = %d/%d", queuedRuns, queuedJobs)
	}
}
