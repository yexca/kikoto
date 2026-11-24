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
)

// A stored source setting that cannot be decoded must not turn into defaults:
// the source is listed as unavailable, sends nothing upstream, and works again
// once an administrator saves it.
func TestRemoteSourceWithUnreadableStoredSettingsIsNotUsedUntilSaved(t *testing.T) {
	var upstreamRequests atomic.Int64
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests.Add(1)
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode("ok")
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	// requestLanguage has the wrong type, so config_json does not decode.
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type, enabled, config_json)
		VALUES (1, 'remote', 'Example Remote', 'kikoeru_compatible', 1,
			'{"requestLanguage":5,"saveRootTemplate":"/data/example/<work_code>"}')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, health_status)
		VALUES (1, ?, ?, 'healthy')
	`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 1, Role: "admin", Permissions: []string{"sources:write"}}

	list := httptest.NewRecorder()
	server.listFileSources(list, fileSourceCRUDRequest(http.MethodGet, "/api/file-sources", "", actor))
	var listed []fileSourceSummary
	if err := json.NewDecoder(list.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if list.Code != http.StatusOK || len(listed) != 1 || listed[0].HealthStatus != "unavailable" ||
		listed[0].Config.SaveRootTemplate != "/data/example/<work_code>" {
		t.Fatalf("list status = %d, sources = %#v", list.Code, listed)
	}

	sources, err := server.loadRemoteSourcesForAvailability(context.Background())
	if err != nil || len(sources) != 0 {
		t.Fatalf("usable sources = %#v, err = %v", sources, err)
	}

	check := func() *httptest.ResponseRecorder {
		request := fileSourceCRUDRequest(http.MethodPost, "/api/file-sources/1/health-check", "", actor)
		request.SetPathValue("id", "1")
		response := httptest.NewRecorder()
		server.checkFileSourceHealth(response, request)
		return response
	}
	refused := check()
	if refused.Code != http.StatusConflict || !strings.Contains(refused.Body.String(), "source_not_usable") || upstreamRequests.Load() != 0 {
		t.Fatalf("health check status = %d, body = %s, upstream requests = %d", refused.Code, refused.Body.String(), upstreamRequests.Load())
	}

	save := fileSourceCRUDRequest(http.MethodPatch, "/api/file-sources/1", `{
		"displayName":"Example Remote",
		"sourceType":"kikoeru_compatible",
		"enabled":true,
		"config":{"requestLanguage":"ja-JP","saveRootTemplate":"/data/example/<work_code>"},
		"endpoint":{"apiUrl":"`+remote.URL+`","baseUrl":"`+remote.URL+`"}
	}`, actor)
	save.SetPathValue("id", "1")
	saved := httptest.NewRecorder()
	server.updateFileSource(saved, save)
	if saved.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", saved.Code, saved.Body.String())
	}
	if healthy := check(); healthy.Code != http.StatusOK {
		t.Fatalf("health check after save status = %d, body = %s", healthy.Code, healthy.Body.String())
	}
}
