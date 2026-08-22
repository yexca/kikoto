package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func fileSourceCRUDRequest(method, target, body string, actor account.User) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
}

func TestFileSourceHandlersListUpdateAndDeleteConfiguredRemoteSources(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 1, Role: "admin", Permissions: []string{"sources:write"}}

	create := httptest.NewRecorder()
	server.createFileSource(create, fileSourceCRUDRequest(
		http.MethodPost,
		"/api/file-sources",
		`{
			"displayName":"Example Remote",
			"sourceType":"kikoeru_compatible",
			"priority":30,
			"enabled":false,
			"config":{"requestLanguage":"ja-JP"},
			"endpoint":{"apiUrl":"https://source.example.invalid/api","baseUrl":"https://source.example.invalid"}
		}`,
		actor,
	))
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	var created fileSourceSummary
	if err := json.NewDecoder(create.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}

	if _, err := db.Exec("INSERT INTO file_source (id, code, display_name, source_type) VALUES (99, 'main-local', 'Example Local', 'local_folder')"); err != nil {
		t.Fatal(err)
	}
	list := httptest.NewRecorder()
	server.listLibrarySources(list, fileSourceCRUDRequest(http.MethodGet, "/api/library-sources", "", actor))
	var sources []librarySource
	if err := json.NewDecoder(list.Body).Decode(&sources); err != nil {
		t.Fatal(err)
	}
	if list.Code != http.StatusOK || len(sources) != 1 || sources[0].ID != created.ID {
		t.Fatalf("list status = %d, sources = %#v", list.Code, sources)
	}

	updateBody := `{
		"displayName":"Example Remote Updated",
		"sourceType":"kikoeru_compatible",
		"priority":7,
		"enabled":false,
		"config":{"requestLanguage":"en-US"},
		"endpoint":{
			"apiUrl":"https://source.example.invalid/v2/api",
			"baseUrl":"https://source.example.invalid/v2",
			"fallbackUrl":"https://fallback.example.invalid",
			"restrictOutboundHosts":true,
			"allowedHostPatterns":["*.media.example.invalid"]
		}
	}`
	update := httptest.NewRecorder()
	updateRequest := fileSourceCRUDRequest(http.MethodPatch, "/api/file-sources/"+strconv.FormatInt(created.ID, 10), updateBody, actor)
	updateRequest.SetPathValue("id", strconv.FormatInt(created.ID, 10))
	server.updateFileSource(update, updateRequest)
	var updated fileSourceSummary
	if err := json.NewDecoder(update.Body).Decode(&updated); err != nil {
		t.Fatal(err)
	}
	if update.Code != http.StatusOK || updated.DisplayName != "Example Remote Updated" || updated.Priority != 7 || updated.Config.RequestLanguage != "en-US" || !updated.Endpoint.RestrictOutboundHosts {
		t.Fatalf("update status = %d, source = %#v", update.Code, updated)
	}

	badID := httptest.NewRecorder()
	badIDRequest := fileSourceCRUDRequest(http.MethodPatch, "/api/file-sources/nope", updateBody, actor)
	badIDRequest.SetPathValue("id", "nope")
	server.updateFileSource(badID, badIDRequest)
	if badID.Code != http.StatusBadRequest {
		t.Fatalf("invalid update id status = %d, body = %s", badID.Code, badID.Body.String())
	}

	missing := httptest.NewRecorder()
	missingRequest := fileSourceCRUDRequest(http.MethodPatch, "/api/file-sources/404", updateBody, actor)
	missingRequest.SetPathValue("id", "404")
	server.updateFileSource(missing, missingRequest)
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing update status = %d, body = %s", missing.Code, missing.Body.String())
	}

	localDelete := httptest.NewRecorder()
	localDeleteRequest := fileSourceCRUDRequest(http.MethodDelete, "/api/file-sources/99", "", actor)
	localDeleteRequest.SetPathValue("id", "99")
	server.deleteFileSource(localDelete, localDeleteRequest)
	if localDelete.Code != http.StatusNotFound {
		t.Fatalf("local delete status = %d, body = %s", localDelete.Code, localDelete.Body.String())
	}

	delete := httptest.NewRecorder()
	deleteRequest := fileSourceCRUDRequest(http.MethodDelete, "/api/file-sources/"+strconv.FormatInt(created.ID, 10), "", actor)
	deleteRequest.SetPathValue("id", strconv.FormatInt(created.ID, 10))
	server.deleteFileSource(delete, deleteRequest)
	if delete.Code != http.StatusOK {
		t.Fatalf("remote delete status = %d, body = %s", delete.Code, delete.Body.String())
	}
	var remaining int
	if err := db.QueryRow("SELECT COUNT(*) FROM file_source WHERE id = ?", created.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("deleted source count = %d, want 0", remaining)
	}
}
