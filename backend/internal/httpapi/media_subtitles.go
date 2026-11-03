package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	videoSubtitleProfileVersion = "webvtt-v1"
	// Extraction reads the whole container to collect one stream's packets.
	videoSubtitleExtractTimeout = 2 * time.Minute
	// Subtitle streams per file listed in playback info.
	videoSubtitleStreamLimit = 32
	// Runes kept of a stream's language and title tags.
	videoSubtitleTextLimit = 100
	videoSubtitleProbeTTL  = 10 * time.Minute
	videoSubtitleProbeSize = 128
)

// videoSubtitleTextCodecs are the embedded subtitle codecs FFmpeg converts
// to WebVTT. Image subtitles such as PGS, DVD, and DVB are not listed.
var videoSubtitleTextCodecs = map[string]bool{
	"subrip": true, "ass": true, "ssa": true, "webvtt": true, "mov_text": true,
}

var (
	// videoSubtitleMaximumBytes bounds one extracted WebVTT file; a long video
	// with dense signs stays far below it.
	videoSubtitleMaximumBytes   = int64(4 << 20)
	videoSubtitleFilePattern    = regexp.MustCompile(`^([0-9]{1,4})\.vtt$`)
	errVideoSubtitleUnavailable = errors.New("subtitle extraction is unavailable")
)

// videoSubtitleTrack is an embedded text subtitle stream in playback info.
type videoSubtitleTrack struct {
	// Stream is the stream's index in the container.
	Stream   int    `json:"stream"`
	Codec    string `json:"codec"`
	Language string `json:"language,omitempty"`
	Title    string `json:"title,omitempty"`
	Default  bool   `json:"default"`
	Forced   bool   `json:"forced"`
	URL      string `json:"url"`
}

type videoSubtitleProbe struct {
	Streams []videoSubtitleProbeStream `json:"streams"`
}

type videoSubtitleProbeStream struct {
	Index       int               `json:"index"`
	CodecType   string            `json:"codec_type"`
	CodecName   string            `json:"codec_name"`
	Tags        map[string]string `json:"tags"`
	Disposition map[string]int    `json:"disposition"`
}

type videoSubtitleProbeEntry struct {
	streams   []videoSubtitleProbeStream
	sizeBytes int64
	modTime   time.Time
	expiresAt time.Time
}

// videoSubtitleProbes keeps the subtitle streams of recently probed files,
// keyed by path and valid for the size and modification time they read.
type videoSubtitleProbes struct {
	mu      sync.Mutex
	entries map[string]videoSubtitleProbeEntry
}

func (probes *videoSubtitleProbes) get(path string, info os.FileInfo) ([]videoSubtitleProbeStream, bool) {
	probes.mu.Lock()
	defer probes.mu.Unlock()
	entry, ok := probes.entries[path]
	if !ok || time.Now().After(entry.expiresAt) || entry.sizeBytes != info.Size() || !entry.modTime.Equal(info.ModTime()) {
		delete(probes.entries, path)
		return nil, false
	}
	return entry.streams, true
}

func (probes *videoSubtitleProbes) put(path string, info os.FileInfo, streams []videoSubtitleProbeStream) {
	now := time.Now()
	probes.mu.Lock()
	defer probes.mu.Unlock()
	if probes.entries == nil {
		probes.entries = make(map[string]videoSubtitleProbeEntry)
	}
	for len(probes.entries) >= videoSubtitleProbeSize {
		var oldestKey string
		var oldest time.Time
		for key, entry := range probes.entries {
			if oldestKey == "" || entry.expiresAt.Before(oldest) {
				oldestKey, oldest = key, entry.expiresAt
			}
		}
		delete(probes.entries, oldestKey)
	}
	probes.entries[path] = videoSubtitleProbeEntry{
		streams: streams, sizeBytes: info.Size(), modTime: info.ModTime(), expiresAt: now.Add(videoSubtitleProbeTTL),
	}
}

// probeVideoSubtitleStreams lists the text subtitle streams of a file
// through the shared bounded FFprobe runner.
func (s *Server) probeVideoSubtitleStreams(ctx context.Context, path string) ([]videoSubtitleProbeStream, os.FileInfo, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, nil, errHLSMediaNotFound
	}
	if streams, ok := s.videoSubtitleProbes.get(path, info); ok {
		return streams, info, nil
	}
	output, err := s.runBoundedFFprobe(ctx, path, "stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default,forced")
	if err != nil {
		return nil, nil, err
	}
	streams, err := parseVideoSubtitleProbe(output)
	if err != nil {
		return nil, nil, err
	}
	s.videoSubtitleProbes.put(path, info, streams)
	return streams, info, nil
}

