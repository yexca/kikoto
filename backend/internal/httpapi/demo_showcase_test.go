package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

func TestDemoShowcaseKeepsEligibleTrackedWorksStable(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{Mode: config.ModeDemo})
	if err := s.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source (code, display_name, source_type)
		VALUES ('example_local', 'Example Local', 'local_folder')`); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 7; index++ {
		code := "RJ0000000" + strconv.Itoa(index)
		age := "general"
		free := 1
		if index == 5 {
			age = "adult"
		}
		if index == 6 {
			free = 0
		}
		if _, err := db.Exec(`INSERT INTO work (primary_code, title, age_rating, is_permanently_free)
			VALUES (?, 'Example Work', ?, ?)`, code, age, free); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability)
			VALUES ((SELECT id FROM work WHERE primary_code = ?),
				(SELECT id FROM file_source WHERE code = 'example_local'), 'local', 'available')`, code); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.SeedDemoShowcase(context.Background()); err != nil {
		t.Fatal(err)
	}
	first := demoShowcaseTrackedCodes(t, db)
	if len(first) != 4 {
		t.Fatalf("tracked example count = %d, want 4", len(first))
	}
	for _, code := range first {
		if code == "RJ00000005" || code == "RJ00000006" {
			t.Fatalf("ineligible work %s was tracked", code)
		}
	}
	listResponse := httptest.NewRecorder()
	s.listWorks(listResponse, httptest.NewRequest(http.MethodGet, "/api/works?scope=tracked", nil))
	if listResponse.Code != http.StatusOK {
		t.Fatalf("tracked library status = %d: %s", listResponse.Code, listResponse.Body.String())
	}
	var trackedPage struct {
		Works []libraryWorkSummary `json:"works"`
		Total int                  `json:"total"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &trackedPage); err != nil {
		t.Fatal(err)
	}
	if trackedPage.Total != 4 || len(trackedPage.Works) != 4 {
		t.Fatalf("tracked library page = %#v", trackedPage)
	}
	for _, work := range trackedPage.Works {
		found := false
		for _, presence := range work.SourcePresence {
			if presence.Type == "tracked" && presence.FileSourceType == "demo_showcase" {
				found = true
			}
		}
		if !found {
			t.Fatalf("work %s lacks Demo tracked source type", work.PrimaryCode)
		}
	}
	if err := s.SeedDemoShowcase(context.Background()); err != nil {
		t.Fatal(err)
	}
	second := demoShowcaseTrackedCodes(t, db)
	if len(first) != len(second) {
		t.Fatalf("tracked selection changed from %v to %v", first, second)
	}
	for index := range first {
		if first[index] != second[index] {
			t.Fatalf("tracked selection changed from %v to %v", first, second)
		}
	}
	var runs int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE trigger_reason = ?", demoShowcaseRunReason).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	wantRuns := len(demoShowcaseWorkflowCodes) + len(demoShowcaseActivityExamples)
	if runs != wantRuns {
		t.Fatalf("showcase run count = %d, want %d", runs, wantRuns)
	}
	if _, err := db.Exec("UPDATE work SET is_permanently_free = NULL WHERE primary_code = ?", first[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedDemoShowcase(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, code := range demoShowcaseTrackedCodes(t, db) {
		if code == first[0] {
			t.Fatalf("stale tracked work %s survived eligibility loss", code)
		}
	}
}

func demoShowcaseTrackedCodes(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT work.primary_code FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE source.code = ? AND presence.presence_type = 'tracked'
		ORDER BY work.primary_code`, demoShowcaseSourceCode)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			t.Fatal(err)
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return codes
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
