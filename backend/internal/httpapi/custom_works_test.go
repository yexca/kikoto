package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func customWorkRequest(method, target, body string, permissions ...string) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{Permissions: permissions}))
}

func acceptCustomWorkNoticeForTest(t *testing.T, server *Server, permissions ...string) {
	t.Helper()
	response := httptest.NewRecorder()
	server.acceptCustomWorkNotice(response, customWorkRequest(http.MethodPost, "/api/custom-works/notice-acceptance", "{}", permissions...))
	if response.Code != http.StatusOK {
		t.Fatalf("accept notice = %d %s", response.Code, response.Body.String())
	}
}

func TestCustomWorkRenamesTheFolderSoEveryScanKeepsIt(t *testing.T) {
	root := t.TempDir()
	catalogCode := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	takenCode := testfixture.WorkCode(testfixture.PrefixKT, 1)
	writeCaseScanTrack(t, root, "Example Work 1")
	writeCaseScanTrack(t, root, "Shelf/"+catalogCode+" Example Work")
	// A folder that already carries the first custom code keeps it to itself.
	writeCaseScanTrack(t, root, "Example Work 2 ["+takenCode+"]")
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: root, LocalScanDepth: 2})
	permissions := []string{"library:write", "downloads:manage"}

	list := httptest.NewRecorder()
	server.listCustomWorkFolders(list, customWorkRequest(http.MethodGet, "/api/custom-works/folders", "", permissions...))
	var folders customWorkFoldersResponse
	if err := json.Unmarshal(list.Body.Bytes(), &folders); err != nil || list.Code != http.StatusOK {
		t.Fatalf("list = %d %s, %v", list.Code, list.Body.String(), err)
	}
	if len(folders.Folders) != 1 || folders.Folders[0].Path != "Example Work 1" || folders.NoticeAccepted {
		t.Fatalf("folders = %#v, want only Example Work 1 with the notice pending", folders)
	}

	// Nothing is renamed before an administrator accepts the notice.
	unaccepted := httptest.NewRecorder()
	server.createCustomWork(unaccepted, customWorkRequest(http.MethodPost, "/api/custom-works", `{"path":"Example Work 1"}`, permissions...))
	if unaccepted.Code != http.StatusConflict || !strings.Contains(unaccepted.Body.String(), "custom_work_notice_required") {
		t.Fatalf("create before the notice = %d %s, want the notice refusal", unaccepted.Code, unaccepted.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "Example Work 1")); err != nil {
		t.Fatalf("folder changed before the notice: %v", err)
	}
	acceptCustomWorkNoticeForTest(t, server, permissions...)

	refused := httptest.NewRecorder()
	server.createCustomWork(refused, customWorkRequest(http.MethodPost, "/api/custom-works", `{"path":"Example Work 1"}`, "library:write"))
	if refused.Code != http.StatusForbidden {
		t.Fatalf("create without downloads:manage = %d, want %d", refused.Code, http.StatusForbidden)
	}

	create := httptest.NewRecorder()
	server.createCustomWork(create, customWorkRequest(http.MethodPost, "/api/custom-works", `{"path":"Example Work 1","title":"Example Work"}`, permissions...))
	var created createCustomWorkResponse
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil || create.Code != http.StatusCreated {
		t.Fatalf("create = %d %s, %v", create.Code, create.Body.String(), err)
	}
	wantCode := testfixture.WorkCode(testfixture.PrefixKT, 2)
	wantPath := "Example Work 1 [" + wantCode + "]"
	if created.Code != wantCode || created.Path != wantPath || created.ScanRunID == 0 {
		t.Fatalf("created = %#v, want %s at %q with a scan", created, wantCode, wantPath)
	}
	if _, err := os.Stat(filepath.Join(root, "Example Work 1")); !os.IsNotExist(err) {
		t.Fatalf("original folder still exists: %v", err)
	}

	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "custom-work-test")
	if err != nil || !ok || job.RunID != created.ScanRunID {
		t.Fatalf("claim custom work scan = %#v, %t, %v", job, ok, err)
	}
	if err := server.executeLocalScanJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	assertCaseScanState(t, server, wantPath, "available", "active")
	executeLocalScanForTest(t, server)
	assertCaseScanState(t, server, wantPath, "available", "active")
	var title string
	if err := server.db.QueryRow("SELECT title FROM work WHERE id = ?", created.WorkID).Scan(&title); err != nil || title != "Example Work" {
		t.Fatalf("title = %q, %v; want the requested title", title, err)
	}

	again := httptest.NewRecorder()
	server.createCustomWork(again, customWorkRequest(http.MethodPost, "/api/custom-works", `{"path":"Example Work 1"}`, permissions...))
	if again.Code != http.StatusConflict {
		t.Fatalf("create from a renamed folder = %d, want %d", again.Code, http.StatusConflict)
	}
}