func parseVideoSubtitleProbe(output []byte) ([]videoSubtitleProbeStream, error) {
	var probe videoSubtitleProbe
	if err := json.Unmarshal(output, &probe); err != nil {
		return nil, fmt.Errorf("%w: invalid subtitle probe output", errMediaProbeRejected)
	}
	streams := []videoSubtitleProbeStream{}
	for _, stream := range probe.Streams {
		if !strings.EqualFold(strings.TrimSpace(stream.CodecType), "subtitle") || stream.Index < 0 ||
			!videoSubtitleTextCodecs[strings.ToLower(strings.TrimSpace(stream.CodecName))] {
			continue
		}
		stream.CodecName = strings.ToLower(strings.TrimSpace(stream.CodecName))
		streams = append(streams, stream)
		if len(streams) == videoSubtitleStreamLimit {
			break
		}
	}
	return streams, nil
}

func videoSubtitleRevision(path string, info os.FileInfo, stream int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d\x00%d\x00%d", videoSubtitleProfileVersion, path, info.Size(), info.ModTime().UnixNano(), stream)))
	return fmt.Sprintf("%x", sum[:16])
}

func videoSubtitleCachePath(revision string) string {
	return filepath.ToSlash(filepath.Join(transcodeCacheRootRelative, "subtitles", revision+".vtt"))
}

// videoSubtitleTracksFor lists the embedded text subtitle streams of a
// playback source. A probe that fails or waits too long lists none, so
// subtitles never hold up playback.
func (s *Server) videoSubtitleTracksFor(ctx context.Context, source hlsPlaybackSource) []videoSubtitleTrack {
	streams, info, err := s.probeVideoSubtitleStreams(ctx, source.Path)
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			slog.Info("video subtitles are not listed", "location_id", source.LocationID, "error", err)
		}
		return nil
	}
	tracks := make([]videoSubtitleTrack, 0, len(streams))
	for _, stream := range streams {
		tracks = append(tracks, videoSubtitleTrack{
			Stream:   stream.Index,
			Codec:    stream.CodecName,
			Language: boundedSubtitleText(stream.Tags["language"]),
			Title:    boundedSubtitleText(stream.Tags["title"]),
			Default:  stream.Disposition["default"] == 1,
			Forced:   stream.Disposition["forced"] == 1,
			URL: fmt.Sprintf("/api/media/%d/subtitles/%d.vtt?v=%s", source.LocationID, stream.Index,
				videoSubtitleRevision(source.Path, info, stream.Index)),
		})
	}
	return tracks
}

func boundedSubtitleText(value string) string {
	runes := []rune(strings.Join(strings.Fields(value), " "))
	if len(runes) > videoSubtitleTextLimit {
		runes = runes[:videoSubtitleTextLimit]
	}
	return string(runes)
}

// serveVideoSubtitle serves an embedded text subtitle stream of a local or
// cached video as WebVTT, extracted once per source revision into the
// transcode cache.
func (s *Server) serveVideoSubtitle(w http.ResponseWriter, r *http.Request) {
	match := videoSubtitleFilePattern.FindStringSubmatch(strings.TrimSpace(r.PathValue("file")))
	if match == nil {
		writeAPIError(w, http.StatusNotFound, "subtitle_not_found", "subtitle was not found", false)
		return
	}
	stream, _ := strconv.Atoi(match[1])
	locationID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_media_location", "invalid media location id", false)
		return
	}
	source, err := s.loadHLSPlaybackSource(r.Context(), locationID)
	if err == nil && source.Profile != playbackProfileVideo {
		err = errHLSMediaNotFound
	}
	if err != nil {
		s.writeHLSPlaybackError(w, err, playbackProfileVideo)
		return
	}
	streams, info, err := s.probeVideoSubtitleStreams(r.Context(), source.Path)
	if err != nil {
		s.writeHLSPlaybackError(w, err, playbackProfileVideo)
		return
	}
	found := false
	for _, candidate := range streams {
		found = found || candidate.Index == stream
	}
	if !found {
		writeAPIError(w, http.StatusNotFound, "subtitle_not_found", "subtitle was not found", false)
		return
	}
	revision := videoSubtitleRevision(source.Path, info, stream)
	file, err := s.openVideoSubtitle(r.Context(), source.Path, info, stream, revision)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) && r.Context().Err() != nil {
			return
		}
		slog.Warn("video subtitle extraction failed", "location_id", locationID, "stream", stream, "error", err)
		switch {
		case errors.Is(err, errRealtimeResourceBusy):
			w.Header().Set("Retry-After", "1")
			writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_busy", "media playback is temporarily busy", true)
		case errors.Is(err, errVideoSubtitleUnavailable):
			writeAPIError(w, http.StatusServiceUnavailable, "subtitle_unavailable", "subtitle could not be prepared", true)
		default:
			writeAPIError(w, http.StatusInsufficientStorage, "transcode_cache_unavailable", "subtitle cache is unavailable", true)
		}
		return
	}
	defer func() { _ = file.Close() }()
	setUntrustedFileHeaders(w)
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("ETag", strconv.Quote(revision))
	if r.URL.Query().Get("v") == revision {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	http.ServeContent(w, r, revision+".vtt", info.ModTime(), file)
}

