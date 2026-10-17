package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/proxyconfig"
)

func proxyPatch(t *testing.T, proxy map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"proxy": proxy})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// A remote source on this machine or the LAN is reached directly under the
// default bypass list even while the remote-source route uses a proxy, and
// the list is edited, kept, and validated through the settings API.
func TestProxyBypassDefaultsAndSettings(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "direct")
	}))
	defer origin.Close()
	var proxied atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Add(1)
		http.Error(w, "refused", http.StatusForbidden)
	}))
	defer proxy.Close()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, origin.URL, origin.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	routes := map[string]any{
		"dlsite": map[string]any{"enabled": false, "proxyIds": []string{}},
		"remote": routeTo(),
		"ai":     map[string]any{"enabled": false, "proxyIds": []string{}},
		"other":  map[string]any{"enabled": false, "proxyIds": []string{}},
	}
	proxies := []map[string]any{customProxy("lan", proxy.URL)}

	// A client that omits the list keeps the stored one, which starts as the
	// default list.
	settings := decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxyPatch(t, map[string]any{"proxies": proxies, "routes": routes})))
	if !reflect.DeepEqual(settings.Bypass, proxyconfig.DefaultBypass) || !reflect.DeepEqual(settings.DefaultBypass, proxyconfig.DefaultBypass) {
		t.Fatalf("bypass = %v, default = %v; want the default list", settings.Bypass, settings.DefaultBypass)
	}
	source, err := server.loadRemoteSourceForUse(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	response, err := server.sourceHTTPClient(source, 5*time.Second).Get(origin.URL + "/api/works")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if string(body) != "direct" || proxied.Load() != 0 {
		t.Fatalf("loopback source answered %q after %d proxy requests; want a direct request", body, proxied.Load())
	}

	settings = decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxyPatch(t, map[string]any{
		"proxies": proxies, "routes": routes, "bypass": []string{" .LAN", "127.1.2.3/8", "*.lan"},
	})))
	if want := []string{"*.lan", "127.0.0.0/8"}; !reflect.DeepEqual(settings.Bypass, want) {
		t.Fatalf("bypass = %v, want %v", settings.Bypass, want)
	}
	settings = decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxyPatch(t, map[string]any{"proxies": proxies, "routes": routes})))
	if want := []string{"*.lan", "127.0.0.0/8"}; !reflect.DeepEqual(settings.Bypass, want) {
		t.Fatalf("bypass after a save without it = %v, want %v", settings.Bypass, want)
	}
	if got := patchSettingsAsSourceWriter(t, server, proxyPatch(t, map[string]any{
		"proxies": proxies, "routes": routes, "bypass": []string{"nas.lan:8080"},
	})); got.Code != http.StatusBadRequest {
		t.Fatalf("an entry with a port: status %d, body %s", got.Code, got.Body.String())
	}
}
