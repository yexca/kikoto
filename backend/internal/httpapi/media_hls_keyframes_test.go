package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func (fixture *videoRemuxTestServer) source(t *testing.T, location int64) hlsPlaybackSource {
	t.Helper()
	source, err := fixture.server.loadHLSPlaybackSource(context.Background(), location)
	if err != nil {
		t.Fatal(err)
	}
	return source
}

func (fixture *videoRemuxTestServer) storedIndexPath(source hlsPlaybackSource) string {
	return filepath.Join(fixture.cacheRoot, filepath.FromSlash(videoKeyframeIndexRelativePath(source)))
}

// restartedServer serves the fixture's library and cache from a new process.
func (fixture *videoRemuxTestServer) restartedServer(t *testing.T) *Server {
	t.Helper()
	server := NewServer(fixture.db, config.Config{DataRoot: fixture.dataRoot, CacheRoot: fixture.cacheRoot})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	return server
}

func TestVideoKeyframeIndexOutlivesTheServer(t *testing.T) {
	fixture := newVideoRemuxTestServer(t)
	source := fixture.source(t, 841)
	built := fixture.server.mustVideoKeyframeIndex(t, source)
	storedPath := fixture.storedIndexPath(source)
	if _, err := os.Stat(storedPath); err != nil {
		t.Fatalf("the index was not stored: %v", err)
	}

	// A stored index that does not describe a usable index is scanned again.
	if err := os.WriteFile(storedPath, []byte(`{"format":"`+videoKeyframeIndexFormat+`","cuts":[0,5],"packets":[0],"end":9,"bytesPerSecond":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if rebuilt := fixture.restartedServer(t).mustVideoKeyframeIndex(t, source); !slices.Equal(rebuilt.cuts, built.cuts) {
		t.Fatalf("rebuilt cuts = %v, want %v", rebuilt.cuts, built.cuts)
	}
	var stored storedVideoKeyframeIndex
	if content, err := os.ReadFile(storedPath); err != nil || json.Unmarshal(content, &stored) != nil || stored.index() == nil {
		t.Fatalf("the rescan did not replace the malformed index: %v", err)
	}

	// Without FFprobe, a restarted server can only read the stored index.
	t.Setenv("PATH", t.TempDir())
	loaded := fixture.restartedServer(t).mustVideoKeyframeIndex(t, source)
	if !slices.Equal(loaded.cuts, built.cuts) || !slices.Equal(loaded.packets, built.packets) ||
		loaded.end != built.end || loaded.bytesPerSecond != built.bytesPerSecond {
		t.Fatalf("loaded index = %+v, want %+v", loaded, built)
	}
}

func TestOpeningAWorkPrefetchesTheKeyframesOfItsVideos(t *testing.T) {
	fixture := newVideoRemuxTestServer(t)
	request := httptest.NewRequest(http.MethodGet, "/api/works/840/media", nil)
	request.SetPathValue("id", "840")
	response := httptest.NewRecorder()
	fixture.server.getWorkMedia(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("work media = %d: %s", response.Code, response.Body.String())
	}

	prefetch := &fixture.server.videoKeyframePrefetch
	deadline := time.Now().Add(2 * time.Minute)
	for {
		prefetch.mu.Lock()
		running := prefetch.running
		prefetch.mu.Unlock()
		if !running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the prefetch did not finish")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, test := range []struct {
		location int64
		stored   bool
	}{
		{841, true},  // H.264 in Matroska
		{842, false}, // keyframes too far apart for a remux
		{843, false}, // H.264 High with AAC in MP4 plays directly in every current browser
		{844, false}, // MPEG-4 Part 2 is never copied, so it is not scanned
	} {
		_, err := os.Stat(fixture.storedIndexPath(fixture.source(t, test.location)))
		if stored := err == nil; stored != test.stored {
			t.Errorf("location %d stored = %v, want %v", test.location, stored, test.stored)
		}
	}
}

func TestDemoReadsKeyframesOnlyForAPlayback(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{Mode: config.ModeDemo, DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	server.prefetchWorkVideoKeyframes([]mediaItemDetail{{
		Kind:      "video",
		Locations: []fileLocationDetail{{ID: 1, Path: "RJ00000000/clip.mkv", Availability: "available", LocationType: "local"}},
	}})
	prefetch := &server.videoKeyframePrefetch
	prefetch.mu.Lock()
	defer prefetch.mu.Unlock()
	if prefetch.running || len(prefetch.queue) > 0 {
		t.Fatalf("opening a work in Demo queued %v", prefetch.queue)
	}
}

func TestPlaybackKeyframeScanTakesTheSlotFromAPrefetch(t *testing.T) {
	fixture := newVideoRemuxTestServer(t)
	server := fixture.server
	prefetched, played := fixture.source(t, 841), fixture.source(t, 843)
	indexes := &server.videoKeyframeIndexes

	// Another scan holds the slot, so the prefetch waits for it.
	indexes.mu.Lock()
	indexes.builds = map[string]*videoKeyframeIndexBuild{}
	indexes.slot = make(chan struct{}, 1)
	indexes.mu.Unlock()
	indexes.slot <- struct{}{}
	prefetchResult := make(chan error, 1)
	go func() {
		_, err := server.prefetchVideoKeyframeIndex(context.Background(), prefetched)
		prefetchResult <- err
	}()
	for {
		indexes.mu.Lock()
		build := indexes.builds[videoKeyframeIndexKey(prefetched)]
		started := build != nil && build.cancel != nil
		indexes.mu.Unlock()
		if started {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	playbackResult := make(chan error, 1)
	go func() {
		_, err := server.videoKeyframeIndex(context.Background(), played, time.Minute)
		playbackResult <- err
	}()
	select {
	case err := <-prefetchResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("prefetch = %v, want it cancelled", err)
		}
	case <-time.After(time.Minute):
		t.Fatal("the playback scan did not cancel the prefetch")
	}
	indexes.mu.Lock()
	_, kept := indexes.builds[videoKeyframeIndexKey(prefetched)]
	indexes.mu.Unlock()
	if kept {
		t.Fatal("a cancelled prefetch was remembered as a scan result")
	}

	<-indexes.slot
	if err := <-playbackResult; err != nil {
		t.Fatalf("playback scan: %v", err)
	}
	// The cancelled index is scanned again by the next request for it.
	if _, err := server.prefetchVideoKeyframeIndex(context.Background(), prefetched); err != nil {
		t.Fatalf("prefetch after the playback: %v", err)
	}
}
