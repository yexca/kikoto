package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestApplicationSecurityHeadersProtectSPARoutesAndAPIErrors(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<!doctype html><div id=\"root\"></div>"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{StaticDir: root})
	for _, route := range []string{"/", "/about", "/assets/missing.js", "/api/works"} {
		response := httptest.NewRecorder()
		server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("%s missing security headers: %v", route, response.Header())
		}
		if route != "/api/works" && response.Header().Get("Content-Security-Policy") != appContentSecurityPolicy {
			t.Fatalf("%s missing application CSP: %v", route, response.Header())
		}
	}
}
