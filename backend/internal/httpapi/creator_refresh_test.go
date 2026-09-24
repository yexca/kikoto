package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func postCircleRefresh(t *testing.T, server *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/circles/RG00001/refresh", strings.NewReader(body))
	request.SetPathValue("externalId", "RG00001")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"metadata:sync"}}))
	response := httptest.NewRecorder()
	server.refreshCircle(response, request)
	return response
}

func TestCircleRefreshQueuesARefreshOnlyFollowRun(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO party (id, display_name) VALUES (1, 'Example Circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id) SELECT 1, id, 'maker_id', 'RG00001' FROM metadata_provider WHERE code = 'dlsite'",
		`INSERT INTO app_setting (key, value_json) VALUES ('anonymous_access_enabled', 'true')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}

	// The request only queues the run; no provider request happens inline.
	retry := `{"catalogRefresh":"stored","metadataRefresh":"missing"}`
	response := postCircleRefresh(t, server, retry)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var queued creatorRefreshRun
	if err := json.Unmarshal(response.Body.Bytes(), &queued); err != nil {
		t.Fatal(err)
	}
	if queued.RunID <= 0 || queued.Status != "queued" || queued.Deduplicated {
		t.Fatalf("queued = %+v", queued)
	}
	var code string
	if err := db.QueryRow("SELECT workflow_code FROM workflow_run WHERE id = ?", queued.RunID).Scan(&code); err != nil {
		t.Fatal(err)
	}
	if code != "circle_follow" {
		t.Fatalf("detail refresh workflow = %q, want circle_follow", code)
	}

	// Repeating the same refresh joins the active run; a different one conflicts.
	response = postCircleRefresh(t, server, retry)
	var repeated creatorRefreshRun
	if err := json.Unmarshal(response.Body.Bytes(), &repeated); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusAccepted || repeated.RunID != queued.RunID || !repeated.Deduplicated {
		t.Fatalf("repeat status = %d, body = %s", response.Code, response.Body.String())
	}
	if response = postCircleRefresh(t, server, `{"catalogRefresh":"full","metadataRefresh":"missing"}`); response.Code != http.StatusConflict {
		t.Fatalf("different refresh status = %d, want %d", response.Code, http.StatusConflict)
	}

	if err := server.runNextQueuedWorkflowJob(context.Background(), "circle-refresh-test"); err != nil {
		t.Fatal(err)
	}
	var runStatus, metadataStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'metadata'", queued.RunID).Scan(&metadataStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" || metadataStatus != "succeeded" {
		t.Fatalf("run status = %q, metadata step = %q", runStatus, metadataStatus)
	}

	// The circle detail exposes the newest follow run so the page can follow it.
	detailResponse := httptest.NewRecorder()
	server.Routes().ServeHTTP(detailResponse, httptest.NewRequest(http.MethodGet, "/api/circles/RG00001", nil))
	if detailResponse.Code != http.StatusOK {
		t.Fatalf("detail status = %d, body = %s", detailResponse.Code, detailResponse.Body.String())
	}
	var detail struct {
		Refresh *creatorRefreshRun `json:"refresh"`
	}
	if err := json.Unmarshal(detailResponse.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Refresh == nil || detail.Refresh.RunID != queued.RunID || detail.Refresh.Status != "succeeded" {
		t.Fatalf("detail refresh = %+v", detail.Refresh)
	}
}
