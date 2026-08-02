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
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/library"
)

func TestCheckUnlinkedWorkSourcesEnqueuesOneParentWorkflow(t *testing.T) {
	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(101, 'RJ03000001', 'Unlinked one'),
			(102, 'RJ03000002', 'Unlinked two')
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/maintenance/unlinked-works/source-check", strings.NewReader(`{"workIds":[101,102]}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()

	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result unlinkedWorkSourceCheckResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.RunID <= 0 || result.JobID <= 0 || result.Queued != 2 || result.Status != "queued" {
		t.Fatalf("result = %+v", result)
	}
	var runs, jobs, audits int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'unlinked_work_source_check'").Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE worker_type = 'unlinked_work_source_check'").Scan(&jobs); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM audit_log WHERE action = 'unlinked_works.source_check' AND actor_user_id = 1").Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || jobs != 1 || audits != 1 {
		t.Fatalf("runs = %d, jobs = %d, audits = %d; want 1 each", runs, jobs, audits)
	}
}

func TestUnlinkedWorkSourceCheckKeepsMissingWorksAndLinksAvailableWorks(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case r.URL.Path == "/api/workInfo/RJ03000011":
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 11, SourceID: "RJ03000011", Title: "Available work"})
		case strings.HasPrefix(r.URL.Path, "/api/workInfo/"):
			http.NotFound(w, r)
		case strings.HasPrefix(r.URL.Path, "/api/search/") || r.URL.Path == "/api/works":
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{}, Pagination: kikoeru.Pagination{PageSize: 100, TotalCount: 0}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(111, 'RJ03000011', 'Available work'),
			(112, 'RJ03000012', 'Still missing work');
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1);
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url)
		VALUES (11, ?, ?)
	`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	result, err := server.enqueueUnlinkedWorkSourceCheck(context.Background(), 1, []int64{111, 112})
	if err != nil {
		t.Fatal(err)
	}
	if result.Queued != 2 {
		t.Fatalf("queued = %d, want 2", result.Queued)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "unlinked-test-worker"); err != nil {
		t.Fatal(err)
	}

	var available, missing int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE work_id = 111 AND file_source_id = 11 AND availability = 'available'`).Scan(&available); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE work_id = 112 AND file_source_id = 11 AND availability = 'missing'`).Scan(&missing); err != nil {
		t.Fatal(err)
	}
	if available != 1 || missing != 1 {
		t.Fatalf("available rows = %d, missing rows = %d; want 1 each", available, missing)
	}
	page, err := server.libraryStore.ListPage(context.Background(), library.ListOptions{Page: 1, PageSize: 25, Scope: "no_source"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].ID != 112 {
		t.Fatalf("no-source page = total %d, works %+v; want only missing work", page.Total, page.Works)
	}
	var runStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", result.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" {
		t.Fatalf("run status = %q, want succeeded", runStatus)
	}
}

func TestDeleteUnlinkedWorksDeletesWholeFamilyButKeepsFiles(t *testing.T) {
	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	dataRoot := t.TempDir()
	mediaPath := filepath.Join(dataRoot, "RJ03000021", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mediaPath, []byte("synthetic media"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(121, 'RJ03000021', 'Origin work'),
			(122, 'RJ03000022', 'Translated work'),
			(123, 'RJ03000023', 'Linked work');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (21, 121, 'RJ03000021');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(121, 21, 'RJ03000021', 'RJ03000021', 1),
			(122, 21, 'RJ03000022', 'RJ03000021', 0);
		INSERT INTO work_code_alias (logical_work_id, provider_id, primary_code, relationship_kind, source_work_id)
		VALUES (21, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ03000029', 'provider_declared', 121);
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES
			(121, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ03000021', '{}'),
			(122, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ03000022', '{}');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (21, 'test_local', 'Test local', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title) VALUES (211, 121, 'audio', 'track.mp3');
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (211, 21, 'local', 'RJ03000021/track.mp3', 'unavailable');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability)
		VALUES (123, 21, 'local', 'available');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (1, 121, 'finished', 1);
		INSERT INTO favorite_list (id, user_id, name) VALUES (21, 1, 'Test list');
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (21, 122);
		INSERT INTO user_tag (id, user_id, name) VALUES (21, 1, 'Test tag');
		INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (1, 121, 21);
		INSERT INTO work_manual_override (work_id, field_name, value_json, asset_path, updated_by_user_id)
		VALUES (121, 'cover', '{}', 'manual/synthetic-cover.jpg', 1)
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	request := httptest.NewRequest(http.MethodPost, "/api/maintenance/unlinked-works/delete", strings.NewReader(`{"workIds":[121,123],"confirm":true}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()

	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result unlinkedWorkDeleteResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.DeletedFamilyCount != 1 || result.DeletedWorkCount != 2 || result.RetainedAssetFiles != 1 {
		t.Fatalf("result = %+v", result)
	}
	if len(result.Skipped) != 1 || result.Skipped[0].WorkID != 123 || result.Skipped[0].Reason != "source_available" {
		t.Fatalf("skipped = %+v", result.Skipped)
	}
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM work WHERE id IN (121, 122)", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM logical_work WHERE id = 21", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM metadata_snapshot WHERE external_id IN ('RJ03000021', 'RJ03000022')", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM media_item WHERE id = 211", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM user_work_state WHERE work_id = 121", 0)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM work WHERE id = 123", 1)
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM audit_log WHERE action = 'unlinked_works.delete' AND actor_user_id = 1", 1)
	if _, err := os.Stat(mediaPath); err != nil {
		t.Fatalf("media file was removed: %v", err)
	}
}

func TestDeleteUnlinkedWorksRequiresPermissionAndConfirmation(t *testing.T) {
	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	server := NewServer(db, config.Config{})

	withoutPermission := httptest.NewRequest(http.MethodPost, "/api/maintenance/unlinked-works/delete", strings.NewReader(`{"workIds":[1],"confirm":true}`))
	withoutPermission = withoutPermission.WithContext(context.WithValue(withoutPermission.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"library:read"}}))
	permissionResponse := httptest.NewRecorder()
	server.deleteUnlinkedWorks(permissionResponse, withoutPermission)
	if permissionResponse.Code != http.StatusForbidden {
		t.Fatalf("permission status = %d, want %d", permissionResponse.Code, http.StatusForbidden)
	}

	withoutConfirmation := httptest.NewRequest(http.MethodPost, "/api/maintenance/unlinked-works/delete", strings.NewReader(`{"workIds":[1]}`))
	withoutConfirmation = withoutConfirmation.WithContext(context.WithValue(withoutConfirmation.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	confirmationResponse := httptest.NewRecorder()
	server.deleteUnlinkedWorks(confirmationResponse, withoutConfirmation)
	if confirmationResponse.Code != http.StatusBadRequest || !strings.Contains(confirmationResponse.Body.String(), "confirmation is required") {
		t.Fatalf("confirmation response = %d, %s", confirmationResponse.Code, confirmationResponse.Body.String())
	}
}

func insertUnlinkedMaintenanceUser(t *testing.T, db *sql.DB, id int64) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO user_account (id, username, display_name, role) VALUES (?, ?, ?, 'admin')", id, "maintenance-user", "Maintenance user"); err != nil {
		t.Fatal(err)
	}
}

func assertUnlinkedMaintenanceCount(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(query).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("query %q count = %d, want %d", query, got, want)
	}
}
