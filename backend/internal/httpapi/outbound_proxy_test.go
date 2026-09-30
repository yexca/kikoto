package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/proxyconfig"
)

func patchSettingsAsSourceWriter(t *testing.T, server *Server, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.updateSettings(response, request)
	return response
}

// proxySettingsBody builds a settings PATCH body with a proxy configuration.
func proxySettingsBody(t *testing.T, proxies []map[string]any, routes map[string]any) string {
	t.Helper()
	for _, scope := range []string{"dlsite", "remote", "other"} {
		if _, ok := routes[scope]; !ok {
			routes[scope] = map[string]any{"enabled": false, "proxyIds": []string{}}
		}
	}
	encoded, err := json.Marshal(map[string]any{"proxy": map[string]any{"proxies": proxies, "routes": routes}})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func customProxy(id string, proxyURL string) map[string]any {
	host, port, _ := net.SplitHostPort(strings.TrimPrefix(proxyURL, "http://"))
	portNumber, _ := strconv.Atoi(port)
	return map[string]any{"id": id, "kind": "custom", "scheme": "http", "host": host, "port": portNumber}
}

func routeTo(ids ...string) map[string]any {
	if ids == nil {
		ids = []string{}
	}
	return map[string]any{"enabled": true, "proxyIds": ids}
}

func decodeProxySettings(t *testing.T, response *httptest.ResponseRecorder) proxySettingsResponse {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var settings appSettingsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	return settings.Proxy
}

func TestUpdateSettingsPersistsProxiesWithoutReturningPasswords(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{HostProxyHost: "host.docker.internal"})
	hostProxy := map[string]any{
		"id": "host", "kind": "host", "scheme": "SOCKS5", "host": "192.0.2.99", "port": 1080,
		"username": "synthetic-user", "password": "synthetic-password",
	}
	response := patchSettingsAsSourceWriter(t, server, proxySettingsBody(t,
		[]map[string]any{hostProxy, customProxy("lan", "http://192.0.2.10:8080")},
		map[string]any{"dlsite": routeTo("lan")},
	))
	if strings.Contains(response.Body.String(), "synthetic-password") {
		t.Fatalf("settings response exposed a proxy password: %s", response.Body.String())
	}
	settings := decodeProxySettings(t, response)
	if settings.HostAddress != "host.docker.internal" {
		t.Fatalf("host address = %q", settings.HostAddress)
	}
	if len(settings.Proxies) != 2 || settings.Proxies[0].Host != "" || settings.Proxies[0].Scheme != "socks5" || !settings.Proxies[0].HasPassword {
		t.Fatalf("proxies = %+v, want a host proxy without an address and with a stored password", settings.Proxies)
	}
	if !settings.Routes.DLsite.Enabled || strings.Join(settings.Routes.DLsite.ProxyIDs, ",") != "lan" {
		t.Fatalf("DLsite route = %+v", settings.Routes.DLsite)
	}

	delete(hostProxy, "password")
	hostProxy["port"] = 1081
	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t,
		[]map[string]any{hostProxy}, map[string]any{"other": routeTo()},
	)))
	stored, err := server.loadProxyConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(stored.Proxies) != 1 || stored.Proxies[0].Password != "synthetic-password" || stored.Proxies[0].Port != 1081 {
		t.Fatalf("stored proxies = %d, port = %d; an omitted password must be kept", len(stored.Proxies), stored.Proxies[0].Port)
	}
	if stored.Routes.DLsite.Enabled || !stored.Routes.Other.Enabled {
		t.Fatalf("stored routes = %+v", stored.Routes)
	}

	hostProxy["password"] = ""
	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t, []map[string]any{hostProxy}, map[string]any{})))
	if stored, _ := server.loadProxyConfig(context.Background()); stored.Proxies[0].Password != "" {
		t.Fatal("an empty password did not clear the stored password")
	}

	for name, body := range map[string]string{
		"scheme":         proxySettingsBody(t, []map[string]any{{"kind": "custom", "scheme": "ftp", "host": "192.0.2.10", "port": 21}}, map[string]any{}),
		"credentials":    proxySettingsBody(t, []map[string]any{{"kind": "custom", "scheme": "http", "host": "synthetic-user:synthetic-password@192.0.2.10", "port": 8080}}, map[string]any{}),
		"route no proxy": proxySettingsBody(t, []map[string]any{}, map[string]any{"remote": routeTo()}),
	} {
		response := patchSettingsAsSourceWriter(t, server, body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want %d", name, response.Code, http.StatusBadRequest)
		}
		if strings.Contains(response.Body.String(), "synthetic-password") {
			t.Fatalf("%s: validation error echoed credentials: %s", name, response.Body.String())
		}
	}
	if stored, _ := server.loadProxyConfig(context.Background()); len(stored.Proxies) != 1 || stored.Proxies[0].Port != 1081 {
		t.Fatal("a rejected update changed the stored proxy configuration")
	}
}

