package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

type roleBoundaryFixture struct {
	server  *Server
	handler http.Handler
	cookies map[string]*http.Cookie
}

// newRoleBoundaryFixture signs in one real account per role through the
// login route, so requests carry exactly what each role's session grants.
func newRoleBoundaryFixture(t *testing.T) roleBoundaryFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, RootUsername: "root", DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	createTestAdministrator(t, server, "root", "synthetic-password")
	root, err := server.accountStore.LoadByUsername(context.Background(), "root")
	if err != nil {
		t.Fatal(err)
	}
	fixture := roleBoundaryFixture{server: server, handler: server.Routes(), cookies: map[string]*http.Cookie{}}
	for _, role := range []string{"user", "contributor", "admin"} {
		username := "synthetic-" + role
		if _, err := server.accountStore.CreateManagedUser(context.Background(), account.CreateUserInput{
			Username: username, DisplayName: username, Role: role, Password: "synthetic-password", Enabled: true, ActorUserID: root.ID,
		}); err != nil {
			t.Fatal(err)
		}
		fixture.cookies[role] = loginTestSession(t, fixture.handler, username, "synthetic-password")
	}
	return fixture
}

func (fixture roleBoundaryFixture) request(role, method, target, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(fixture.cookies[role])
	response := httptest.NewRecorder()
	fixture.handler.ServeHTTP(response, request)
	return response
}

func TestRemoteActionsRequireTrackOrFetchCapability(t *testing.T) {
	fixture := newRoleBoundaryFixture(t)
	// No remote source is configured, so an allowed request ends in a
	// validation or not-found answer without any outbound request.
	routes := []struct{ method, target, body string }{
		{http.MethodPost, "/api/remote-sources/1/works/RJ00000001/track", `{}`},
		{http.MethodPost, "/api/remote-sources/1/works/RJ00000001/sync", `{"triggerReason":"mark_interest"}`},
		{http.MethodDelete, "/api/works/1/tracked-sources/1", ``},
		{http.MethodPost, "/api/works/RJ00000001/source-availability", `{}`},
		{http.MethodPost, "/api/remote-sources/1/works/RJ00000001/cache", `{"path":"track.mp3"}`},
		{http.MethodPost, "/api/media/1/cache", ``},
		{http.MethodPost, "/api/remote-sources/1/works/RJ00000001/fetch-plan", `{}`},
		{http.MethodPost, "/api/remote-sources/1/works/RJ00000001/fetch", `{}`},
		{http.MethodPost, "/api/remote-sources/1/works/RJ00000001/save-plan", `{}`},
		{http.MethodPost, "/api/remote-sources/1/works/RJ00000001/save", `{}`},
		{http.MethodPost, "/api/workflow-runs/remote-bulk", `{"action":"track","sourceId":1,"codes":["RJ00000001"]}`},
		{http.MethodPost, "/api/workflow-runs/remote-bulk", `{"action":"fetch","sourceId":1,"codes":["RJ00000001"]}`},
		{http.MethodPost, "/api/workflow-runs/remote-popular", `{"sourceId":1,"action":"track","limit":5,"skipTag":true}`},
	}
	for _, route := range routes {
		if response := fixture.request("user", route.method, route.target, route.body); response.Code != http.StatusForbidden {
			t.Errorf("user %s %s = %d, want 403: %s", route.method, route.target, response.Code, response.Body)
		}
		if response := fixture.request("contributor", route.method, route.target, route.body); response.Code == http.StatusForbidden || response.Code == http.StatusUnauthorized {
			t.Errorf("contributor %s %s = %d, want the permission check to pass: %s", route.method, route.target, response.Code, response.Body)
		}
	}
}

func TestContributorKeepsNoAdministrativeSurface(t *testing.T) {
	fixture := newRoleBoundaryFixture(t)
	routes := []struct{ method, target, body string }{
		{http.MethodDelete, "/api/media/1/local", ``},
		{http.MethodPost, "/api/media/cleanup", `{"locationIds":[1]}`},
		{http.MethodPost, "/api/cache/cleanup", `{}`},
		{http.MethodDelete, "/api/cache/transcodes", ``},
		{http.MethodPost, "/api/works/1/lyrics-fetch", `{}`},
		{http.MethodPost, "/api/workflow-runs/local-scan", `{}`},
		{http.MethodPost, "/api/workflow-runs/local-media-index", `{}`},
		{http.MethodPost, "/api/workflow-runs/source-presence-check", `{}`},
		{http.MethodPost, "/api/workflow-runs/dlsite-popular", `{}`},
		{http.MethodPost, "/api/works/1/metadata-sync", `{}`},
		{http.MethodPatch, "/api/works/1/manual-overrides", `{}`},
		{http.MethodPatch, "/api/settings", `{}`},
		{http.MethodPost, "/api/file-sources", `{}`},
		{http.MethodGet, "/api/users", ``},
		{http.MethodPost, "/api/workflow-runs/recover-stale", ``},
	}
	for _, route := range routes {
		if response := fixture.request("contributor", route.method, route.target, route.body); response.Code != http.StatusForbidden {
			t.Errorf("contributor %s %s = %d, want 403: %s", route.method, route.target, response.Code, response.Body)
		}
	}
	if response := fixture.request("contributor", http.MethodGet, "/api/workflow-runs", ``); response.Code != http.StatusOK {
		t.Fatalf("contributor run list = %d: %s", response.Code, response.Body)
	}
	if response := fixture.request("user", http.MethodGet, "/api/workflow-runs", ``); response.Code != http.StatusForbidden {
		t.Fatalf("user run list = %d: %s", response.Code, response.Body)
	}
}

