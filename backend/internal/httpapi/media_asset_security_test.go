package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMediaAssetsDownloadActiveContentRegardlessOfExtension(t *testing.T) {
	for name, content := range map[string]string{
		"notes.html": "<!doctype html><script>fetch('/api/auth/me')</script>",
		"cover.svg":  `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('/api/auth/me')"/>`,
		"cover.png":  "<!doctype html><script>fetch('/api/auth/me')</script>",
		"notes.txt":  "plain text",
	} {
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), name)
			if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			serveRevalidatedFile(response, httptest.NewRequest(http.MethodGet, "/api/media/1/asset", nil), file, name)
			if response.Code != http.StatusOK || response.Body.String() != content {
				t.Fatalf("response = %d/%q", response.Code, response.Body.String())
			}
			if response.Header().Get("Content-Type") != "application/octet-stream" || !strings.HasPrefix(response.Header().Get("Content-Disposition"), "attachment;") {
				t.Fatalf("active file served inline: %v", response.Header())
			}
			if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" {
				t.Fatalf("missing browser isolation: %v", response.Header())
			}
		})
	}
}

func TestMediaAssetsKeepRasterPreviewAndRangeRequests(t *testing.T) {
	// Synthetic PNG signature; content recognition is independent of filename.
	content := []byte("\x89PNG\r\n\x1a\nsynthetic-image")
	file := filepath.Join(t.TempDir(), "cover.bin")
	if err := os.WriteFile(file, content, 0o600); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/asset", nil)
	request.Header.Set("Range", "bytes=0-7")
	response := httptest.NewRecorder()
	serveRevalidatedFile(response, request, file, "cover.bin")
	if response.Code != http.StatusPartialContent || response.Header().Get("Content-Type") != "image/png" || response.Header().Get("Content-Disposition") != "" || response.Body.String() != string(content[:8]) {
		t.Fatalf("raster range response = %d/%v/%q", response.Code, response.Header(), response.Body.String())
	}
}
