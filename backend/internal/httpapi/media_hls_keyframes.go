package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

const (
	// videoKeyframeIndexCacheDir holds stored keyframe indexes under the
	// transcode cache root, one file per location and source revision.
	videoKeyframeIndexCacheDir = "hls-keyframes"
	// videoKeyframeIndexFormat names the segment rules a stored index was cut
	// with; a stored index of another format is scanned again.
	videoKeyframeIndexFormat          = "keyframes-v1"
	videoKeyframeIndexFileMaximumSize = 8 << 20
	videoKeyframeIndexPartialPrefix   = ".keyframes-"
	// Opening a work queues its videos for a keyframe scan, at most this many
	// at a time across the server.
	videoKeyframePrefetchQueueSize = 32
)

type storedVideoKeyframeIndex struct {
	Format         string    `json:"format"`
	Cuts           []float64 `json:"cuts"`
	Packets        []int     `json:"packets"`
	End            float64   `json:"end"`
	BytesPerSecond float64   `json:"bytesPerSecond"`
}

func videoKeyframeIndexRelativePath(source hlsPlaybackSource) string {
	return path.Join(transcodeCacheRootRelative, videoKeyframeIndexCacheDir,
		strconv.FormatInt(source.LocationID, 10), videoKeyframeIndexKey(source)+".json")
}

// loadStoredVideoKeyframeIndex returns the stored index of a source revision,
// or nil when none is stored or it does not describe a usable index. A loaded
// index counts as recently used for the cache limit.
func (s *Server) loadStoredVideoKeyframeIndex(ctx context.Context, source hlsPlaybackSource) *videoKeyframeIndex {
	relPath := videoKeyframeIndexRelativePath(source)
	absolutePath, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return nil
	}
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	release, err := s.acquireCachePathLock(ctx, relPath)
	if err != nil {
		return nil
	}
	defer release()
	file, err := os.Open(absolutePath)
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	if info, err := file.Stat(); err != nil || !info.Mode().IsRegular() || info.Size() > videoKeyframeIndexFileMaximumSize {
		return nil
	}
	var stored storedVideoKeyframeIndex
	if err := json.NewDecoder(io.LimitReader(file, videoKeyframeIndexFileMaximumSize)).Decode(&stored); err != nil {
		return nil
	}
	index := stored.index()
	if index == nil {
		return nil
	}
	now := time.Now()
	_ = os.Chtimes(absolutePath, now, now)
	return index
}

// index returns the stored index when it is one the cutter could have built.
func (stored storedVideoKeyframeIndex) index() *videoKeyframeIndex {
	if stored.Format != videoKeyframeIndexFormat || len(stored.Cuts) == 0 || len(stored.Packets) != len(stored.Cuts) {
		return nil
	}
	finite := func(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
	for position, cut := range stored.Cuts {
		if !finite(cut) || stored.Packets[position] < 0 {
			return nil
		}
		if position > 0 && (cut <= stored.Cuts[position-1] || stored.Packets[position] <= stored.Packets[position-1]) {
			return nil
		}
	}
	if !finite(stored.End) || stored.End <= stored.Cuts[len(stored.Cuts)-1] ||
		!finite(stored.BytesPerSecond) || stored.BytesPerSecond <= 0 {
		return nil
	}
	return &videoKeyframeIndex{cuts: stored.Cuts, packets: stored.Packets, end: stored.End, bytesPerSecond: stored.BytesPerSecond}
}

// storeVideoKeyframeIndex writes the index of a source revision beside its
// final name and renames it into place.
func (s *Server) storeVideoKeyframeIndex(ctx context.Context, source hlsPlaybackSource, index *videoKeyframeIndex) error {
	content, err := json.Marshal(storedVideoKeyframeIndex{
		Format: videoKeyframeIndexFormat, Cuts: index.cuts, Packets: index.packets,
		End: index.end, BytesPerSecond: index.bytesPerSecond,
	})
	if err != nil {
		return err
	}
	relPath := videoKeyframeIndexRelativePath(source)
	absolutePath, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return err
	}
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	release, err := s.acquireCachePathLock(ctx, relPath)
	if err != nil {
		return err
	}
	defer release()
	dir := filepath.Dir(absolutePath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, videoKeyframeIndexPartialPrefix+"*.part")
	if err != nil {
		return err
	}
	_, writeErr := temporary.Write(content)
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = os.Remove(temporary.Name())
		return err
	}
	if err := os.Rename(temporary.Name(), absolutePath); err != nil {
		_ = os.Remove(temporary.Name())
		return err
	}
	return nil
}