func TestSettingsReturnEmptyProxySelectionsAsArrays(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.getSettings(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var body struct {
		Proxy struct {
			Proxies []json.RawMessage          `json:"proxies"`
			Routes  map[string]json.RawMessage `json:"routes"`
		} `json:"proxy"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Proxy.Proxies == nil {
		t.Fatal("proxies is null for an empty configuration")
	}
	for _, scope := range []string{"dlsite", "remote", "other"} {
		if !strings.Contains(string(body.Proxy.Routes[scope]), `"proxyIds":[]`) {
			t.Fatalf("%s route = %s, want an empty proxyIds array", scope, body.Proxy.Routes[scope])
		}
	}
}

func TestLegacyMetadataProxyBecomesDLsiteRoute(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, '"socks5://192.0.2.10:1080"')`, legacyMetadataProxySetting); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.getSettings(response, request)
	settings := decodeProxySettings(t, response)
	if len(settings.Proxies) != 1 || settings.Proxies[0].Host != "192.0.2.10" || !settings.Routes.DLsite.Enabled {
		t.Fatalf("legacy proxy settings = %+v", settings)
	}

	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t, []map[string]any{}, map[string]any{})))
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key = ?", legacyMetadataProxySetting).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("saving the proxy configuration kept the legacy metadata proxy setting")
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

// closedProxyURL returns the address of a listener that no longer accepts
// connections, so a connection attempt fails immediately.
func closedProxyURL(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	return "http://" + address
}

func TestMetadataClientFollowsProxyRouteChanges(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	var firstTarget, secondTarget atomic.Value
	var firstCount, secondCount atomic.Int32
	first := newConnectRecordingProxy(t, &firstTarget, &firstCount)
	second := newConnectRecordingProxy(t, &secondTarget, &secondCount)
	proxies := []map[string]any{customProxy("first", first.URL), customProxy("second", second.URL)}

	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t, proxies, map[string]any{"dlsite": routeTo("first")})))
	if _, err := server.metadataHTTPClient.Get(server.dlsiteEndpoints.WorkURL("RJ00000001")); err == nil {
		t.Fatal("request through refusing proxy unexpectedly succeeded")
	}
	if firstCount.Load() != 1 || firstTarget.Load() != "www.dlsite.com:443" {
		t.Fatalf("first proxy saw %d CONNECT requests to %v", firstCount.Load(), firstTarget.Load())
	}

	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t, proxies, map[string]any{"dlsite": routeTo("second")})))
	if _, err := server.metadataHTTPClient.Get(server.dlsiteEndpoints.WorkURL("RJ00000001")); err == nil {
		t.Fatal("request through refusing proxy unexpectedly succeeded")
	}
	if firstCount.Load() != 1 || secondCount.Load() != 1 {
		t.Fatalf("route change was not applied: first=%d second=%d", firstCount.Load(), secondCount.Load())
	}
}

func TestMetadataClientFailsOverToNextProxyByPriority(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	var target atomic.Value
	var count atomic.Int32
	reachable := newConnectRecordingProxy(t, &target, &count)
	proxies := []map[string]any{customProxy("down", closedProxyURL(t)), customProxy("up", reachable.URL)}

	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t, proxies, map[string]any{"dlsite": routeTo()})))
	_, _ = server.metadataHTTPClient.Get(server.dlsiteEndpoints.WorkURL("RJ00000001"))
	if count.Load() != 1 || target.Load() != "www.dlsite.com:443" {
		t.Fatalf("second proxy saw %d CONNECT requests to %v after the first was unreachable", count.Load(), target.Load())
	}
}

