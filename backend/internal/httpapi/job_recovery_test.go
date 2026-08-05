package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

func TestClaimNextQueuedWorkflowJobUsesPersistentPriorityBeforeAge(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	statements := []string{
		`INSERT OR IGNORE INTO workflow_definition (id, code, display_name) VALUES (1, 'priority-test', 'Priority test')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, 1, 'priority-test', 'Older background job', 'queued', 'schedule'), (2, 1, 'priority-test', 'Newer playback job', 'queued', 'playback')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status, priority, created_at) VALUES (1, 1, 'background', 'queued', 0, '2000-01-01 00:00:00'), (2, 2, 'playback', 'queued', 100, '2030-01-01 00:00:00')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "priority-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %+v, %v, %v", job, ok, err)
	}
	if job.ID != 2 {
		t.Fatalf("claimed job %d, want high-priority job 2", job.ID)
	}
}

func TestClaimNextQueuedWorkflowJobSkipsBusyResourceLane(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	statements := []string{
		`INSERT OR IGNORE INTO workflow_definition (id, code, display_name) VALUES (1, 'resource-test', 'Resource test')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, 1, 'resource-test', 'Busy', 'running', 'manual'), (2, 1, 'resource-test', 'Same lane', 'queued', 'manual'), (3, 1, 'resource-test', 'Other lane', 'queued', 'manual')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status, resource_key) VALUES (1, 1, 'background', 'running', 'remote:https://source.example'), (2, 2, 'background', 'queued', 'remote:https://source.example'), (3, 3, 'background', 'queued', 'local:io')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "runner")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || job.ID != 3 || job.ResourceKey != "local:io" {
		t.Fatalf("claimed job = %+v, ok=%t", job, ok)
	}
}

func TestRecoverInterruptedWorkflowsRequeuesAndReclaimsCheckpoint(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	statements := []string{
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'media_cache'), 'media_cache', 'Cache', 'running', 'manual')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (1, 1, 'cache', 'materialize_cache', 'Cache', 1, 'running')`,
		`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status, payload_json, checkpoint_json, recoverable, max_retries, locked_by, locked_at, heartbeat_at) VALUES (1, 1, 1, 'remote_media_cache', 'running', '{"media_location_id":7}', '{"phase":"download","index":1}', 1, 3, 'old-runner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.RecoverInterruptedWorkflows(ctx); err != nil {
		t.Fatal(err)
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "new-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %+v, %v, %v", job, ok, err)
	}
	if job.ID != 1 || job.ResumeCount != 1 || job.CheckpointJSON != `{"phase":"download","index":1}` {
		t.Fatalf("reclaimed job = %+v", job)
	}
	var runStatus, jobStatus, lockedBy string
	if err := db.QueryRow(`SELECT run.status, job.status, job.locked_by FROM workflow_run AS run INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id WHERE run.id = 1`).Scan(&runStatus, &jobStatus, &lockedBy); err != nil {
		t.Fatal(err)
	}
	if runStatus != "running" || jobStatus != "running" || lockedBy != "new-runner" {
		t.Fatalf("run=%s job=%s lock=%s", runStatus, jobStatus, lockedBy)
	}
}

func TestDecodeWorkflowJobCheckpointDetailSupportsRawAndEnvelope(t *testing.T) {
	type checkpoint struct {
		Completed []string `json:"completed"`
	}
	want := checkpoint{Completed: []string{"RJ01234567"}}
	for name, raw := range map[string]string{
		"raw":      `{"completed":["RJ01234567"]}`,
		"envelope": `{"phase":"dispatch","detail":{"completed":["RJ01234567"]},"progressCurrent":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			var got checkpoint
			if err := decodeWorkflowJobCheckpointDetail(raw, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("checkpoint = %#v, want %#v", got, want)
			}
		})
	}
}

func TestRetryFailedWorkflowJobRequeuesSameCheckpoint(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	statements := []string{
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type, finished_at) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'media_cache'), 'media_cache', 'Cache', 'failed', 'manual', CURRENT_TIMESTAMP)`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status, error_message, finished_at) VALUES (1, 1, 'cache', 'materialize_cache', 'Cache', 1, 'failed', 'temporary source failure', CURRENT_TIMESTAMP)`,
		`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status, payload_json, checkpoint_json, recoverable, max_retries, retry_count, error_message) VALUES (1, 1, 1, 'remote_media_cache', 'failed', '{"media_location_id":7}', '{"phase":"download","index":1}', 1, 3, 1, 'temporary source failure')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.retryFailedWorkflowJob(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	var runStatus, nodeStatus, jobStatus, checkpoint string
	var retryCount int
	if err := db.QueryRow(`
		SELECT run.status, node.status, job.status, job.checkpoint_json, job.retry_count
		FROM workflow_run AS run
		INNER JOIN workflow_node_run AS node ON node.workflow_run_id = run.id
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.id = 1
	`).Scan(&runStatus, &nodeStatus, &jobStatus, &checkpoint, &retryCount); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" || nodeStatus != "queued" || jobStatus != "queued" || retryCount != 2 || checkpoint != `{"phase":"download","index":1}` {
		t.Fatalf("run=%s node=%s job=%s retries=%d checkpoint=%s", runStatus, nodeStatus, jobStatus, retryCount, checkpoint)
	}
}

