package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

func TestDemoFavoritesRefreshOnlyEligibleLocalAssociations(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{Mode: config.ModeDemo})
	ctx := context.Background()
	if err := s.BootstrapDemo(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.ensureSystemWorkflowDefinitions(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder');
		INSERT INTO work (id, primary_code, title, age_rating, is_permanently_free) VALUES
			(1, 'RJ00000001', 'Example One', 'general', 1),
			(2, 'RJ00000002', 'Example Two', 'general', 1),
			(3, 'RJ00000003', 'Example Three', 'adult', 1),
			(4, 'RJ00000004', 'Example Four', 'general', 0),
			(5, 'RJ00000005', 'Example Five', 'general', 1);
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES
			(1, 1, 'local', 'available'), (2, 1, 'local', 'available'),
			(3, 1, 'local', 'available'), (4, 1, 'local', 'available');
		INSERT INTO person (id, display_name) VALUES (1, 'Example Voice One'), (2, 'Example Voice Two');
		INSERT INTO work_credit (work_id, person_id, role) VALUES (1, 1, 'voice_actor'), (3, 2, 'voice_actor');
		INSERT INTO party (id, display_name) VALUES (1, 'Example Circle One'), (2, 'Example Circle Two');
		INSERT INTO work_party (work_id, party_id, role) VALUES (2, 1, 'circle'), (4, 2, 'circle');
	`); err != nil {
		t.Fatal(err)
	}
	for run := 0; run < 2; run++ {
		if err := s.SeedDemoShowcase(ctx); err != nil {
			t.Fatal(err)
		}
		for _, check := range []struct {
			query string
			want  int
		}{
			{`SELECT COUNT(*) FROM user_work_state WHERE listening_status <> 'none'`, 2},
			{`SELECT COUNT(*) FROM favorite_list WHERE kind = 'user'`, 1},
			{`SELECT COUNT(*) FROM favorite_list_item`, 2},
			{`SELECT COUNT(*) FROM user_work_state WHERE favorite = 1`, 2},
			{`SELECT COUNT(*) FROM user_person_state WHERE favorite = 1 AND person_id = 1`, 1},
			{`SELECT COUNT(*) FROM user_party_state WHERE favorite = 1 AND party_id = 1`, 1},
			{`SELECT COUNT(*) FROM user_person_state WHERE person_id = 2`, 0},
			{`SELECT COUNT(*) FROM user_party_state WHERE party_id = 2`, 0},
		} {
			var got int
			if err := db.QueryRow(check.query).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != check.want {
				t.Fatalf("run %d: %s = %d, want %d", run, check.query, got, check.want)
			}
		}
	}
	if _, err := db.Exec("UPDATE work SET is_permanently_free = 0 WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedDemoShowcase(ctx); err != nil {
		t.Fatal(err)
	}
	var stale int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_work_state WHERE work_id = 1`).Scan(&stale); err != nil {
		t.Fatal(err)
	}
	if stale != 0 {
		t.Fatal("ineligible work remained on Demo shelf")
	}
}

func TestDemoWorkflowAPIShowsOnlyExamples(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{Mode: config.ModeDemo})
	if err := s.BootstrapDemo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedDemoShowcase(context.Background()); err != nil {
		t.Fatal(err)
	}
	var definitionID int64
	if err := db.QueryRow("SELECT id FROM workflow_definition WHERE code = 'local_library_scan'").Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	realRunID, err := workflow.InsertRun(context.Background(), tx, definitionID, "local_library_scan", "Real scan", "succeeded", "startup", "demo_mode", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/workflow-runs", nil)
	response := httptest.NewRecorder()
	s.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("workflow list status = %d: %s", response.Code, response.Body.String())
	}
	var page workflow.RunsPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	wantRuns := len(demoShowcaseWorkflowCodes) + len(demoShowcaseActivityExamples)
	if page.Total != int64(wantRuns) {
		t.Fatalf("visible run count = %d, want %d", page.Total, wantRuns)
	}
	for _, run := range page.Runs {
		if run.TriggerReason != demoShowcaseRunReason || run.NodeRunCount == 0 {
			t.Fatalf("invalid visible run %#v", run)
		}
	}
	request = httptest.NewRequest(http.MethodGet, "/api/workflow-runs/"+strconv.FormatInt(realRunID, 10), nil)
	request.SetPathValue("id", strconv.FormatInt(realRunID, 10))
	response = httptest.NewRecorder()
	s.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("real run detail status = %d, want 404", response.Code)
	}
	for _, run := range page.Runs {
		request = httptest.NewRequest(http.MethodGet, "/api/workflow-runs/"+strconv.FormatInt(run.ID, 10), nil)
		request.SetPathValue("id", strconv.FormatInt(run.ID, 10))
		response = httptest.NewRecorder()
		s.Routes().ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("example %s detail status = %d: %s", run.WorkflowCode, response.Code, response.Body.String())
		}
		var detail workflow.RunDetail
		if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil {
			t.Fatal(err)
		}
		if len(detail.NodeRuns) == 0 || detail.GraphJSON == "" {
			t.Fatalf("example %s has incomplete detail", run.WorkflowCode)
		}
	}
	for _, view := range []struct {
		name string
		want int64
	}{
		{name: "running", want: 1},
		{name: "attention", want: 3},
		{name: "history", want: int64(len(demoShowcaseWorkflowCodes))},
	} {
		response = httptest.NewRecorder()
		s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/workflow-runs?view="+view.name, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s workflow list status = %d: %s", view.name, response.Code, response.Body.String())
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		if page.Total != view.want {
			t.Fatalf("%s run count = %d, want %d", view.name, page.Total, view.want)
		}
	}
	var runningJobs, failedJobs int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_job AS job
		JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE run.trigger_reason = ? AND job.status = 'running'`, demoShowcaseRunReason).Scan(&runningJobs); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_job AS job
		JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE run.trigger_reason = ? AND job.status = 'failed'`, demoShowcaseRunReason).Scan(&failedJobs); err != nil {
		t.Fatal(err)
	}
	if runningJobs != 1 || failedJobs != 3 {
		t.Fatalf("example job states: running = %d, failed = %d", runningJobs, failedJobs)
	}
}
