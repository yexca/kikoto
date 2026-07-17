package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestServeRevalidatedFileUsesIdentityETag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cover.png")
	if err := os.WriteFile(path, []byte("current image"), 0o600); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/media/43/asset?v=current", nil)
	response := httptest.NewRecorder()
	serveRevalidatedFile(response, request, path, "RJ09999998/image/cover_4x3.png")

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}
	if got := response.Header().Get("Cache-Control"); got != "private, no-cache" {
		t.Fatalf("Cache-Control = %q", got)
	}
	etag := response.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag is empty")
	}

	revalidatedRequest := httptest.NewRequest(http.MethodGet, "/api/media/43/asset?v=current", nil)
	revalidatedRequest.Header.Set("If-None-Match", etag)
	revalidatedResponse := httptest.NewRecorder()
	serveRevalidatedFile(revalidatedResponse, revalidatedRequest, path, "RJ09999998/image/cover_4x3.png")
	if revalidatedResponse.Code != http.StatusNotModified {
		t.Fatalf("revalidated status = %d, want %d", revalidatedResponse.Code, http.StatusNotModified)
	}

	reboundRequest := httptest.NewRequest(http.MethodGet, "/api/media/43/asset?v=other", nil)
	reboundRequest.Header.Set("If-None-Match", etag)
	reboundResponse := httptest.NewRecorder()
	serveRevalidatedFile(reboundResponse, reboundRequest, path, "RJ09999997/package.jpg")
	if reboundResponse.Code != http.StatusOK {
		t.Fatalf("rebound status = %d, want %d", reboundResponse.Code, http.StatusOK)
	}
	if reboundResponse.Header().Get("ETag") == etag {
		t.Fatal("ETag did not change when the resource identity changed")
	}
}
