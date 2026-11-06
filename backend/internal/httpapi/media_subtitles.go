package httpapi

import (
	"context"
	"crypto/sha256"
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
	"time"
)

const (
	videoSubtitleProfileVersion = "webvtt-v1"
	// Extraction reads the whole container to collect one stream's packets.
	videoSubtitleExtractTimeout = 2 * time.Minute
	// Extractions run one at a time in a slot of their own, so they never wait
	// for or hold up a transcode. A few requests may wait for the slot, each
	// for as long as one extraction may take.
	videoSubtitleExtractSlots     = 1
	videoSubtitleExtractQueueSize = 4
	videoSubtitleExtractQueueWait = videoSubtitleExtractTimeout
	videoSubtitlePartialPrefix    = ".subtitle-extract-"
	// Subtitle streams per file listed in playback info.
	videoSubtitleStreamLimit = 32
	// Runes kept of a stream's language and title tags.
	videoSubtitleTextLimit = 100
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

// videoSubtitleStreams returns the text subtitle streams of a playback probe
// in file order.
func videoSubtitleStreams(probe playbackProbe) []playbackProbeStream {
	streams := []playbackProbeStream{}
	for _, stream := range probe.Streams {
		codec := strings.ToLower(strings.TrimSpace(stream.CodecName))
		if !strings.EqualFold(strings.TrimSpace(stream.CodecType), "subtitle") || stream.StreamIndex < 0 || !videoSubtitleTextCodecs[codec] {
			continue
		}
		stream.CodecName = codec
		streams = append(streams, stream)
		if len(streams) == videoSubtitleStreamLimit {
			break
		}
	}
	return streams
}

func videoSubtitleRevision(path string, info os.FileInfo, stream int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d\x00%d\x00%d", videoSubtitleProfileVersion, path, info.Size(), info.ModTime().UnixNano(), stream)))
	return fmt.Sprintf("%x", sum[:16])
}

func videoSubtitleCachePath(revision string) string {
	return filepath.ToSlash(filepath.Join(transcodeCacheRootRelative, "subtitles", revision+".vtt"))
}

// videoSubtitleTracksFor lists the embedded text subtitle streams of a
// playback source from the probe playback already made.
func videoSubtitleTracksFor(source hlsPlaybackSource) []videoSubtitleTrack {
	streams := videoSubtitleStreams(source.Probe)
	if len(streams) == 0 {
		return nil
	}
	info, err := os.Stat(source.Path)
	if err != nil {
		return nil
	}
	tracks := make([]videoSubtitleTrack, 0, len(streams))
	for _, stream := range streams {
		tracks = append(tracks, videoSubtitleTrack{
			Stream:   stream.StreamIndex,
			Codec:    stream.CodecName,
			Language: boundedSubtitleText(stream.Tags.Language),
			Title:    boundedSubtitleText(stream.Tags.Title),
			Default:  stream.Disposition.Default == 1,
			Forced:   stream.Disposition.Forced == 1,
			URL: fmt.Sprintf("/api/media/%d/subtitles/%d.vtt?v=%s", source.LocationID, stream.StreamIndex,
				videoSubtitleRevision(source.Path, info, stream.StreamIndex)),
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
	found := false
	for _, candidate := range videoSubtitleStreams(source.Probe) {
		found = found || candidate.StreamIndex == stream
	}
	if !found {
		writeAPIError(w, http.StatusNotFound, "subtitle_not_found", "subtitle was not found", false)
		return
	}
	info, err := os.Stat(source.Path)
	if err != nil || !info.Mode().IsRegular() {
		s.writeHLSPlaybackError(w, errHLSMediaNotFound, playbackProfileVideo)
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
// it first in the subtitle slot. Extraction holds no transcode cache lock, so
// clearing the cache never waits for it; only storing the result does.
func (s *Server) openVideoSubtitle(ctx context.Context, input string, inputInfo os.FileInfo, stream int, revision string) (*os.File, error) {
	relPath := videoSubtitleCachePath(revision)
	output, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return nil, err
	}
	// Concurrent requests for one stream share its extraction.
	releasePreparation, err := s.audioTranscodeLocks.acquire(ctx, output)
	if err != nil {
		return nil, err
	}
	defer releasePreparation()
	if file, err := s.openCachedVideoSubtitle(ctx, relPath, output); file != nil || err != nil {
		return file, err
	}
	failureKey := mediaPreparationFailureKey("subtitle-webvtt:"+strconv.Itoa(stream), input, inputInfo)
	if s.mediaPreparationFailures.failedRecently(failureKey) {
		return nil, fmt.Errorf("%w: extraction failed recently", errVideoSubtitleUnavailable)
	}
	content, err := s.extractVideoSubtitle(ctx, input, inputInfo, stream)
	if err != nil {
		if errors.Is(err, errVideoSubtitleUnavailable) {
			s.mediaPreparationFailures.remember(failureKey)
		}
		return nil, err
	}
	return s.storeVideoSubtitle(ctx, relPath, output, content)
}

// openCachedVideoSubtitle opens the cached WebVTT of a stream, or returns nil
// when none is cached.
func (s *Server) openCachedVideoSubtitle(ctx context.Context, relPath string, output string) (*os.File, error) {
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	releasePath, err := s.acquireCachePathLock(ctx, relPath)
	if err != nil {
		return nil, err
	}
	defer releasePath()
	if !validCachedSubtitle(output) {
		return nil, nil
	}
	return openCompleteAudio(output)
}

// storeVideoSubtitle publishes extracted WebVTT at output under a quota
// reservation of its size and opens it.
func (s *Server) storeVideoSubtitle(ctx context.Context, relPath string, output string, content []byte) (*os.File, error) {
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	// Reserve before locking the path, as audio preparation does.
	releaseReservation, err := s.reserveTranscodeCache(ctx, int64(len(content)))
	if err != nil {
		return nil, err
	}
	defer releaseReservation()
	releasePath, err := s.acquireCachePathLock(ctx, relPath)
	if err != nil {
		return nil, err
	}
	defer releasePath()
	if _, _, err := s.removeCacheFileUnlocked(relPath); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(output), videoSubtitlePartialPrefix+"*.part")
	if err != nil {
		return nil, err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	_, writeErr := temporary.Write(content)
	syncErr := temporary.Sync()
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return nil, err
	}
	if err := os.Rename(temporaryPath, output); err != nil {
		return nil, err
	}
	return openCompleteAudio(output)
}

func validCachedSubtitle(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0 && info.Size() <= videoSubtitleMaximumBytes
}

// extractVideoSubtitle converts one subtitle stream to WebVTT in memory, in
// the subtitle slot.
func (s *Server) extractVideoSubtitle(ctx context.Context, input string, inputInfo os.FileInfo, stream int) ([]byte, error) {
	release, err := s.acquireSubtitleExtraction(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	extractContext, cancel := context.WithTimeout(ctx, videoSubtitleExtractTimeout)
	defer cancel()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, fmt.Errorf("%w: ffmpeg executable was not found", errVideoSubtitleUnavailable)
	}
	command := exec.CommandContext(extractContext, ffmpeg, videoSubtitleFFmpegArgs(input, stream)...)
	content := &limitedCommandOutput{limit: int(videoSubtitleMaximumBytes)}
	command.Stdout = content
	diagnostics := &transcodeDiagnosticOutput{}
	command.Stderr = diagnostics
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(extractContext.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("%w: extraction timed out", errVideoSubtitleUnavailable)
		}
		if content.exceeded {
			return nil, fmt.Errorf("%w: output exceeded its byte limit", errVideoSubtitleUnavailable)
		}
		return nil, fmt.Errorf("%w: command failed: %v: %s", errVideoSubtitleUnavailable, err, diagnostics.String())
	}
	if content.exceeded || !strings.HasPrefix(strings.TrimPrefix(content.buffer.String(), string(rune(0xFEFF))), "WEBVTT") {
		return nil, fmt.Errorf("%w: output is not WebVTT or reached its byte limit", errVideoSubtitleUnavailable)
	}
	currentInput, err := os.Stat(input)
	if err != nil || !currentInput.Mode().IsRegular() || currentInput.Size() != inputInfo.Size() || !currentInput.ModTime().Equal(inputInfo.ModTime()) {
		return nil, fmt.Errorf("%w: source changed during extraction", errVideoSubtitleUnavailable)
	}
	return content.buffer.Bytes(), nil
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
