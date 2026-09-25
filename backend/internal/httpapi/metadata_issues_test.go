package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

type recoveryMetadataClient struct{ failure error }

func (c *recoveryMetadataClient) FetchProduct(_ context.Context, code string) (dlsite.Product, error) {
	return dlsite.Product{WorkNo: code, ProductName: "Fresh provider metadata", Language: "ja-jp"}, c.failure
}
func (*recoveryMetadataClient) DownloadCover(context.Context, dlsite.Product, string) (string, error) {
	return "", nil
}

func seedMetadataIssue(t *testing.T, db *sql.DB, index int) int64 {
	t.Helper()
	result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?, 'Synthetic failed work')", testfixture.WorkCode(testfixture.PrefixRJ, index))
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_metadata_sync_state(work_id,provider_id,component,attempt_id,status,failure_count,first_failed_at) SELECT ?,id,'metadata',1,'unavailable',1,CURRENT_TIMESTAMP FROM metadata_provider WHERE code='dlsite'`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_metadata_provider_state(work_id,provider_id,status,message) SELECT ?,id,'not_found','private diagnostic' FROM metadata_provider WHERE code='dlsite'`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func metadataRequest(handler http.HandlerFunc, method, url, body string, permissions ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req = req.WithContext(context.WithValue(req.Context(), currentUserKey, currentUser{ID: 1, Permissions: permissions}))
	res := httptest.NewRecorder()
	handler(res, req)
	return res
}

func TestMetadataIssuesPermissionsAndPrivateRunFiltering(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	seedMetadataIssue(t, db, 0)
	for _, handler := range []http.HandlerFunc{s.listMetadataIssues, s.retryMetadataIssues} {
		response := metadataRequest(handler, http.MethodGet, "/api/metadata/issues", "", "sources:write")
		if response.Code != http.StatusForbidden {
			t.Fatalf("sources-only access=%d", response.Code)
		}
	}
	response := metadataRequest(s.listMetadataIssues, http.MethodGet, "/api/metadata/issues", "", "metadata:sync")
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "private diagnostic") || strings.Contains(response.Body.String(), "workflow") {
		t.Fatalf("shared response=%d %s", response.Code, response.Body)
	}
	if _, err := db.Exec(`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type,trigger_reason,input_json) VALUES (81,'custom','Private workflow','failed','manual','custom_definition','{"requested_by_user_id":2}')`); err != nil {
		t.Fatal(err)
	}
	response = metadataRequest(s.listMetadataIssues, http.MethodGet, "/api/metadata/issues?runId=81", "", "metadata:sync", "workflows:run")
	if response.Code != http.StatusForbidden {
		t.Fatalf("private run=%d %s", response.Code, response.Body)
	}
	for _, query := range []string{"page=0", "page=abc", "status=bad", "runId=-1", "q=" + strings.Repeat("x", 257)} {
		response := metadataRequest(s.listMetadataIssues, http.MethodGet, "/api/metadata/issues?"+query, "", "metadata:sync")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("query %q=%d", query, response.Code)
		}
	}
}