func TestContributorManagesOnlyRunsItStarted(t *testing.T) {
	fixture := newRoleBoundaryFixture(t)
	contributor, err := fixture.server.accountStore.LoadByUsername(context.Background(), "synthetic-contributor")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := fixture.server.accountStore.LoadByUsername(context.Background(), "synthetic-admin")
	if err != nil {
		t.Fatal(err)
	}
	db := fixture.server.db
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, input_json) VALUES (1, 'remote_work_fetch', 'Fetch RJ00000001', 'running', 'manual', ?)`, []any{mustJSON(map[string]any{workflowRunRequesterKey: contributor.ID})}},
		{`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, input_json) VALUES (2, 'remote_work_fetch', 'Fetch RJ00000002', 'running', 'manual', ?)`, []any{mustJSON(map[string]any{workflowRunRequesterKey: admin.ID})}},
		{`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, input_json) VALUES (3, 'remote_work_fetch', 'Fetch RJ00000003', 'partial', 'manual', ?)`, []any{mustJSON(map[string]any{workflowRunRequesterKey: contributor.ID})}},
		{`INSERT INTO workflow_candidate (id, workflow_run_id, candidate_type, external_key, status, payload_json) VALUES (1, 3, 'local_fetch_merge_cleanup', 'RJ00000003', 'pending', '{}')`, nil},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	// Another account's run stays visible but cannot be changed.
	if response := fixture.request("contributor", http.MethodGet, "/api/workflow-runs/2", ``); response.Code != http.StatusOK {
		t.Fatalf("contributor view of another run = %d: %s", response.Code, response.Body)
	}
	if response := fixture.request("contributor", http.MethodPost, "/api/workflow-runs/2/cancel", ``); response.Code != http.StatusForbidden {
		t.Fatalf("contributor cancel of another run = %d: %s", response.Code, response.Body)
	}
	if response := fixture.request("contributor", http.MethodPost, "/api/workflow-runs/2/retry", ``); response.Code != http.StatusForbidden {
		t.Fatalf("contributor retry of another run = %d: %s", response.Code, response.Body)
	}
	if response := fixture.request("contributor", http.MethodPost, "/api/workflow-runs/1/cancel", ``); response.Code != http.StatusOK {
		t.Fatalf("contributor cancel of its own run = %d: %s", response.Code, response.Body)
	}
	if response := fixture.request("admin", http.MethodPost, "/api/workflow-runs/2/cancel", ``); response.Code != http.StatusOK {
		t.Fatalf("admin cancel = %d: %s", response.Code, response.Body)
	}
	// Resolving a Fetch archive review changes local files, which a
	// contributor may not do even for its own run.
	for _, route := range []struct{ method, target, body string }{
		{http.MethodPatch, "/api/workflow-candidates/1", `{"status":"resolved"}`},
		{http.MethodPost, "/api/workflow-candidates/1/local-cleanup", `{"action":"delete_files"}`},
		{http.MethodPost, "/api/workflow-candidates/1/archived-root-review", `{"action":"keep_archived"}`},
	} {
		if response := fixture.request("contributor", route.method, route.target, route.body); response.Code != http.StatusForbidden {
			t.Errorf("contributor %s %s = %d, want 403: %s", route.method, route.target, response.Code, response.Body)
		}
	}
}

func TestContributorCannotChangeTriggersItCouldNotCreate(t *testing.T) {
	fixture := newRoleBoundaryFixture(t)
	var definitionID, triggerID int64
	if err := fixture.server.db.QueryRow(`SELECT id FROM workflow_definition WHERE code = 'local_library_scan'`).Scan(&definitionID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.db.QueryRow(`SELECT id FROM workflow_trigger WHERE workflow_definition_id = ? ORDER BY id LIMIT 1`, definitionID).Scan(&triggerID); err != nil {
		t.Fatal(err)
	}
	var displayName, triggerType, scheduleJSON, configJSON string
	if err := fixture.server.db.QueryRow(`SELECT display_name, trigger_type, schedule_json, config_json FROM workflow_trigger WHERE id = ?`, triggerID).Scan(&displayName, &triggerType, &scheduleJSON, &configJSON); err != nil {
		t.Fatal(err)
	}
	pause := mustJSON(map[string]any{
		"workflowDefinitionId": definitionID, "displayName": displayName, "triggerType": triggerType,
		"enabled": false, "scheduleJson": scheduleJSON, "configJson": configJSON,
	})
	target := "/api/workflow-triggers/" + mustJSON(triggerID)
	if response := fixture.request("contributor", http.MethodPatch, target, pause); response.Code != http.StatusForbidden {
		t.Fatalf("contributor pause of a local scan trigger = %d: %s", response.Code, response.Body)
	}
	if response := fixture.request("contributor", http.MethodDelete, target, ``); response.Code != http.StatusForbidden {
		t.Fatalf("contributor delete of a local scan trigger = %d: %s", response.Code, response.Body)
	}
	if response := fixture.request("admin", http.MethodPatch, target, pause); response.Code != http.StatusOK {
		t.Fatalf("admin pause = %d: %s", response.Code, response.Body)
	}
}

func TestContributorRoleAssignment(t *testing.T) {
	if got := strings.Join(account.PermissionsForRole("contributor"), ","); got != "library:read,playback:use,favorites:write,tags:write,workflows:run,remote:track,remote:fetch" {
		t.Fatalf("contributor permissions = %s", got)
	}
	if got := strings.Join(account.PermissionsForRole("user"), ","); got != "library:read,playback:use,favorites:write,tags:write" {
		t.Fatalf("user permissions = %s", got)
	}
	if err := account.ValidateUserWrite(account.User{Role: "admin"}, "contributor", "", false); err != nil {
		t.Fatalf("admin assigning contributor: %v", err)
	}
}
