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

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestMediaLocationCleanupKeepsLargeSelectionInOneRun(t *testing.T) {
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	localID := insertTestLocalMediaLocation(t, db, filepath.ToSlash(filepath.Join("RJTEST001", "seed.mp3")))
	var mediaItemID, sourceID int64
	if err := db.QueryRow("SELECT media_item_id, file_source_id FROM media_file_location WHERE id = ?", localID).Scan(&mediaItemID, &sourceID); err != nil {
		t.Fatal(err)
	}
	targets := make([]mediaCleanupTargetRequest, 0, 501)
	for index := 0; index < 501; index++ {
		result, err := db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
			VALUES (?, ?, 'cache', ?, 'available')`, mediaItemID, sourceID, fmt.Sprintf("large/%03d.mp3", index))
		if err != nil {
			t.Fatal(err)
		}
		locationID, _ := result.LastInsertId()
		targets = append(targets, mediaCleanupTargetRequest{Kind: "cache", LocationID: locationID})
	}

	queued, err := server.enqueueMediaLocationCleanup(context.Background(), targets)
	if err != nil {
		t.Fatal(err)
	}
	if queued.Queued != len(targets) {
		t.Fatalf("queued = %d, want %d", queued.Queued, len(targets))
	}
	var runs, jobs int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE workflow_run_id = ?", queued.RunID).Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || jobs != 1 {
		t.Fatalf("large cleanup created %d runs and %d jobs, want one durable run and job", runs, jobs)
	}
}

func TestMediaLocationCleanupQueuesAndExecutesMixedTargets(t *testing.T) {
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	localPath := filepath.Join("RJTEST001", "audio", "local.mp3")
	if err := os.MkdirAll(filepath.Join(dataRoot, "RJTEST001", "audio"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, localPath), []byte("local"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheRoot, "cached.mp3"), []byte("cache"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	localID := insertTestLocalMediaLocation(t, db, filepath.ToSlash(localPath))
	var mediaItemID, sourceID int64
	if err := db.QueryRow("SELECT media_item_id, file_source_id FROM media_file_location WHERE id = ?", localID).Scan(&mediaItemID, &sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability)
		SELECT work_id, ?, 'local', 'RJTEST001', 'available' FROM media_item WHERE id = ?`, sourceID, mediaItemID); err != nil {
		t.Fatal(err)
	}
	result, err := db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'cache', 'cached.mp3', 'available')`, mediaItemID, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	cacheID, _ := result.LastInsertId()
	result, err = db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'remote_stream', 'remote.mp3', 'available')`, mediaItemID, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	remoteID, _ := result.LastInsertId()

	queued, err := server.enqueueMediaLocationCleanup(context.Background(), []mediaCleanupTargetRequest{
		{Kind: "local", LocationID: localID},
		{Kind: "cache", LocationID: cacheID},
		{Kind: "cache", LocationID: cacheID},
		{Kind: "local_root", LocationID: localID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if queued.Status != "queued" || queued.Queued != 3 {
		t.Fatalf("queued result = %#v, want three unique queued targets", queued)
	}
	var job workflowJobRecord
	if err := db.QueryRow(`SELECT id, workflow_run_id, workflow_node_run_id, worker_type, payload_json, checkpoint_json,
		'', resume_count, retry_count, max_retries FROM workflow_job WHERE id = ?`, queued.JobID).Scan(
		&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON, &job.CheckpointJSON,
		&job.LockedBy, &job.ResumeCount, &job.RetryCount, &job.MaxRetries,
	); err != nil {
		t.Fatal(err)
	}
	if job.WorkerType != "media_location_cleanup" {
		t.Fatalf("worker type = %q", job.WorkerType)
	}
	if deleted, err := server.clearLocalMediaLocation(context.Background(), localID, filepath.ToSlash(localPath)); err != nil || !deleted {
		t.Fatalf("seed completed local cleanup = deleted %t, error %v", deleted, err)
	}
	job.CheckpointJSON = mustJSON(mediaCleanupCheckpoint{CompletedKeys: []string{mediaCleanupTargetKey(mediaCleanupTarget{Kind: "local", LocationID: localID})}, Deleted: 1})
	if _, err := db.Exec("UPDATE workflow_job SET status = 'running' WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if err := server.executeMediaLocationCleanupJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(dataRoot, "RJTEST001"), filepath.Join(cacheRoot, "cached.mp3")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("path %s still exists or stat failed unexpectedly: %v", path, err)
		}
	}
	for _, id := range []int64{localID, cacheID} {
		var availability string
		if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", id).Scan(&availability); err != nil {
			t.Fatal(err)
		}
		if availability != "unavailable" {
			t.Fatalf("location %d availability = %q", id, availability)
		}
	}
	var remoteAvailability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", remoteID).Scan(&remoteAvailability); err != nil {
		t.Fatal(err)
	}
	if remoteAvailability != "available" {
		t.Fatalf("remote location availability = %q, want available", remoteAvailability)
	}
	var localPresence string
	if err := db.QueryRow("SELECT availability FROM work_source_presence WHERE file_source_id = ? AND presence_type = 'local'", sourceID).Scan(&localPresence); err != nil {
		t.Fatal(err)
	}
	if localPresence != "unavailable" {
		t.Fatalf("local presence availability = %q, want unavailable", localPresence)
	}
	var runStatus, jobStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_job WHERE id = ?", queued.JobID).Scan(&jobStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" || jobStatus != "succeeded" {
		t.Fatalf("statuses = run %q job %q", runStatus, jobStatus)
	}
	var summary string
	if err := db.QueryRow("SELECT summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if summary != `{"deleted":3,"locations":3}` {
		t.Fatalf("summary = %s, want recovered total delete count", summary)
	}
}