func TestRetryableWorkflowErrorOnlyAcceptsTransientDownloads(t *testing.T) {
	if !isRetryableWorkflowError(remoteDownloadError{StatusCode: 503, Retryable: true}) {
		t.Fatal("503 download should be retryable")
	}
	if isRetryableWorkflowError(remoteDownloadError{StatusCode: 403, Retryable: false}) {
		t.Fatal("403 download should require user or source intervention")
	}
	if isRetryableWorkflowError(context.Canceled) {
		t.Fatal("cancellation should not be retried")
	}
	policyErr := remoteDownloadError{
		Err: &url.Error{
			Op:  "Get",
			URL: "https://media.example.invalid/private/path.mp3?token=synthetic",
			Err: outbound.OriginNotAllowedError{Origin: "https://media.example.invalid:443"},
		},
		Retryable: false,
	}
	if isRetryableWorkflowError(policyErr) {
		t.Fatal("a permanent download error wrapped in url.Error should not fall through to generic network retry handling")
	}
}

func TestRemoteOriginBlockPausesFetchForReviewAndManualRetryResolvesCandidate(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example-remote', 'Example Remote', 'kikoeru_compatible')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch remote work', 'running', 'manual')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (1, 1, 'cache', 'materialize_cache', 'Cache selected files', 4, 'running')`,
		`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status, payload_json, checkpoint_json, recoverable, max_retries, retry_count) VALUES (1, 1, 1, 'remote_work_fetch', 'running', '{"source_id":1,"work_code":"RJ00000000"}', '{"phase":"materialize"}', 1, 5, 0)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	origin := "https://media.example.invalid:443"
	if err := server.pauseRemoteFetchForOriginReview(
		context.Background(),
		1,
		1,
		1,
		0,
		remoteSourceForUse{ID: 1, DisplayName: "Example Remote"},
		origin,
		0,
		2,
		remoteWorkSaveSummary{CacheDownload: 1},
	); err != nil {
		t.Fatal(err)
	}

	var runStatus, nodeStatus, jobStatus, candidateStatus, candidateType, candidatePayload, eventDetail string
	var candidateID int64
	var retryCount int
	if err := db.QueryRow(`
		SELECT run.status, node.status, job.status, job.retry_count,
			candidate.id, candidate.status, candidate.candidate_type, candidate.payload_json
		FROM workflow_run AS run
		INNER JOIN workflow_node_run AS node ON node.workflow_run_id = run.id
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		INNER JOIN workflow_candidate AS candidate ON candidate.workflow_run_id = run.id
		WHERE run.id = 1
	`).Scan(&runStatus, &nodeStatus, &jobStatus, &retryCount, &candidateID, &candidateStatus, &candidateType, &candidatePayload); err != nil {
		t.Fatal(err)
	}
	if runStatus != "partial" || nodeStatus != "partial" || jobStatus != "failed" || retryCount != 0 || candidateStatus != "pending" || candidateType != remoteOriginBlockedCandidateType {
		t.Fatalf("run=%s node=%s job=%s retries=%d candidate=%s/%s", runStatus, nodeStatus, jobStatus, retryCount, candidateType, candidateStatus)
	}
	if !strings.Contains(candidatePayload, origin) || strings.Contains(candidatePayload, "path.mp3") || strings.Contains(candidatePayload, "token") {
		t.Fatalf("candidate payload was not origin-only: %s", candidatePayload)
	}
	if err := db.QueryRow(`SELECT detail_json FROM workflow_event WHERE workflow_run_id = 1 AND event_type = 'remote.origin_blocked'`).Scan(&eventDetail); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(eventDetail, "path.mp3") || strings.Contains(eventDetail, "token") {
		t.Fatalf("event detail exposed the media URL: %s", eventDetail)
	}
	request := httptest.NewRequest(http.MethodPatch, "/api/workflow-candidates/1", strings.NewReader(`{"status":"resolved"}`))
	request.SetPathValue("id", "1")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"workflows:run"}}))
	response := httptest.NewRecorder()
	server.updateWorkflowCandidate(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("generic candidate resolution status = %d, body = %s", response.Code, response.Body.String())
	}
	if err := db.QueryRow(`SELECT status FROM workflow_candidate WHERE id = ?`, candidateID).Scan(&candidateStatus); err != nil {
		t.Fatal(err)
	}
	if candidateStatus != "pending" {
		t.Fatalf("generic candidate resolution changed status to %q", candidateStatus)
	}

	if err := server.retryFailedWorkflowJob(context.Background(), 1); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT run.status, node.status, job.status, job.retry_count, candidate.status
		FROM workflow_run AS run
		INNER JOIN workflow_node_run AS node ON node.workflow_run_id = run.id
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		INNER JOIN workflow_candidate AS candidate ON candidate.workflow_run_id = run.id
		WHERE run.id = 1
	`).Scan(&runStatus, &nodeStatus, &jobStatus, &retryCount, &candidateStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "queued" || nodeStatus != "queued" || jobStatus != "queued" || retryCount != 1 || candidateStatus != "resolved" {
		t.Fatalf("manual retry run=%s node=%s job=%s retries=%d candidate=%s", runStatus, nodeStatus, jobStatus, retryCount, candidateStatus)
	}
}

func TestLocalLocationCleanupResumeSkipsCompletedLocations(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir()})
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ01234567', 'Work')`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'One'), (2, 1, 'audio', 'Two')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'cache', 'already-completed.mp3', 'available'), (2, 2, 1, 'local', 'pending.mp3', 'available')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'local_location_cleanup'), 'local_location_cleanup', 'Cleanup', 'running', 'manual')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES (1, 1, 'cleanup', 'cleanup_cache', 'Cleanup', 1, 'running'), (2, 1, 'review', 'filter_candidates', 'Review', 2, 'queued')`,
		`INSERT INTO workflow_job (id, workflow_run_id, workflow_node_run_id, worker_type, status, payload_json, checkpoint_json, recoverable, max_retries) VALUES (1, 1, 1, 'local_location_cleanup', 'running', '{"candidate_id":1,"action":"mark_unavailable","location_ids":[1,2]}', '{"phase":"cleanup","detail":{"completedLocationIds":[1],"result":{"runId":1,"candidateId":1,"action":"mark_unavailable","status":"succeeded","marked":1,"failures":[]}}}', 1, 3)`,
		`INSERT INTO workflow_candidate (id, workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json) VALUES (1, 1, 2, 'local_fetch_merge_cleanup', 'test', 'pending', '{}')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	job := workflowJobRecord{
		ID: 1, RunID: 1, NodeRunID: 1,
		PayloadJSON:    `{"candidate_id":1,"action":"mark_unavailable","location_ids":[1,2]}`,
		CheckpointJSON: `{"phase":"cleanup","detail":{"completedLocationIds":[1],"result":{"runId":1,"candidateId":1,"action":"mark_unavailable","status":"succeeded","marked":1,"failures":[]}}}`,
	}
	result, err := server.performLocalLocationCleanupJob(context.Background(), job, 2)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.Marked != 2 || result.Failed != 0 {
		t.Fatalf("result = %+v", result)
	}
	var completedAvailability, pendingAvailability, candidateStatus, jobStatus string
	if err := db.QueryRow(`SELECT availability FROM media_file_location WHERE id = 1`).Scan(&completedAvailability); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT availability FROM media_file_location WHERE id = 2`).Scan(&pendingAvailability); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status FROM workflow_candidate WHERE id = 1`).Scan(&candidateStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT status FROM workflow_job WHERE id = 1`).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if completedAvailability != "available" || pendingAvailability != "unavailable" || candidateStatus != "resolved" || jobStatus != "succeeded" {
		t.Fatalf("completed=%s pending=%s candidate=%s job=%s", completedAvailability, pendingAvailability, candidateStatus, jobStatus)
	}
}
