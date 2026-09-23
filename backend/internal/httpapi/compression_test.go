package httpapi

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

var largeCompressibleBody = `{"items":"` + strings.Repeat("kikoto ", 400) + `"}`

func serveWithGzip(t *testing.T, handler http.HandlerFunc, request *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	withGzip(handler).ServeHTTP(response, request)
	return response
}

func gzipTestRequest(target string, acceptGzip bool) *http.Request {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	if acceptGzip {
		request.Header.Set("Accept-Encoding", "br, gzip;q=0.8")
	}
	return request
}

func writeTestBody(contentType string, body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = io.WriteString(w, body)
	}
}

func decodeGzipBody(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	return string(decoded)
}

func TestGzipCompressesLargeJSONForAcceptingClients(t *testing.T) {
	handler := func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"items": strings.Repeat("kikoto ", 400)})
	}
	response := serveWithGzip(t, handler, gzipTestRequest("/api/works", true))
	if response.Header().Get("Content-Encoding") != "gzip" || response.Header().Get("Content-Length") != "" {
		t.Fatalf("headers = %v", response.Header())
	}
	if response.Header().Get("Vary") != "Accept-Encoding" {
		t.Fatalf("Vary = %q", response.Header().Get("Vary"))
	}
	if body := decodeGzipBody(t, response); !strings.Contains(body, "kikoto kikoto") {
		t.Fatalf("decoded body = %.40q", body)
	}
}

func TestGzipLeavesIneligibleResponsesUnchanged(t *testing.T) {
	sse := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		_, _ = io.WriteString(w, "data: "+largeCompressibleBody+"\n\n")
		w.(http.Flusher).Flush()
	}
	refusedRequest := gzipTestRequest("/api/works", false)
	refusedRequest.Header.Set("Accept-Encoding", "gzip;q=0, identity")
	rangeRequest := gzipTestRequest("/index.html", true)
	rangeRequest.Header.Set("Range", "bytes=0-99")
	for name, test := range map[string]struct {
		handler http.HandlerFunc
		request *http.Request
		vary    bool
	}{
		"no Accept-Encoding": {writeTestBody("application/json", largeCompressibleBody), gzipTestRequest("/api/works", false), true},
		"gzip refused":       {writeTestBody("application/json", largeCompressibleBody), refusedRequest, true},
		"range request":      {writeTestBody("text/html", largeCompressibleBody), rangeRequest, false},
		"event stream":       {sse, gzipTestRequest("/api/workflow-runs/1/events/stream", true), false},
		"event stream type":  {sse, gzipTestRequest("/api/other-stream", true), false},
		"image":              {writeTestBody("image/png", largeCompressibleBody), gzipTestRequest("/kikoto-icon-192.png", true), false},
		"media route":        {writeTestBody("image/svg+xml", largeCompressibleBody), gzipTestRequest("/api/media/7/asset", true), false},
		"small body":         {writeTestBody("application/json", `{"ok":true}`), gzipTestRequest("/api/health", true), true},
		"auth response":      {writeTestBody("application/json", largeCompressibleBody), gzipTestRequest("/api/auth/login", true), false},
		"already encoded": {func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Encoding", "br")
			writeTestBody("application/json", largeCompressibleBody)(w, r)
		}, gzipTestRequest("/api/works", true), false},
	} {
		t.Run(name, func(t *testing.T) {
			response := serveWithGzip(t, test.handler, test.request)
			if response.Header().Get("Content-Encoding") == "gzip" {
				t.Fatal("response was gzip-encoded")
			}
			if got := response.Header().Get("Vary") == "Accept-Encoding"; got != test.vary {
				t.Fatalf("Vary set = %v, want %v", got, test.vary)
			}
			if !strings.Contains(response.Body.String(), "kikoto") && !strings.Contains(response.Body.String(), "ok") {
				t.Fatalf("body = %.40q", response.Body.String())
			}
		})
	}
}

func TestGzipFlushCommitsBufferedResponse(t *testing.T) {
	handler := func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"partial":`)
		w.(http.Flusher).Flush()
		_, _ = io.WriteString(w, `true}`)
	}
	response := serveWithGzip(t, handler, gzipTestRequest("/api/works", true))
	if !response.Flushed || response.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("flushed = %v, headers = %v", response.Flushed, response.Header())
	}
	if body := decodeGzipBody(t, response); body != `{"partial":true}` {
		t.Fatalf("decoded body = %q", body)
	}
}

func newStaticTestServer(t *testing.T) http.Handler {
	t.Helper()
	root := t.TempDir()
	for name, content := range map[string]string{
		"index.html":           "<!doctype html><title>Kikoto</title>",
		"sw.js":                "self.addEventListener('fetch', () => {});",
		"manifest.webmanifest": `{"name":"Kikoto"}`,
		"kikoto-icon-192.png":  "\x89PNG\r\n\x1a\n",
		"assets/index-abc123.js": "console.log(" +
			strings.Repeat("'kikoto',", 300) + ");",
	} {
		target := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return NewServer(openMigratedTestDB(t), config.Config{StaticDir: root}).Routes()
}

func TestStaticAppCacheControlByPathClass(t *testing.T) {
	handler := newStaticTestServer(t)
	for target, want := range map[string]struct {
		status       int
		cacheControl string
	}{
		"/assets/index-abc123.js": {http.StatusOK, staticImmutableCacheControl},
		"/":                       {http.StatusOK, staticRevalidateCacheControl},
		"/library/works/7":        {http.StatusOK, staticRevalidateCacheControl},
		"/sw.js":                  {http.StatusOK, staticRevalidateCacheControl},
		"/manifest.webmanifest":   {http.StatusOK, staticRevalidateCacheControl},
		"/kikoto-icon-192.png":    {http.StatusOK, staticDefaultCacheControl},
		"/assets/index-stale.js":  {http.StatusNotFound, ""},
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
		if response.Code != want.status {
			t.Fatalf("%s status = %d, want %d", target, response.Code, want.status)
		}
		if want.cacheControl != "" && response.Header().Get("Cache-Control") != want.cacheControl {
			t.Fatalf("%s Cache-Control = %q, want %q", target, response.Header().Get("Cache-Control"), want.cacheControl)
		}
		if response.Code == http.StatusNotFound && strings.Contains(response.Body.String(), "<title>") {
			t.Fatalf("%s returned the app shell", target)
		}
	}

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil))
	if contentType := response.Header().Get("Content-Type"); contentType != "application/manifest+json" {
		t.Fatalf("manifest Content-Type = %q", contentType)
	}
}

func TestStaticAppCompressesHashedAssetsButNotRanges(t *testing.T) {
	handler := newStaticTestServer(t)
	request := gzipTestRequest("/assets/index-abc123.js", true)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("status = %d, headers = %v", response.Code, response.Header())
	}
	if body := decodeGzipBody(t, response); !strings.HasPrefix(body, "console.log('kikoto'") {
		t.Fatalf("decoded body = %.40q", body)
	}

	request = gzipTestRequest("/assets/index-abc123.js", true)
	request.Header.Set("Range", "bytes=0-10")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusPartialContent || response.Header().Get("Content-Encoding") != "" || response.Body.String() != "console.log" {
		t.Fatalf("range status = %d, encoding = %q, body = %q", response.Code, response.Header().Get("Content-Encoding"), response.Body.String())
	}
}