func TestCustomWorkRefusesAFolderThatHoldsAWork(t *testing.T) {
	root := t.TempDir()
	writeCaseScanTrack(t, root, "Shelf/"+testfixture.WorkCode(testfixture.PrefixRJ, 0))
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: root, LocalScanDepth: 2})
	acceptCustomWorkNoticeForTest(t, server, "library:write", "downloads:manage")

	response := httptest.NewRecorder()
	server.createCustomWork(response, customWorkRequest(http.MethodPost, "/api/custom-works", `{"path":"Shelf"}`, "library:write", "downloads:manage"))
	if response.Code != http.StatusConflict {
		t.Fatalf("create from a folder holding a work = %d, want %d", response.Code, http.StatusConflict)
	}
	if _, err := os.Stat(filepath.Join(root, "Shelf")); err != nil {
		t.Fatalf("refused folder changed: %v", err)
	}
	var works int
	if err := server.db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil || works != 0 {
		t.Fatalf("works = %d, %v; want none", works, err)
	}
}

func TestCustomWorkRefusesProviderAndRemoteSourceActions(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: t.TempDir()})
	code := testfixture.WorkCode(testfixture.PrefixKT, 0)
	inserted, err := server.db.Exec("INSERT INTO work (primary_code, title) VALUES (?, 'Example Work')", code)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := inserted.LastInsertId()
	id := strconv.FormatInt(workID, 10)
	parentCode := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	permissions := []string{"metadata:sync", "library:write", "downloads:manage", "remote:track", "remote:fetch", "workflows:run"}
	remote := "/api/remote-sources/1/works/" + code
	remoteValues := map[string]string{"id": "1", "code": code}
	for _, action := range []struct {
		name    string
		handler http.HandlerFunc
		method  string
		target  string
		body    string
		values  map[string]string
	}{
		{"metadata sync", server.createWorkMetadataSyncRun, http.MethodPost, "/api/works/" + id + "/metadata-sync", "", map[string]string{"id": id}},
		{"metadata preview", server.createWorkMetadataPreview, http.MethodPost, "/api/works/" + id + "/metadata-preview", "", map[string]string{"id": id}},
		{"metadata link", server.setWorkMetadataLink, http.MethodPut, "/api/works/" + id + "/metadata-link", `{"sourceCode":"` + parentCode + `"}`, map[string]string{"id": id}},
		{"purchase bonus", server.setWorkPurchaseBonus, http.MethodPut, "/api/works/" + id + "/purchase-bonus", `{"parentCode":"` + parentCode + `"}`, map[string]string{"id": id}},
		{"bundle member", server.addWorkBundleMember, http.MethodPut, "/api/works/" + id + "/bundle-members/" + parentCode, "", map[string]string{"id": id, "code": parentCode}},
		{"source check", server.checkWorkSourceAvailabilityNow, http.MethodPost, "/api/works/" + code + "/source-availability", "{}", map[string]string{"code": code}},
		{"folder edit source check", server.checkWorkFolderEditSources, http.MethodPost, "/api/works/" + id + "/folder-edit/sources/check", "{}", map[string]string{"id": id}},
		{"remote work", server.getRemoteSourceWork, http.MethodGet, remote, "", remoteValues},
		{"remote tracks", server.getRemoteSourceWorkTracks, http.MethodGet, remote + "/tracks", "", remoteValues},
		{"remote Fetch plan", server.planRemoteSourceWorkSave, http.MethodPost, remote + "/fetch-plan", "{}", remoteValues},
		{"remote Fetch", server.saveRemoteSourceWork, http.MethodPost, remote + "/fetch", "{}", remoteValues},
		{"remote track", server.trackRemoteSourceWork, http.MethodPost, remote + "/track", "{}", remoteValues},
		{"remote sync", server.syncRemoteSourceWork, http.MethodPost, remote + "/sync", "{}", remoteValues},
		{"remote cache", server.cacheRemoteSourceWorkMedia, http.MethodPost, remote + "/cache", "{}", remoteValues},
		{"remote bulk", server.createRemoteBulkRun, http.MethodPost, "/api/workflow-runs/remote-bulk", `{"sourceId":1,"action":"fetch","codes":["` + code + `"]}`, nil},
	} {
		request := customWorkRequest(action.method, action.target, action.body, permissions...)
		for key, value := range action.values {
			request.SetPathValue(key, value)
		}
		response := httptest.NewRecorder()
		action.handler(response, request)
		if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "custom_work_unsupported") {
			t.Fatalf("%s = %d %s, want the custom work refusal", action.name, response.Code, response.Body.String())
		}
	}
	var runs int
	if err := server.db.QueryRow("SELECT COUNT(*) FROM workflow_run").Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("workflow runs = %d, %v; want none", runs, err)
	}
	detail, err := server.loadWorkDetail(context.Background(), 0, workID, false)
	if err != nil || !detail.CustomWork || detail.DLsiteURL != "" {
		t.Fatalf("detail customWork = %t dlsiteUrl = %q, %v", detail.CustomWork, detail.DLsiteURL, err)
	}
}

