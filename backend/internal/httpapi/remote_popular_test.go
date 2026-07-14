package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestRemotePopularWorkflowQueuesThenTracksAndTags(t *testing.T) {
	var remoteRequests atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		remoteRequests.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/recommender/popular" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{
			Works: []kikoeru.Work{
				{ID: 11, SourceID: "RJ09991001", Title: "First popular work"},
				{ID: 12, SourceID: "RJ09991002", Title: "Second popular work"},
			},
			Pagination: kikoeru.Pagination{Page: 1, PageSize: 25, TotalCount: 2},
		})
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('remote-popular-user', 'Remote Popular User', 'admin')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'remote_test', 'Remote Test', 'kikoeru_compatible', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/remote-popular", strings.NewReader(`{"sourceId":1,"action":"track","limit":25,"tagName":"remote-popular-test"}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: userID, Permissions: []string{"workflows:run", "tags:write"}}))
	response := httptest.NewRecorder()
	server.createRemotePopularCollectionRun(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if remoteRequests.Load() != 0 {
		t.Fatalf("HTTP handler made %d remote requests before the queued worker ran", remoteRequests.Load())
	}
	var queued remoteCollectionRunResult
	if err := json.Unmarshal(response.Body.Bytes(), &queued); err != nil {
		t.Fatal(err)
	}
	if queued.RunID <= 0 || queued.Status != "queued" || queued.TagName != "remote-popular-test" {
		t.Fatalf("queued = %+v", queued)
	}

	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "remote-popular-test-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %+v, %v, %v", job, ok, err)
	}
	if err := server.executeRemotePopularCollectionJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if remoteRequests.Load() != 1 {
		t.Fatalf("worker remote requests = %d, want 1", remoteRequests.Load())
	}
	var status, summary string
	if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || !strings.Contains(summary, `"tracked":2`) || !strings.Contains(summary, `"tagged":2`) {
		t.Fatalf("status = %s, summary = %s", status, summary)
	}
	var assignments int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_work_tag WHERE user_id = ?", userID).Scan(&assignments); err != nil {
		t.Fatal(err)
	}
	if assignments != 2 {
		t.Fatalf("tag assignments = %d, want 2", assignments)
	}
}

func TestRemotePopularFetchRequiresDownloadsManage(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/remote-popular", strings.NewReader(`{"sourceId":1,"action":"fetch","limit":25,"tagName":"remote-popular-test"}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: 1, Permissions: []string{"workflows:run", "tags:write"}}))
	response := httptest.NewRecorder()
	server.createRemotePopularCollectionRun(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}
