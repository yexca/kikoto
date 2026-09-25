package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func seedDatabaseCleanupFixture(t *testing.T, db *sql.DB, dataRoot string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dataRoot, "present", "RJ00000001"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "present", "RJ00000001", "kept.mp3"), []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	insertUnlinkedMaintenanceUser(t, db, 1)
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (41, 'cleanup_local', 'Cleanup local', 'local_folder', 1);
		INSERT INTO work (id, primary_code, title) VALUES
			(201, 'RJ00000000', 'Moved work'),
			(202, 'RJ00000001', 'Present work');
		INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, state) VALUES
			(301, 201, 41, 'gone/RJ00000000', 'missing'),
			(302, 202, 41, 'present/RJ00000001', 'missing'),
			(303, 202, 41, 'present', 'active');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(401, 201, 'audio', 'Gone track', 'local:RJ00000000:a.mp3'),
			(402, 202, 'audio', 'Kept track', 'local:RJ00000001:kept.mp3'),
			(403, 202, 'audio', 'Remote placeholder', 'remote:9:RJ00000001:x.mp3');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(501, 401, 41, 'local', 'gone/RJ00000000/a.mp3', 'missing'),
			(502, 402, 41, 'local', 'present/RJ00000001/kept.mp3', 'missing');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES
			(201, 41, 'local', 'missing'),
			(202, 41, 'local', 'missing');
		INSERT INTO tag (id, namespace, normalized_name, display_name) VALUES
			(601, 'dlsite', 'unused', 'Unused'),
			(602, 'dlsite', 'used', 'Used');
		INSERT INTO work_tag (work_id, tag_id) VALUES (202, 602);
		INSERT INTO user_session (id, user_id, expires_at) VALUES
			('expired', 1, '2000-01-01 00:00:00'),
			('current', 1, '2999-01-01 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}
}

func databaseMaintenanceRequest(method, target, body string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
}

func databaseTaskCounts(t *testing.T, server *Server) (map[string]databaseCleanupTaskSummary, databaseMaintenanceOverview) {
	t.Helper()
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodGet, "/api/maintenance/database", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("scan status = %d, body = %s", response.Code, response.Body.String())
	}
	var overview databaseMaintenanceOverview
	if err := json.Unmarshal(response.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	tasks := map[string]databaseCleanupTaskSummary{}
	for _, task := range overview.Tasks {
		tasks[task.Key] = task
	}
	return tasks, overview
}

func TestDatabaseCleanupRemovesOnlyRecordsConfirmedMissingOnDisk(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	seedDatabaseCleanupFixture(t, db, dataRoot)
	server := NewServer(db, config.Config{DataRoot: dataRoot})

	tasks, overview := databaseTaskCounts(t, server)
	if !overview.DataRootAvailable || overview.DatabaseBytes <= 0 {
		t.Fatalf("overview = %+v", overview)
	}
	for key, want := range map[string]int{
		databaseCleanupTaskMissingFolders:  1,
		databaseCleanupTaskMissingFiles:    1,
		databaseCleanupTaskUnusedTags:      1,
		databaseCleanupTaskExpiredSessions: 1,
	} {
		if tasks[key].Count != want {
			t.Fatalf("%s count = %d, want %d", key, tasks[key].Count, want)
		}
	}

	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodPost, "/api/maintenance/database/cleanup",
		`{"tasks":["missing_files","missing_folders","unused_tags","expired_sessions"]}`))
	if response.Code != http.StatusOK {
		t.Fatalf("cleanup status = %d, body = %s", response.Code, response.Body.String())
	}

	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM work_folder_location WHERE id IN (302, 303)", 2)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM work_folder_location WHERE id = 301", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM media_file_location WHERE id = 502", 1)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM media_item WHERE id = 401", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM media_item WHERE id IN (402, 403)", 2)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM work_source_presence WHERE work_id = 201", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM work_source_presence WHERE work_id = 202", 1)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM tag", 1)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM user_session", 1)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM audit_log WHERE action = 'database.cleanup' AND actor_user_id = 1", 1)
}