// videoRemuxCandidate reports whether some client could get a remux of the
// source: its average bitrate is within the remux limit and its video stream
// is one a remux copies. Whether this client decodes it is decided at playback.
func videoRemuxCandidate(source hlsPlaybackSource) bool {
	info, err := os.Stat(source.Path)
	if err != nil || source.Duration <= 0 || float64(info.Size())*8/source.Duration > videoRemuxMaximumBitsPerSecond {
		return false
	}
	video := firstPlaybackStream(source.Probe, "video")
	for _, remux := range videoRemuxes {
		if remux.copyable(video) {
			return true
		}
	}
	return false
}

// videoKeyframePrefetch queues the videos of opened works for a keyframe scan
// that runs one at a time behind the response.
type videoKeyframePrefetch struct {
	mu      sync.Mutex
	queue   []int64
	queued  map[int64]bool
	running bool
}

// prefetchWorkVideoKeyframes queues the local and cached videos of a work the
// viewer opened, so a later playback of one finds its keyframe index ready.
func (s *Server) prefetchWorkVideoKeyframes(items []mediaItemDetail) {
	var locations []int64
	for _, item := range items {
		for _, location := range item.Locations {
			if effectiveMediaKind(item.Kind, location.Path) != "video" || location.Availability != "available" ||
				(location.LocationType != "local" && location.LocationType != "cache") {
				continue
			}
			locations = append(locations, location.ID)
		}
	}
	if len(locations) == 0 {
		return
	}
	prefetch := &s.videoKeyframePrefetch
	prefetch.mu.Lock()
	defer prefetch.mu.Unlock()
	if prefetch.queued == nil {
		prefetch.queued = map[int64]bool{}
	}
	for _, location := range locations {
		if len(prefetch.queue) >= videoKeyframePrefetchQueueSize {
			break
		}
		if !prefetch.queued[location] {
			prefetch.queued[location] = true
			prefetch.queue = append(prefetch.queue, location)
		}
	}
	if prefetch.running || len(prefetch.queue) == 0 {
		return
	}
	prefetch.running = true
	if !s.Go(s.runVideoKeyframePrefetch) {
		prefetch.running = false
		prefetch.queue, prefetch.queued = nil, nil
	}
}

func (s *Server) runVideoKeyframePrefetch(lifetime context.Context) {
	prefetch := &s.videoKeyframePrefetch
	for {
		prefetch.mu.Lock()
		if len(prefetch.queue) == 0 || lifetime.Err() != nil {
			prefetch.running = false
			prefetch.queue, prefetch.queued = nil, nil
			prefetch.mu.Unlock()
			return
		}
		location := prefetch.queue[0]
		prefetch.queue = prefetch.queue[1:]
		delete(prefetch.queued, location)
		prefetch.mu.Unlock()

		source, err := s.loadHLSPlaybackSource(lifetime, location)
		if err != nil || source.Profile != playbackProfileVideo || !videoRemuxCandidate(source) {
			continue
		}
		if _, err := s.prefetchVideoKeyframeIndex(lifetime, source); err != nil &&
			!errors.Is(err, context.Canceled) && !errors.Is(err, errVideoKeyframeIndexUnusable) {
			slog.Debug("video keyframe prefetch failed", "location_id", location, "error", err)
		}
	}
}
