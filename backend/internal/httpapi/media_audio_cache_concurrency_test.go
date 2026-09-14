package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

// These tests exercise already published cache bytes. Codec validity belongs to
// the real FFmpeg tests; no encoder is needed to verify locking or HTTP ranges.
func cachedAudioConcurrencyFixture(t *testing.T) (*Server, string, string, []byte) {
	t.Helper()
	input := filepath.Join(t.TempDir(), "track.aac")
	if err := os.WriteFile(input, []byte("synthetic source bytes"), 0o600); err != nil {
		t.Fatal(err)
	}
	sourceTime := time.Date(2020, time.January, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(input, sourceTime, sourceTime); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(input)
	if err != nil {
		t.Fatal(err)
	}
	cacheRoot := t.TempDir()
	encoded := bytes.Repeat([]byte("synthetic complete audio bytes "), 8)
	output := writeCacheTestFile(t, cacheRoot, audioTranscodeCachePath(input, info), string(encoded), 2*time.Minute)
	return NewServer(nil, config.Config{CacheRoot: cacheRoot}), input, output, encoded
}

type blockedAudioResponse struct {
	*httptest.ResponseRecorder
	started chan struct{}
	unblock chan struct{}
	once    sync.Once
}

func (response *blockedAudioResponse) Write(data []byte) (int, error) {
	response.once.Do(func() { close(response.started) })
	<-response.unblock
	return response.ResponseRecorder.Write(data)
}

func startBlockedAudioResponse(t *testing.T, server *Server, input string) (*blockedAudioResponse, func(), <-chan struct{}) {
	t.Helper()
	response := &blockedAudioResponse{
		ResponseRecorder: httptest.NewRecorder(),
		started:          make(chan struct{}),
		unblock:          make(chan struct{}),
	}
	done := make(chan struct{})
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(response.unblock) }) }
	t.Cleanup(func() {
		release()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("active audio response did not stop after releasing its writer")
		}
	})
	go func() {
		defer close(done)
		request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&forceDirect=1", nil)
		server.serveAutomaticLocalPlayback(response, request, mediaStreamTarget{Kind: "audio"}, input)
	}()
	select {
	case <-response.started:
	case <-done:
		t.Fatalf("cached audio response ended without writing: %d", response.Code)
	case <-time.After(3 * time.Second):
		t.Fatal("cached audio response did not begin writing")
	}
	return response, release, done
}

func TestCompatibleAudioRangeDoesNotWaitForAnotherDownload(t *testing.T) {
	server, input, _, encoded := cachedAudioConcurrencyFixture(t)
	_, _, _ = startBlockedAudioResponse(t, server, input)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&forceDirect=1", nil).WithContext(ctx)
	request.Header.Set("Range", "bytes=100-149")
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, mediaStreamTarget{Kind: "audio"}, input)
	if response.Code != http.StatusPartialContent || !bytes.Equal(response.Body.Bytes(), encoded[100:150]) {
		t.Fatalf("range blocked by another download: %d / %q", response.Code, response.Body.String())
	}
}

func TestCompatibleAudioLRUTouchPreservesConditionalRange(t *testing.T) {
	server, input, output, encoded := cachedAudioConcurrencyFixture(t)
	head := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(head, httptest.NewRequest(http.MethodHead, "/api/media/1/stream?profile=audio&forceDirect=1", nil), mediaStreamTarget{Kind: "audio"}, input)
	modified := head.Header().Get("Last-Modified")
	if head.Code != http.StatusOK || modified == "" {
		t.Fatalf("cached audio HEAD has no validator: %d / %#v", head.Code, head.Header())
	}
	old := time.Now().Add(-10 * time.Minute)
	if err := os.Chtimes(output, old, old); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&forceDirect=1", nil)
	request.Header.Set("Range", "bytes=100-149")
	request.Header.Set("If-Range", modified)
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, mediaStreamTarget{Kind: "audio"}, input)
	if response.Code != http.StatusPartialContent || !bytes.Equal(response.Body.Bytes(), encoded[100:150]) {
		t.Fatalf("LRU touch invalidated unchanged audio range: %d / %q", response.Code, response.Body.String())
	}
	if response.Header().Get("Last-Modified") != modified || response.Header().Get("Etag") != head.Header().Get("Etag") {
		t.Fatalf("unchanged audio validators changed: HEAD %#v / range %#v", head.Header(), response.Header())
	}
	info, err := os.Stat(output)
	if err != nil || !info.ModTime().After(old) {
		t.Fatalf("conditional range did not update LRU recency: %v", err)
	}
}

func TestTranscodeCacheEvictionDoesNotInterruptOpenAudio(t *testing.T) {
	for _, mode := range []string{"clear", "quota"} {
		t.Run(mode, func(t *testing.T) {
			server, input, output, encoded := cachedAudioConcurrencyFixture(t)
			active, release, activeDone := startBlockedAudioResponse(t, server, input)
			request := httptest.NewRequest(http.MethodDelete, "/api/cache/transcodes", nil)
			request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"downloads:manage"}}))
			response := httptest.NewRecorder()
			var evictionErr error
			evictionDone := make(chan struct{})
			go func() {
				defer close(evictionDone)
				if mode == "clear" {
					server.clearTranscodeCache(response, request)
					return
				}
				_, evictionErr = server.enforceTranscodeCacheLimit(request.Context(), server.transcodeCacheLimitBytes(request.Context()))
			}()
			select {
			case <-evictionDone:
			case <-time.After(time.Second):
				release()
				select {
				case <-evictionDone:
				case <-time.After(3 * time.Second):
					t.Fatal("cache eviction did not stop after releasing active playback")
				}
				t.Fatal("cache eviction waited for an active audio download")
			}
			if evictionErr != nil || response.Code != http.StatusOK {
				t.Fatalf("eviction while audio is open = %v / %d / %s", evictionErr, response.Code, response.Body.String())
			}
			if _, err := os.Stat(output); !os.IsNotExist(err) {
				t.Fatalf("evicted audio cache still exists or stat failed: %v", err)
			}
			release()
			select {
			case <-activeDone:
			case <-time.After(3 * time.Second):
				t.Fatal("open audio did not finish after cache eviction")
			}
			if active.Code != http.StatusOK || !bytes.Equal(active.Body.Bytes(), encoded) {
				t.Fatalf("cache eviction interrupted open audio: %d / %q", active.Code, active.Body.String())
			}
		})
	}
}
