package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

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
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	_, err := server.downloadToFile(context.Background(), source, remote.URL, target, remoteDownloadOptions{MaxBytes: 7})
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
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	err := server.downloadRemoteCover(context.Background(), source, "RJ00000000", remote.URL+"/cover.jpg")
	if !errors.Is(err, download.ErrLimitExceeded) {
		t.Fatalf("cover error = %v, want limit error", err)
	}
	if _, statErr := os.Stat(filepath.Join(cacheRoot, "cover", "RJ00000000.jpg")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("oversized cover was published: %v", statErr)
	}
}

func TestRemoteDownloadRejectsUnconfiguredOriginWithoutRetrying(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{
		APIURL:                "https://source.example.invalid/api",
		RestrictOutboundHosts: true,
	}}
	target := filepath.Join(t.TempDir(), "media.bin")
	_, err := server.downloadToFile(
		context.Background(),
		source,
		"https://other.example.invalid/media.bin",
		target,
		remoteDownloadOptions{MaxBytes: 1024},
	)
	var downloadErr remoteDownloadError
	if !errors.As(err, &downloadErr) {
		t.Fatalf("download error = %v, want remoteDownloadError", err)
	}
	if downloadErr.Retryable {
		t.Fatal("outbound policy violation was marked retryable")
	}
	if _, statErr := os.Stat(target); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("rejected origin created a target: %v", statErr)
	}
}

func TestRemoteDownloadHandsLongRateLimitToScheduler(t *testing.T) {
	var requests atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.Header().Set("Retry-After", "86400")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0'), ('remote_max_backoff_seconds', '60')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	target := filepath.Join(t.TempDir(), "media.bin")
	options := remoteDownloadOptions{MaxBytes: 1024}

	started := time.Now()
	_, err := server.downloadToFile(context.Background(), source, remote.URL, target, options)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("download slept %v inside the worker", elapsed)
	}
	var downloadErr remoteDownloadError
	if !errors.As(err, &downloadErr) || downloadErr.StatusCode != http.StatusTooManyRequests || !downloadErr.Retryable {
		t.Fatalf("download error = %v, want the counted rate-limit response", err)
	}
	if remaining := time.Until(downloadErr.RetryAt); remaining <= 50*time.Second || remaining > 60*time.Second {
		t.Fatalf("retry at %v from now, want the bounded origin backoff", remaining)
	}
	var backoffErr sourceBackoffError
	if errors.As(err, &backoffErr) {
		t.Fatal("a download that reached the source was reported as a pure deferral")
	}

	_, err = server.downloadToFile(context.Background(), source, remote.URL, target, options)
	if !errors.As(err, &backoffErr) || !backoffErr.Until.Equal(downloadErr.RetryAt) {
		t.Fatalf("blocked download error = %v, want sourceBackoffError", err)
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("remote requests = %d, want the blocked download not to reach the source", got)
	}
}