func TestMetadataClientFailsClosedForUnusableStoredProxy(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, '"ftp://192.0.2.10:21"')`, legacyMetadataProxySetting); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	_, err := server.metadataHTTPClient.Get(server.dlsiteEndpoints.WorkURL("RJ00000001"))
	if !errors.Is(err, errProxyConfigUnavailable) {
		t.Fatalf("request with unusable stored proxy error = %v, want %v", err, errProxyConfigUnavailable)
	}
}

// newForwardRecordingProxy answers plain HTTP proxy requests itself and
// records the requested destination host and proxy credentials.
func newForwardRecordingProxy(t *testing.T, hosts *atomic.Value, authorization *atomic.Value) *httptest.Server {
	t.Helper()
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		hosts.Store(request.URL.Host)
		if authorization != nil {
			authorization.Store(request.Header.Get("Proxy-Authorization"))
		}
		_, _ = io.WriteString(w, "proxied")
	}))
	t.Cleanup(proxy.Close)
	return proxy
}

func TestRemoteSourceRequestsFollowProxyRouteAndSourceOverride(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "direct")
	}))
	defer origin.Close()
	var proxiedHost, authorization atomic.Value
	proxy := newForwardRecordingProxy(t, &proxiedHost, &authorization)

	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (2, 'example_other', 'Example Other', 'kikoeru_compatible', 1)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []int{1, 2} {
		if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (?, ?, ?)`, id, origin.URL, origin.URL); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	get := func(id int64) string {
		t.Helper()
		source, err := server.loadRemoteSourceForUse(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		response, err := server.sourceHTTPClient(source, 5*time.Second).Get(origin.URL + "/api/works")
		if err != nil {
			t.Fatalf("source %d request failed: %v", id, err)
		}
		defer func() { _ = response.Body.Close() }()
		body, _ := io.ReadAll(response.Body)
		return string(body)
	}

	lan := customProxy("lan", proxy.URL)
	lan["username"], lan["password"] = "synthetic-user", "synthetic-password"
	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t,
		[]map[string]any{lan},
		map[string]any{"remote": routeTo(), "sources": map[string]any{"2": map[string]any{"mode": "direct", "proxyIds": []string{}}}},
	)))
	if got := get(1); got != "proxied" || authorization.Load() == "" {
		t.Fatalf("source following the remote route answered %q with proxy authorization %v", got, authorization.Load())
	}
	if got := get(2); got != "direct" {
		t.Fatalf("source with a direct override answered %q", got)
	}

	request := httptest.NewRequest(http.MethodDelete, "/api/file-sources/2", nil)
	request.SetPathValue("id", "2")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.deleteFileSource(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", response.Code, response.Body.String())
	}
	stored, err := server.loadProxyConfig(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := stored.Routes.Sources[2]; ok {
		t.Fatal("deleting a source kept its proxy override for a reused id")
	}
}

func TestAppUpdateCheckFollowsOtherProxyRoute(t *testing.T) {
	var proxiedHost atomic.Value
	proxy := newForwardRecordingProxy(t, &proxiedHost, nil)
	server := NewServer(openMigratedTestDB(t), config.Config{})
	server.appUpdateEndpoints.releasesAPIURL = "http://updates.example.test/releases"
	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t,
		[]map[string]any{customProxy("lan", proxy.URL)}, map[string]any{"other": routeTo()},
	)))
	_, _ = server.fetchAppUpdate(context.Background())
	if proxiedHost.Load() != "updates.example.test" {
		t.Fatalf("update check reached proxy for %v, want the configured release host", proxiedHost.Load())
	}
	if resolved, err := server.resolveProxyRoute(context.Background(), proxyconfig.ScopeDLsite, 0); err != nil || len(resolved.proxies) != 0 {
		t.Fatalf("DLsite route resolved %d proxies, error %v; only the other route was enabled", len(resolved.proxies), err)
	}
}

func TestRemoteSourceFallsBackToDirectOnlyWhenEnabled(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "direct")
	}))
	defer origin.Close()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, origin.URL, origin.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	source, err := server.loadRemoteSourceForUse(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	unreachable := closedProxyURL(t)
	save := func(directFallback bool) {
		t.Helper()
		var body map[string]map[string]any
		if err := json.Unmarshal([]byte(proxySettingsBody(t,
			[]map[string]any{customProxy("down", unreachable)}, map[string]any{"remote": routeTo()},
		)), &body); err != nil {
			t.Fatal(err)
		}
		body["proxy"]["directFallback"] = directFallback
		encoded, _ := json.Marshal(body)
		if settings := decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, string(encoded))); settings.DirectFallback != directFallback {
			t.Fatalf("directFallback = %v, want %v", settings.DirectFallback, directFallback)
		}
	}

	save(false)
	if _, err := server.sourceHTTPClient(source, 5*time.Second).Get(origin.URL + "/api/works"); err == nil {
		t.Fatal("request through an unreachable proxy connected directly without the fallback enabled")
	}

	save(true)
	response, err := server.sourceHTTPClient(source, 5*time.Second).Get(origin.URL + "/api/works")
	if err != nil {
		t.Fatalf("request with direct fallback failed: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if body, _ := io.ReadAll(response.Body); string(body) != "direct" {
		t.Fatalf("fallback response = %q", body)
	}
}