func TestMediaCleanupRequiresDownloadsManage(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/media/cleanup", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"library:read"},
	}))
	response := httptest.NewRecorder()

	server.cleanupMediaLocations(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestMediaCleanupFilesOnlyPreservesWorkState(t *testing.T) {
	dataRoot := t.TempDir()
	mediaPath := filepath.Join(dataRoot, "RJ00000010", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mediaPath, []byte("synthetic media"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'cleanup-files-user', 'Cleanup files user', 'admin');
		INSERT INTO work (id, primary_code, title) VALUES (301, 'RJ00000010', 'Files only work');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (31, 'cleanup-local-files', 'Cleanup local files', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (311, 301, 'audio', 'track.mp3', 'cleanup-files-fingerprint');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (311, 311, 31, 'local', 'RJ00000010/track.mp3', 'available');
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (301, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000010', '{}');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (1, 301, 'finished', 1);
		INSERT INTO favorite_list (id, user_id, name, kind) VALUES (301, 1, 'Keep list', 'user');
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (301, 301);
		INSERT INTO user_media_progress (user_id, media_item_id, position_seconds, completed) VALUES (1, 311, 12.5, 0);
		INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, file_source_id, location_id, location_type, position_seconds, completed)
		VALUES (1, 301, 311, 31, 311, 'local', 12.5, 0);
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir()})
	queued, err := server.enqueueMediaLocationCleanup(context.Background(), []mediaCleanupTargetRequest{{Kind: "local", LocationID: 311}})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "files-only-test-worker"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mediaPath); !os.IsNotExist(err) {
		t.Fatalf("media path still exists or stat failed unexpectedly: %v", err)
	}
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM work WHERE id = 301", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM metadata_snapshot WHERE work_id = 301", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM user_work_state WHERE work_id = 301", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM favorite_list_item WHERE list_id = 301 AND work_id = 301", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM user_media_progress WHERE media_item_id = 311", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM user_work_playback_cursor WHERE work_id = 301", 1)
	var availability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = 311").Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "unavailable" {
		t.Fatalf("availability = %q, want unavailable", availability)
	}
	var runStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" {
		t.Fatalf("run status = %q, want succeeded", runStatus)
	}
}