// openVideoSubtitle returns the cached WebVTT of a subtitle stream, extracting
// it first under a transcode slot and a quota reservation.
func (s *Server) openVideoSubtitle(ctx context.Context, input string, inputInfo os.FileInfo, stream int, revision string) (*os.File, error) {
	relPath := videoSubtitleCachePath(revision)
	output, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return nil, err
	}
	releasePreparation, err := s.audioTranscodeLocks.acquire(ctx, output)
	if err != nil {
		return nil, err
	}
	defer releasePreparation()
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	releasePath, err := s.acquireCachePathLock(ctx, relPath)
	if err != nil {
		return nil, err
	}
	if validCachedSubtitle(output) {
		defer releasePath()
		return openCompleteAudio(output)
	}
	releasePath()
	failureKey := mediaPreparationFailureKey("subtitle-webvtt:"+strconv.Itoa(stream), input, inputInfo)
	if s.mediaPreparationFailures.failedRecently(failureKey) {
		return nil, fmt.Errorf("%w: extraction failed recently", errVideoSubtitleUnavailable)
	}
	// Reserve before locking the path, as audio preparation does.
	releaseReservation, err := s.reserveTranscodeCache(ctx, videoSubtitleMaximumBytes)
	if err != nil {
		return nil, err
	}
	defer releaseReservation()
	releasePath, err = s.acquireCachePathLock(ctx, relPath)
	if err != nil {
		return nil, err
	}
	defer releasePath()
	if !validCachedSubtitle(output) {
		if _, _, err := s.removeCacheFileUnlocked(relPath); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
			return nil, err
		}
		if err := s.extractVideoSubtitle(ctx, input, inputInfo, stream, output); err != nil {
			if errors.Is(err, errVideoSubtitleUnavailable) {
				s.mediaPreparationFailures.remember(failureKey)
			}
			return nil, err
		}
	}
	return openCompleteAudio(output)
}

func validCachedSubtitle(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0 && info.Size() <= videoSubtitleMaximumBytes
}

func (s *Server) extractVideoSubtitle(ctx context.Context, input string, inputInfo os.FileInfo, stream int, output string) error {
	extractContext, cancel := context.WithTimeout(ctx, videoSubtitleExtractTimeout)
	defer cancel()
	release, err := s.acquireRealtimeTranscode(extractContext)
	if err != nil {
		return err
	}
	defer release()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return fmt.Errorf("%w: ffmpeg executable was not found", errVideoSubtitleUnavailable)
	}
	command := exec.CommandContext(extractContext, ffmpeg, videoSubtitleFFmpegArgs(input, stream)...)
	content := &limitedCommandOutput{limit: int(videoSubtitleMaximumBytes)}
	command.Stdout = content
	diagnostics := &transcodeDiagnosticOutput{}
	command.Stderr = diagnostics
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if errors.Is(extractContext.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("%w: extraction timed out", errVideoSubtitleUnavailable)
		}
		if content.exceeded {
			return fmt.Errorf("%w: output exceeded its byte limit", errVideoSubtitleUnavailable)
		}
		return fmt.Errorf("%w: command failed: %v: %s", errVideoSubtitleUnavailable, err, diagnostics.String())
	}
	if content.exceeded || !strings.HasPrefix(strings.TrimPrefix(content.buffer.String(), "\ufeff"), "WEBVTT") {
		return fmt.Errorf("%w: output is not WebVTT or reached its byte limit", errVideoSubtitleUnavailable)
	}
	currentInput, err := os.Stat(input)
	if err != nil || !currentInput.Mode().IsRegular() || currentInput.Size() != inputInfo.Size() || !currentInput.ModTime().Equal(inputInfo.ModTime()) {
		return fmt.Errorf("%w: source changed during extraction", errVideoSubtitleUnavailable)
	}
	temporary, err := os.CreateTemp(filepath.Dir(output), ".subtitle-extract-*.part")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	_, writeErr := temporary.Write(content.buffer.Bytes())
	syncErr := temporary.Sync()
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	return os.Rename(temporaryPath, output)
}

func videoSubtitleFFmpegArgs(input string, stream int) []string {
	return []string{
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-threads", "1", "-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe", "-i", input,
		"-map", "0:" + strconv.Itoa(stream), "-map_metadata", "-1", "-vn", "-an", "-dn",
		"-c:s", "webvtt", "-f", "webvtt", "pipe:1",
	}
}
