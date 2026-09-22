package httpapi

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/download"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRemoteCoverAcceptsRasterContentAndRejectsActiveDocuments(t *testing.T) {
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/image.html" {
			w.Header().Set("Content-Type", "text/html")
			_, _ = w.Write(picture.Bytes())
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("<!doctype html><script>document.title='synthetic-marker'</script>"))
	}))
	defer remote.Close()
	s := NewServer(nil, config.Config{CacheRoot: t.TempDir()})
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	if err := s.downloadRemoteCover(context.Background(), source, code, remote.URL+"/image.html"); err != nil {
		t.Fatal(err)
	}
	if err := s.downloadRemoteCover(context.Background(), source, code, remote.URL+"/image.jpg"); !errors.Is(err, download.ErrImageType) {
		t.Fatalf("active document error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/assets/covers/"+code+".png", nil)
	response := httptest.NewRecorder()
	s.getCoverAsset(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/png" || !bytes.Equal(response.Body.Bytes(), picture.Bytes()) {
		t.Fatalf("valid cover was not preserved: status=%d headers=%v", response.Code, response.Header())
	}
	if response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("cover response lacks content restrictions")
	}
	request.Header.Set("If-None-Match", response.Header().Get("ETag"))
	revalidated := httptest.NewRecorder()
	s.getCoverAsset(revalidated, request)
	if revalidated.Code != http.StatusNotModified {
		t.Fatalf("revalidation status=%d", revalidated.Code)
	}

	for _, extension := range []string{".jpg", ".html", ".svg"} {
		if err := os.WriteFile(filepath.Join(s.cfg.CacheRoot, "cover", code+extension), []byte("<html>legacy active document</html>"), 0o600); err != nil {
			t.Fatal(err)
		}
		response := httptest.NewRecorder()
		s.getCoverAsset(response, httptest.NewRequest(http.MethodGet, "/api/assets/covers/"+code+extension, nil))
		if response.Code != http.StatusNotFound {
			t.Fatalf("legacy %s response status=%d", extension, response.Code)
		}
	}
}

func TestVersionedCoverURLIsImmutableUntilTheCoverChanges(t *testing.T) {
	var picture bytes.Buffer
	if err := png.Encode(&picture, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	s := NewServer(openMigratedTestDB(t), config.Config{CacheRoot: t.TempDir()})
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	coverPath := filepath.Join(s.cfg.CacheRoot, "cover", filepath.FromSlash(coverAssetRelativePath(code, ".png")))
	if err := os.MkdirAll(filepath.Dir(coverPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(coverPath, picture.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	cacheControl := func(url string) string {
		response := httptest.NewRecorder()
		s.getCoverAsset(response, httptest.NewRequest(http.MethodGet, url, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d", url, response.Code)
		}
		return response.Header().Get("Cache-Control")
	}

	versioned := s.coverURL(code)
	if got := cacheControl(versioned); got != "private, max-age=31536000, immutable" {
		t.Fatalf("versioned Cache-Control = %q", got)
	}
	unversioned, _, _ := strings.Cut(versioned, "?")
	if got := cacheControl(unversioned); got != "private, no-cache" {
		t.Fatalf("unversioned Cache-Control = %q", got)
	}

	if err := os.WriteFile(coverPath, append(picture.Bytes(), 0), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := cacheControl(versioned); got != "private, no-cache" {
		t.Fatalf("stale version Cache-Control = %q", got)
	}
	if replaced := s.coverURL(code); replaced == versioned {
		t.Fatalf("cover URL %q did not change after the cover was replaced", replaced)
	}
}
