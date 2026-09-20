package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestWorkflowAcknowledgementRequiresResolvedTerminalRun(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID := insertCustomWorkflowAPIUser(t, db, "example_reviewer")
	workID := seedMetadataIssue(t, db, 0)
	for _, statement := range []string{
		`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type) VALUES
 (81,'metadata_sync','Example metadata','failed','manual'),
 (82,'local_library_scan','Example active','running','manual'),
 (83,'local_library_scan','Example candidates','partial','manual')`,
		`INSERT INTO workflow_candidate(workflow_run_id,candidate_type,status) VALUES(83,'example_review','pending')`,
		`INSERT INTO metadata_sync_attempt(id) VALUES(2)`,
		`UPDATE work_metadata_sync_state SET attempt_id=2`,
		`INSERT INTO metadata_sync_attempt_run(attempt_id,workflow_run_id) VALUES(2,81)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO metadata_sync_attempt_work(attempt_id,work_id,provider_id,component,status)
 SELECT 2,?,id,'metadata','unavailable' FROM metadata_provider WHERE code='dlsite'`, workID); err != nil {
		t.Fatal(err)
	}
	actor := currentUser{ID: userID, Permissions: []string{"workflows:run"}}
	for _, id := range []int64{81, 82, 83} {
		response := requestWorkflowResource(t, server.reviewWorkflowRun, http.MethodPost, id, actor, "")
		if response.Code != http.StatusConflict {
			t.Fatalf("run %d review = %d: %s", id, response.Code, response.Body)
		}
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_run_review`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("blocked reviews persisted: %d, %v", count, err)
	}
	if _, err := db.Exec(`UPDATE work_metadata_sync_state SET status='succeeded'`); err != nil {
		t.Fatal(err)
	}
	if response := requestWorkflowResource(t, server.reviewWorkflowRun, http.MethodPost, 81, actor, ""); response.Code != http.StatusOK {
		t.Fatalf("resolved run review = %d: %s", response.Code, response.Body)
	}
}

func TestDemoWorkflowAcknowledgementIsReadOnly(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeDemo})
	if err := server.BootstrapDemo(context.Background()); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/81/review", nil)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"demo_read_only"`) {
		t.Fatalf("demo review = %d: %s", response.Code, response.Body)
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_run_review`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("demo review persisted: %d, %v", count, err)
	}
}
