package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func patchSettingsAsSourceWriter(t *testing.T, server *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.updateSettings(response, request)
	return response
}

func TestUpdateSettingsValidatesAndPersistsMetadataProxy(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})

	response := patchSettingsAsSourceWriter(t, server, `{"metadataProxyUrl":" SOCKS5://192.0.2.10:1080/ "}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var settings appSettingsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	if settings.MetadataProxyURL != "socks5://192.0.2.10:1080" {
		t.Fatalf("metadata proxy = %q", settings.MetadataProxyURL)
	}

	for _, body := range []string{
		`{"metadataProxyUrl":"ftp://192.0.2.10:21"}`,
		`{"metadataProxyUrl":"http://192.0.2.10"}`,
		`{"metadataProxyUrl":"http://synthetic-user:synthetic-password@192.0.2.10:8080"}`,
		`{"metadataProxyUrl":"http://192.0.2.10:8080/path"}`,
	} {
		response := patchSettingsAsSourceWriter(t, server, body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d, want %d", body, response.Code, http.StatusBadRequest)
		}
		if strings.Contains(response.Body.String(), "synthetic-password") {
			t.Fatalf("validation error echoed credentials: %s", response.Body.String())
		}
	}
	if stored, err := server.loadMetadataProxyURL(context.Background()); err != nil || stored != "socks5://192.0.2.10:1080" {
		t.Fatalf("rejected update changed stored proxy to %q, error = %v", stored, err)
	}

	response = patchSettingsAsSourceWriter(t, server, `{"metadataProxyUrl":""}`)
	if response.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body = %s", response.Code, response.Body.String())
	}
	if stored, err := server.loadMetadataProxyURL(context.Background()); err != nil || stored != "" {
		t.Fatalf("cleared proxy = %q, error = %v", stored, err)
	}
}

func newConnectRecordingProxy(t *testing.T, targets *atomic.Value, count *atomic.Int32) *httptest.Server {
	t.Helper()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodConnect {
			targets.Store(request.Host)
			count.Add(1)
		}
		http.Error(w, "synthetic proxy refusal", http.StatusBadGateway)
	}))
	t.Cleanup(proxy.Close)
	return proxy
}

func TestMetadataClientFollowsProxySettingChanges(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	var firstTarget, secondTarget atomic.Value
	var firstCount, secondCount atomic.Int32
	first := newConnectRecordingProxy(t, &firstTarget, &firstCount)
	second := newConnectRecordingProxy(t, &secondTarget, &secondCount)

	if response := patchSettingsAsSourceWriter(t, server, `{"metadataProxyUrl":"`+first.URL+`"}`); response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := server.metadataHTTPClient.Get(server.dlsiteEndpoints.WorkURL("RJ00000001")); err == nil {
		t.Fatal("request through refusing proxy unexpectedly succeeded")
	}
	if firstCount.Load() != 1 || firstTarget.Load() != "www.dlsite.com:443" {
		t.Fatalf("first proxy saw %d CONNECT requests to %v", firstCount.Load(), firstTarget.Load())
	}

	if response := patchSettingsAsSourceWriter(t, server, `{"metadataProxyUrl":"`+second.URL+`"}`); response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if _, err := server.metadataHTTPClient.Get(server.dlsiteEndpoints.WorkURL("RJ00000001")); err == nil {
		t.Fatal("request through refusing proxy unexpectedly succeeded")
	}
	if firstCount.Load() != 1 || secondCount.Load() != 1 {
		t.Fatalf("proxy change was not applied: first=%d second=%d", firstCount.Load(), secondCount.Load())
	}
}

func TestMetadataClientFailsClosedForUnusableStoredProxy(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, '"ftp://192.0.2.10:21"')`, metadataProxySetting); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	_, err := server.metadataHTTPClient.Get(server.dlsiteEndpoints.WorkURL("RJ00000001"))
	if !errors.Is(err, errMetadataProxyUnavailable) {
		t.Fatalf("request with unusable stored proxy error = %v, want %v", err, errMetadataProxyUnavailable)
	}
}
