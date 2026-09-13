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
