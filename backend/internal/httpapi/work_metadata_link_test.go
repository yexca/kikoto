package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func metadataLinkRequest(method string, workID int64, body string, permissions ...string) *http.Request {
	request := httptest.NewRequest(method, "/api/works/"+strconv.FormatInt(workID, 10)+"/metadata-link", strings.NewReader(body))
	request.SetPathValue("id", strconv.FormatInt(workID, 10))
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{Permissions: permissions}))
}

func TestWorkMetadataLinkRechecksAnUnavailableWorkFromTheLinkedCode(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	result, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ00000050', 'Bonus edition')`)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := result.LastInsertId()
	if _, err := db.Exec(`INSERT INTO work_metadata_provider_state (work_id, provider_id, status, message)
		SELECT ?, id, 'not_found', 'Metadata product not found' FROM metadata_provider WHERE code = 'dlsite'`, workID); err != nil {
		t.Fatal(err)
	}

	for _, body := range []string{`{"sourceCode":"RJ00000050"}`, `{"sourceCode":"not-a-code"}`, `{invalid`} {
		response := httptest.NewRecorder()
		server.setWorkMetadataLink(response, metadataLinkRequest(http.MethodPut, workID, body, "library:write", "metadata:sync"))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d, want %d", body, response.Code, http.StatusBadRequest)
		}
	}
	forbidden := httptest.NewRecorder()
	server.setWorkMetadataLink(forbidden, metadataLinkRequest(http.MethodPut, workID, `{"sourceCode":"RJ00000051"}`, "library:read", "metadata:sync"))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("read-only status = %d, want %d", forbidden.Code, http.StatusForbidden)
	}

	response := httptest.NewRecorder()
	server.setWorkMetadataLink(response, metadataLinkRequest(http.MethodPut, workID, `{"sourceCode":" rj00000051 "}`, "library:write", "metadata:sync"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	var saved workMetadataLinkResponse
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Link == nil || saved.Link.SourceCode != "RJ00000051" || !strings.Contains(saved.Link.URL, "RJ00000051") {
		t.Fatalf("saved link = %+v, want normalized RJ00000051", saved.Link)
	}
	if saved.Sync == nil || saved.Sync.RunID == 0 || saved.Sync.Status == "unavailable" {
		t.Fatalf("sync = %+v, want a queued recheck despite the not_found state", saved.Sync)
	}

	detail, err := server.loadWorkDetail(context.Background(), 0, workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail.MetadataLink == nil || detail.MetadataLink.SourceCode != "RJ00000051" {
		t.Fatalf("detail link = %+v", detail.MetadataLink)
	}
	var works int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000051'`).Scan(&works); err != nil {
		t.Fatal(err)
	}
	if works != 0 {
		t.Fatalf("linking created %d works for the source code", works)
	}

	deleted := httptest.NewRecorder()
	server.deleteWorkMetadataLink(deleted, metadataLinkRequest(http.MethodDelete, workID, "", "library:write"))
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status = %d", deleted.Code)
	}
	if link, err := server.loadWorkMetadataLink(context.Background(), workID); err != nil || link != nil {
		t.Fatalf("link after delete = %+v, %v", link, err)
	}
}

func TestWorkMetadataLinkWithoutSyncPermissionOnlyStoresTheLink(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	result, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ00000052', 'Local')`)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := result.LastInsertId()
	response := httptest.NewRecorder()
	server.setWorkMetadataLink(response, metadataLinkRequest(http.MethodPut, workID, `{"sourceCode":"RJ00000053"}`, "library:write"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
	}
	var saved workMetadataLinkResponse
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Link == nil || saved.Sync != nil {
		t.Fatalf("response = %+v, want a stored link without a sync run", saved)
	}
	var runs int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'metadata_family_sync'`).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 0 {
		t.Fatalf("metadata runs = %d, want none", runs)
	}
}