func TestDatabaseCleanupSkipsDiskTasksWhenDataRootLooksUnmounted(t *testing.T) {
	db := openMigratedTestDB(t)
	seedDatabaseCleanupFixture(t, db, t.TempDir())
	server := NewServer(db, config.Config{DataRoot: t.TempDir()})

	tasks, overview := databaseTaskCounts(t, server)
	if overview.DataRootAvailable || tasks[databaseCleanupTaskMissingFolders].Available {
		t.Fatalf("empty data root must disable disk tasks: %+v", overview)
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodPost, "/api/maintenance/database/cleanup", `{"tasks":["missing_folders","missing_files"]}`))
	if response.Code != http.StatusOK {
		t.Fatalf("cleanup status = %d, body = %s", response.Code, response.Body.String())
	}
	var result databaseCleanupResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Removed != 0 || len(result.Results) != 2 || !result.Results[0].Skipped || !result.Results[1].Skipped {
		t.Fatalf("result = %+v", result)
	}
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM work_folder_location", 3)
}

func TestDatabaseCleanupKeepsWorkflowRunsWithDurableDependents(t *testing.T) {
	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	if _, err := db.Exec(`
		INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, finished_at) VALUES
			(701, 'local_scan', 'Old scan', 'succeeded', 'manual', '2000-01-01 00:00:00'),
			(702, 'local_scan', 'Old scan with review', 'succeeded', 'manual', '2000-01-02 00:00:00'),
			(703, 'local_scan', 'Latest scan', 'succeeded', 'manual', '2000-01-03 00:00:00'),
			(704, 'metadata_sync', 'Running sync', 'running', 'manual', NULL);
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, status) VALUES (702, 'duplicate', 'pending');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodPost, "/api/maintenance/database/cleanup", `{"tasks":["old_runs"]}`))
	if response.Code != http.StatusOK {
		t.Fatalf("cleanup status = %d, body = %s", response.Code, response.Body.String())
	}
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM workflow_run WHERE id = 701", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM workflow_run WHERE id IN (702, 703, 704)", 3)
}

func TestDatabaseCleanupRejectsUnknownTasksAndRequiresPermission(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodPost, "/api/maintenance/database/cleanup", `{"tasks":["drop_everything"]}`))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown task status = %d", response.Code)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/maintenance/database", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 2, Permissions: []string{"library:read"}}))
	response = httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-admin status = %d", response.Code)
	}
}

func TestDatabaseOptimizeQueuesOneWorkflowJobAndAuditsCompletion(t *testing.T) {
	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	server := NewServer(db, config.Config{})

	queue := func() databaseOptimizeQueuedResult {
		t.Helper()
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodPost, "/api/maintenance/database/optimize", `{}`))
		if response.Code != http.StatusAccepted {
			t.Fatalf("optimize status = %d, body = %s", response.Code, response.Body.String())
		}
		var result databaseOptimizeQueuedResult
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := queue()
	if first.RunID <= 0 || first.JobID <= 0 || first.Status != "queued" || first.Existing {
		t.Fatalf("first result = %+v", first)
	}
	second := queue()
	if second.RunID != first.RunID || second.JobID != first.JobID || !second.Existing {
		t.Fatalf("second result = %+v, want existing run %d", second, first.RunID)
	}
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM workflow_job WHERE worker_type = 'database_optimize'", 1)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM audit_log WHERE action = 'database.optimize'", 0)

	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatalf("run optimize job: %v", err)
	}
	var status, summary string
	if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", first.RunID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || !strings.Contains(summary, `"after_bytes"`) {
		t.Fatalf("run status = %s, summary = %s", status, summary)
	}
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM audit_log WHERE action = 'database.optimize' AND actor_user_id = 1 AND json_extract(detail_json, '$.beforeBytes') > 0", 1)

	third := queue()
	if third.RunID == first.RunID || third.Existing {
		t.Fatalf("a finished optimization must not block a new one: %+v", third)
	}
}