func TestCustomWorkRefusesAFolderARunningEditWritesInto(t *testing.T) {
	root := t.TempDir()
	writeCaseScanTrack(t, root, "Incoming/Example Track")
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: root, LocalScanDepth: 2})
	permissions := []string{"library:write", "downloads:manage"}
	acceptCustomWorkNoticeForTest(t, server, permissions...)
	// A queued Edit files run publishes a work folder inside it that does not
	// exist yet.
	payload := `{"target_root":"Incoming/` + testfixture.WorkCode(testfixture.PrefixRJ, 0) + `"}`
	for _, statement := range []string{
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('` + workFolderEditWorkflowCode + `', 'Edit files')`,
		`INSERT INTO workflow_run (workflow_definition_id, workflow_code, display_name, status, trigger_type, input_json)
			VALUES ((SELECT id FROM workflow_definition WHERE code = '` + workFolderEditWorkflowCode + `'), '` + workFolderEditWorkflowCode + `', 'Edit files', 'queued', 'manual', '{}')`,
		`INSERT INTO workflow_job (workflow_run_id, worker_type, status, payload_json) VALUES (last_insert_rowid(), '` + workFolderEditWorkerType + `', 'queued', '` + payload + `')`,
	} {
		if _, err := server.db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	response := httptest.NewRecorder()
	server.createCustomWork(response, customWorkRequest(http.MethodPost, "/api/custom-works", `{"path":"Incoming"}`, permissions...))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), errCustomWorkFolderInUse.Error()) {
		t.Fatalf("create from a folder a running edit writes into = %d %s, want %d", response.Code, response.Body.String(), http.StatusConflict)
	}
	if _, err := os.Stat(filepath.Join(root, "Incoming")); err != nil {
		t.Fatalf("refused folder changed: %v", err)
	}
}

func TestCustomWorkWaitsForJobsThatChangeLibraryFolders(t *testing.T) {
	root := t.TempDir()
	writeCaseScanTrack(t, root, "Example Work")
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: root, LocalScanDepth: 2})
	permissions := []string{"library:write", "downloads:manage"}
	acceptCustomWorkNoticeForTest(t, server, permissions...)
	// A running Edit files job, cleanup, scan, or Fetch publication holds the
	// media:cleanup resource.
	server.mediaCleanupMu.Lock()
	response := httptest.NewRecorder()
	server.createCustomWork(response, customWorkRequest(http.MethodPost, "/api/custom-works", `{"path":"Example Work"}`, permissions...))
	server.mediaCleanupMu.Unlock()
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "custom_work_library_busy") {
		t.Fatalf("create while library folders change = %d %s, want the busy refusal", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(root, "Example Work")); err != nil {
		t.Fatalf("folder changed while busy: %v", err)
	}
}

func TestRenameNoReplaceKeepsAnExistingTarget(t *testing.T) {
	root := t.TempDir()
	from, to := filepath.Join(root, "Example Work"), filepath.Join(root, "Example Work [KT00000001]")
	for _, folder := range []string{from, to} {
		if err := os.Mkdir(folder, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := renameNoReplace(from, to); !errors.Is(err, os.ErrExist) {
		t.Fatalf("rename onto an existing folder = %v, want os.ErrExist", err)
	}
	for _, folder := range []string{from, to} {
		if _, err := os.Stat(folder); err != nil {
			t.Fatalf("%s after the refused rename: %v", folder, err)
		}
	}
	if err := os.Remove(to); err != nil {
		t.Fatal(err)
	}
	if err := renameNoReplace(from, to); err != nil {
		t.Fatalf("rename onto a free name = %v", err)
	}
}
