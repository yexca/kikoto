package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
