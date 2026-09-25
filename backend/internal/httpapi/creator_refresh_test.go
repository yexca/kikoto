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

// An unknown maker id is never created by a read, per-user state, or a detail
// refresh; the circle follow workflow's catalog fetch is what adds it.
func TestUnknownCircleIsNotCreatedByDetailRequests(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('anonymous_access_enabled', 'true')`); err != nil {
		t.Fatal(err)
	}
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}

	member := currentUser{ID: 1, Permissions: []string{"library:read", "favorites:write", "tags:write"}}
	admin := currentUser{ID: 2, Permissions: []string{"library:read", "metadata:sync", "workflows:run"}}
	for _, item := range []struct {
		user    currentUser
		request *http.Request
	}{
		{member, httptest.NewRequest(http.MethodGet, "/api/circles/RG00001", nil)},
		{member, httptest.NewRequest(http.MethodPatch, "/api/circles/RG00001/user-state", strings.NewReader(`{"favorite":true}`))},
		{member, httptest.NewRequest(http.MethodPut, "/api/circles/RG00001/tags", strings.NewReader(`{"tags":["example"]}`))},
		{admin, httptest.NewRequest(http.MethodPost, "/api/circles/RG00001/refresh", strings.NewReader(`{"catalogRefresh":"full"}`))},
	} {
		request := item.request.WithContext(context.WithValue(item.request.Context(), currentUserKey, item.user))
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, request)
		var payload struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &payload)
		if response.Code != http.StatusNotFound || payload.Code != "circle_not_in_database" {
			t.Fatalf("%s %s status = %d, body = %s", request.Method, request.URL.Path, response.Code, response.Body.String())
		}
	}

	// A stored-catalog run reads only what this site has, so it cannot add one either.
	_, err := server.executeGraphCircleCatalog(context.Background(), 0, workflowGraphNode{
		Type: "circle_catalog", Config: map[string]any{"circleId": "RG00001", "mode": "stored"},
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "not in the database") {
		t.Fatalf("stored catalog error = %v, want an unknown-circle error", err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM party").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("requests created %d circles, want none", count)
	}
}

// A failed first fetch removes only an untouched placeholder.
func TestDiscardUnfetchedCircleKeepsCirclesWithState(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec("INSERT INTO user_account (id, username, role) VALUES (1, 'listener', 'user')"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	placeholder, err := server.ensurePlaceholderCircle(ctx, "RG00001")
	if err != nil {
		t.Fatal(err)
	}
	favorited, err := server.ensurePlaceholderCircle(ctx, "RG00002")
	if err != nil {
		t.Fatal(err)
	}
	if err := server.saveCircleUserState(ctx, 1, favorited, circleUserStateValues{favorite: 1}); err != nil {
		t.Fatal(err)
	}
	named, err := server.upsertDLsiteParty(ctx, "RG00003", "Example Circle", "{}")
	if err != nil {
		t.Fatal(err)
	}
	server.recordCircleCatalogRefreshFailure(ctx, placeholder, "full", 0)

	for _, item := range []struct {
		partyID int64
		want    bool
	}{{placeholder, true}, {favorited, false}, {named, false}} {
		discarded, err := server.discardUnfetchedCircle(ctx, item.partyID)
		if err != nil {
			t.Fatal(err)
		}
		if discarded != item.want {
			t.Fatalf("discard party %d = %v, want %v", item.partyID, discarded, item.want)
		}
	}
	var parties, snapshots int
	if err := db.QueryRow("SELECT COUNT(*) FROM party_external_id WHERE external_id = 'RG00001'").Scan(&parties); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM party_metadata_snapshot WHERE external_id = 'RG00001'").Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if parties != 0 || snapshots != 0 {
		t.Fatalf("placeholder left %d ids and %d snapshots", parties, snapshots)
	}
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

	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var runStatus, metadataStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'action'", queued.RunID).Scan(&metadataStatus); err != nil {
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