func TestMediaCleanupForgetWorkDeletesLogicalFamilyAndUserState(t *testing.T) {
	dataRoot := t.TempDir()
	rootPath := filepath.Join(dataRoot, "RJ00000011")
	mediaPath := filepath.Join(rootPath, "track.mp3")
	if err := os.MkdirAll(rootPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mediaPath, []byte("synthetic media"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'cleanup-forget-user', 'Cleanup forget user', 'admin');
		INSERT INTO work (id, primary_code, title) VALUES
			(302, 'RJ00000011', 'Origin forget work'),
			(303, 'RJ00000012', 'Translated forget work');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (32, 302, 'RJ00000011');
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical) VALUES
			(302, 32, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000011', 'RJ00000011', 1),
			(303, 32, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000012', 'RJ00000011', 0);
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (32, 'cleanup-local-forget', 'Cleanup local forget', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(312, 302, 'audio', 'track.mp3', 'cleanup-forget-origin'),
			(313, 303, 'audio', 'translated.mp3', 'cleanup-forget-translation');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (312, 312, 32, 'local', 'RJ00000011/track.mp3', 'available');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability)
		VALUES (302, 32, 'local', 'RJ00000011', 'available');
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES
			(302, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000011', '{}'),
			(303, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000012', '{}');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES
			(1, 302, 'finished', 1), (1, 303, 'want_to_listen', 0);
		INSERT INTO favorite_list (id, user_id, name, kind) VALUES (302, 1, 'Family list', 'user');
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (302, 303);
		INSERT INTO user_media_progress (user_id, media_item_id, position_seconds, completed) VALUES (1, 312, 19.5, 0);
		INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, file_source_id, location_id, location_type, position_seconds, completed)
		VALUES (1, 302, 312, 32, 312, 'local', 19.5, 0);
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir()})
	queued, err := server.enqueueMediaLocationCleanupWithOptions(context.Background(), []mediaCleanupTargetRequest{
		{Kind: "local", LocationID: 312}, {Kind: "local_root", LocationID: 312},
	}, mediaCleanupOptions{Mode: mediaCleanupForgetWork, ActorUserID: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "forget-test-worker"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(rootPath); !os.IsNotExist(err) {
		t.Fatalf("work root still exists or stat failed unexpectedly: %v", err)
	}
	for _, query := range []string{
		"SELECT COUNT(*) FROM work WHERE id IN (302, 303)",
		"SELECT COUNT(*) FROM logical_work WHERE id = 32",
		"SELECT COUNT(*) FROM work_edition WHERE logical_work_id = 32",
		"SELECT COUNT(*) FROM media_item WHERE id IN (312, 313)",
		"SELECT COUNT(*) FROM metadata_snapshot WHERE external_id IN ('RJ00000011', 'RJ00000012')",
		"SELECT COUNT(*) FROM user_work_state WHERE work_id IN (302, 303)",
		"SELECT COUNT(*) FROM user_media_progress WHERE media_item_id = 312",
		"SELECT COUNT(*) FROM user_work_playback_cursor WHERE work_id = 302",
		"SELECT COUNT(*) FROM favorite_list_item WHERE list_id = 302 AND work_id = 303",
	} {
		assertMediaCleanupCount(t, db, query, 0)
	}
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM favorite_list WHERE id = 302", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM audit_log WHERE action = 'media_cleanup.forget_work' AND actor_user_id = 1", 1)
	var runStatus, forgetStatus, summary string
	if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus, &summary); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'forget'", queued.RunID).Scan(&forgetStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" || forgetStatus != "succeeded" {
		t.Fatalf("statuses = run %q forget %q", runStatus, forgetStatus)
	}
	var summaryValue map[string]any
	if err := json.Unmarshal([]byte(summary), &summaryValue); err != nil {
		t.Fatal(err)
	}
	if summaryValue["work_forgotten"] != true || summaryValue["forgotten_work_count"] != float64(2) {
		t.Fatalf("summary = %s", summary)
	}
}

func TestMediaCleanupForgetWorkRetainsWorkWhenAnotherSourceIsAvailable(t *testing.T) {
	dataRoot := t.TempDir()
	rootPath := filepath.Join(dataRoot, "RJ00000013")
	mediaPath := filepath.Join(rootPath, "track.mp3")
	if err := os.MkdirAll(rootPath, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mediaPath, []byte("synthetic media"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'cleanup-partial-user', 'Cleanup partial user', 'admin');
		INSERT INTO work (id, primary_code, title) VALUES (304, 'RJ00000013', 'Partial forget work');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (33, 'cleanup-local-partial', 'Cleanup local partial', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (314, 304, 'audio', 'track.mp3', 'cleanup-partial-file');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (314, 314, 33, 'local', 'RJ00000013/track.mp3', 'available');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (315, 314, 33, 'remote_stream', 'remote/track.mp3', 'available');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability)
		VALUES (304, 33, 'local', 'RJ00000013', 'available');
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (304, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000013', '{}');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (1, 304, 'listening', 1);
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir()})
	queued, err := server.enqueueMediaLocationCleanupWithOptions(context.Background(), []mediaCleanupTargetRequest{
		{Kind: "local", LocationID: 314}, {Kind: "local_root", LocationID: 314},
	}, mediaCleanupOptions{Mode: mediaCleanupForgetWork, ActorUserID: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "partial-test-worker"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(rootPath); !os.IsNotExist(err) {
		t.Fatalf("work root still exists or stat failed unexpectedly: %v", err)
	}
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM work WHERE id = 304", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM metadata_snapshot WHERE work_id = 304", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM user_work_state WHERE work_id = 304", 1)
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM media_file_location WHERE id = 315 AND availability = 'available'", 1)
	var runStatus, forgetStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'forget'", queued.RunID).Scan(&forgetStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "partial" || forgetStatus != "partial" {
		t.Fatalf("statuses = run %q forget %q, want partial", runStatus, forgetStatus)
	}
	assertMediaCleanupCount(t, db, "SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'media_cleanup.work_retained'", queued.RunID, 1)
}

func TestMediaCleanupForgetWorkRequiresSourcesWrite(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/media/cleanup", strings.NewReader(`{"mode":"files_and_forget_work","targets":[]}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"downloads:manage"},
	}))
	response := httptest.NewRecorder()
	server.cleanupMediaLocations(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func assertMediaCleanupCount(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	want := args[len(args)-1].(int)
	queryArgs := args[:len(args)-1]
	var got int
	if err := db.QueryRow(query, queryArgs...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("query %q count = %d, want %d", query, got, want)
	}
}

func TestFetchSubmissionRequiresDownloadsManage(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/remote-sources/1/works/RJTEST001/fetch", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"library:read"},
	}))
	response := httptest.NewRecorder()

	server.saveRemoteSourceWork(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}

func TestFetchPlanRequiresDownloadsManageBecauseItMaySyncMetadata(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/remote-sources/1/works/RJTEST001/fetch-plan", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"library:read"},
	}))
	response := httptest.NewRecorder()

	server.planRemoteSourceWorkSave(response, request)

	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}
