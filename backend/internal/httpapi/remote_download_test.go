package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/download"
)

func TestRemoteDownloadEnforcesStreamLimitBeforeReplacingTarget(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("12345678"))
	}))
	defer remote.Close()
	directory := t.TempDir()
	target := filepath.Join(directory, "media.bin")
	if err := os.WriteFile(target, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(openMigratedTestDB(t), config.Config{})
	_, err := server.downloadToFile(context.Background(), remote.URL, target, remoteDownloadOptions{MaxBytes: 7})
	if !errors.Is(err, download.ErrLimitExceeded) {
		t.Fatalf("download error = %v, want limit error", err)
	}
	content, readErr := os.ReadFile(target)
	if readErr != nil || string(content) != "old" {
		t.Fatalf("target content = %q, error = %v", content, readErr)
	}
}

func TestRemoteCoverUsesBoundedDownloadWriter(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.FormatInt(download.CoverMaxBytes+1, 10))
		_, _ = w.Write([]byte("x"))
	}))
	defer remote.Close()
	cacheRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{CacheRoot: cacheRoot})
	err := server.downloadRemoteCover(context.Background(), "RJ01234567", remote.URL+"/cover.jpg")
	if !errors.Is(err, download.ErrLimitExceeded) {
		t.Fatalf("cover error = %v, want limit error", err)
	}
	if _, statErr := os.Stat(filepath.Join(cacheRoot, "cover", "RJ01234567.jpg")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("oversized cover was published: %v", statErr)
	}
}