func TestMetadataRecoveryRechecksUnavailableAndKeepsReviews(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	workID := seedMetadataIssue(t, db, 0)
	userID := insertWorkflowGraphAPIUser(t, db, "metadata-reviewer")
	if _, err := db.Exec(`INSERT INTO work_manual_override(work_id,field_name,value_json,updated_by_user_id) VALUES (?,'title','"Manual title"',?)`, workID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO app_setting(key,value_json) VALUES ('remote_request_delay_base_seconds','0')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type) VALUES (81,'metadata_sync','Old metadata sync','failed','manual')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO workflow_run_review(workflow_run_id,user_id,status) VALUES (81,?,'resolved')`, userID); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"workIds":[%d]}`, workID)
	for range 2 {
		response := metadataRequest(s.retryMetadataIssues, http.MethodPost, "/api/metadata/issues/retry", body, "metadata:sync")
		if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"queued":1`) {
			t.Fatalf("retry=%d %s", response.Code, response.Body)
		}
	}
	var jobs int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_job WHERE worker_type='metadata_family_sync'`).Scan(&jobs); err != nil || jobs != 1 {
		t.Fatalf("jobs=%d %v", jobs, err)
	}
	response := metadataRequest(s.listMetadataIssues, http.MethodGet, "/api/metadata/issues", "", "metadata:sync")
	var page metasync.IssuePage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || page.Total != 1 || !page.Items[0].Retrying {
		t.Fatalf("queued issue=%s %v", response.Body, err)
	}
	// The ordinary detail refresh still sees not_found until actual success.
	ordinary, err := s.enqueueWorkMetadataSync(context.Background(), workID)
	if err != nil || ordinary.Status != "unavailable" {
		t.Fatalf("not_found cleared before fetch: %+v %v", ordinary, err)
	}
	s.dlsiteClient = &recoveryMetadataClient{}
	if err := s.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var title, manualTitle string
	if err := db.QueryRow(`SELECT work.title,override.value_json FROM work JOIN work_manual_override AS override ON override.work_id=work.id AND override.field_name='title' WHERE work.id=?`, workID).Scan(&title, &manualTitle); err != nil {
		t.Fatal(err)
	}
	if title != "Fresh provider metadata" || manualTitle != `"Manual title"` {
		t.Fatalf("provider/manual metadata=%q/%q", title, manualTitle)
	}
	response = metadataRequest(s.retryMetadataIssues, http.MethodPost, "/api/metadata/issues/retry", body, "metadata:sync")
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"skipped":1`) {
		t.Fatalf("resolved retry=%d %s", response.Code, response.Body)
	}
	var runStatus, reviewStatus string
	if err := db.QueryRow(`SELECT run.status,review.status FROM workflow_run AS run JOIN workflow_run_review AS review ON review.workflow_run_id=run.id WHERE run.id=81`).Scan(&runStatus, &reviewStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "failed" || reviewStatus != "resolved" {
		t.Fatalf("history changed: %s/%s", runStatus, reviewStatus)
	}
}

func TestMetadataJobFailuresExposeRunRecoverySummary(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	workID := seedMetadataIssue(t, db, 0)
	if _, err := db.Exec(`INSERT INTO app_setting(key,value_json) VALUES ('remote_request_delay_base_seconds','0')`); err != nil {
		t.Fatal(err)
	}
	s.dlsiteClient = &recoveryMetadataClient{failure: dlsite.ErrNoProduct}
	run, err := s.enqueueWorkMetadataSyncWithOptions(context.Background(), workID, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/workflow-runs/"+strconv.FormatInt(run.RunID, 10), nil)
	request.SetPathValue("id", strconv.FormatInt(run.RunID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"metadata:sync", "workflows:run"}}))
	response := httptest.NewRecorder()
	s.getWorkflowRun(response, request)
	var detail struct {
		ID     int64                    `json:"id"`
		Issues metasync.RunIssueSummary `json:"metadataIssues"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil || response.Code != http.StatusOK || detail.ID != run.RunID || detail.Issues.Encountered != 1 || detail.Issues.Pending != 1 {
		t.Fatalf("run detail=%d %s, %v", response.Code, response.Body, err)
	}
	response = metadataRequest(s.listMetadataIssues, http.MethodGet, "/api/metadata/issues?runId="+strconv.FormatInt(run.RunID, 10), "", "metadata:sync", "workflows:run")
	var page metasync.IssuePage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != http.StatusOK || page.Total != 1 {
		t.Fatalf("filtered recovery=%d %s %v", response.Code, response.Body, err)
	}
}

func TestMetadataIssueRetryRejectsInvalidSelectionsBeforeQueuing(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	id := seedMetadataIssue(t, db, 0)
	for _, body := range []string{`{}`, `{"workIds":[]}`, `{"workIds":[0]}`, fmt.Sprintf(`{"workIds":[%d,%d]}`, id, id), `{"workIds":[1],"extra":true}`, `{"workIds":[1]} {}`, `{"workIds":[` + strings.Repeat(strconv.FormatInt(id, 10)+",", 100) + "1]}"} {
		response := metadataRequest(s.retryMetadataIssues, http.MethodPost, "/api/metadata/issues/retry", body, "metadata:sync")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid body status=%d body=%s", response.Code, response.Body)
		}
	}
	var jobs int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job").Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("invalid requests queued jobs: %d, %v", jobs, err)
	}
}
