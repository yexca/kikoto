package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

const (
	realtimeProbeTimeout          = 5 * time.Second
	realtimeProbeQueueTimeout     = 1 * time.Second
	realtimeProbeSlotsSize        = 2
	realtimeProbeQueueSize        = 2
	realtimeProbeCacheTTL         = 2 * time.Minute
	realtimeProbeCacheSize        = 128
	realtimeTranscodeStartup      = 15 * time.Second
	realtimeTranscodeTimeout      = 2 * time.Hour
	realtimeTranscodeQueueTimeout = 1 * time.Second
	realtimeTranscodeSlotsSize    = 2
	realtimeTranscodeQueueSize    = 2
	remotePlaybackTimeout         = 2 * time.Hour
	realtimeProbeOutputLimit      = 128 << 10
)

const (
	playbackProfileAudio = "audio"
	playbackProfileVideo = "video"
)

const (
	capAudioMP3            = "audio-mp3"
	capAudioMP4AAC         = "audio-mp4-aac"
	capAudioFLAC           = "audio-flac"
	capAudioOggOpus        = "audio-ogg-opus"
	capAudioOggVorbis      = "audio-ogg-vorbis"
	capAudioWebMOpus       = "audio-webm-opus"
	capAudioWebMVorbis     = "audio-webm-vorbis"
	capAudioWAV            = "audio-wav"
	capVideoMP4H264AAC     = "video-mp4-h264-aac"
	capVideoMP4H264MP3     = "video-mp4-h264-mp3"
	capVideoMP4H264NoAudio = "video-mp4-h264-noaudio"
	capVideoWebMVP8Opus    = "video-webm-vp8-opus"
	capVideoWebMVP8Vorbis  = "video-webm-vp8-vorbis"
	capVideoWebMVP8NoAudio = "video-webm-vp8-noaudio"
	capVideoWebMVP9Opus    = "video-webm-vp9-opus"
	capVideoWebMVP9Vorbis  = "video-webm-vp9-vorbis"
	capVideoWebMVP9NoAudio = "video-webm-vp9-noaudio"
)

type playbackProbe struct {
	Format  playbackProbeFormat   `json:"format"`
	Streams []playbackProbeStream `json:"streams"`
}

type playbackProbeFormat struct {
	FormatName string `json:"format_name"`
	Duration   string `json:"duration"`
}

type playbackProbeStream struct {
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	Profile   string `json:"profile"`
	PixelFmt  string `json:"pix_fmt"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

type playbackProbeCacheEntry struct {
	Probe     playbackProbe
	SizeBytes int64
	ModTime   time.Time
	ExpiresAt time.Time
	UsedAt    time.Time
}

type limitedCommandOutput struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
}

type transcodeStartResult struct {
	data []byte
	err  error
}

func readTranscodeStart(ctx context.Context, reader io.Reader) ([]byte, error) {
	result := make(chan transcodeStartResult, 1)
	go func() {
		buffer := make([]byte, 32<<10)
		count, err := reader.Read(buffer)
		result <- transcodeStartResult{data: buffer[:count], err: err}
	}()
	timer := time.NewTimer(realtimeTranscodeStartup)
	defer timer.Stop()
	select {
	case value := <-result:
		return value.data, value.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("media transcoding did not start")
	}
}

func writeTranscodeFailure(w http.ResponseWriter, err error) error {
	writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "media playback preparation failed", true)
	return err
}

func (output *limitedCommandOutput) Write(value []byte) (int, error) {
	remaining := output.limit - output.buffer.Len()
	if remaining <= 0 {
		output.exceeded = true
		return 0, io.ErrShortBuffer
	}
	if len(value) > remaining {
		_, _ = output.buffer.Write(value[:remaining])
		output.exceeded = true
		return remaining, io.ErrShortBuffer
	}
	return output.buffer.Write(value)
}

func (s *Server) playbackProfile(r *http.Request, kind string) (string, error) {
	profile := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("profile")))
	if profile == "" {
		if kind == "video" {
			return playbackProfileVideo, nil
		}
		if kind == "audio" {
			return playbackProfileAudio, nil
		}
		return "", fmt.Errorf("media kind is not playable")
	}
	if profile != playbackProfileAudio && profile != playbackProfileVideo {
		return "", fmt.Errorf("invalid playback profile")
	}
	if profile == playbackProfileVideo && kind != "video" {
		return "", fmt.Errorf("video profile requires video media")
	}
	if profile == playbackProfileAudio && kind != "audio" && kind != "video" {
		return "", fmt.Errorf("audio profile requires audio media")
	}
	return profile, nil
}

func playbackCapabilities(r *http.Request) map[string]bool {
	values := strings.Split(strings.TrimSpace(r.URL.Query().Get("capabilities")), ",")
	allowed := map[string]bool{
		capAudioMP3:            true,
		capAudioMP4AAC:         true,
		capAudioFLAC:           true,
		capAudioOggOpus:        true,
		capAudioOggVorbis:      true,
		capAudioWebMOpus:       true,
		capAudioWebMVorbis:     true,
		capAudioWAV:            true,
		capVideoMP4H264AAC:     true,
		capVideoMP4H264MP3:     true,
		capVideoMP4H264NoAudio: true,
		capVideoWebMVP8Opus:    true,
		capVideoWebMVP8Vorbis:  true,
		capVideoWebMVP8NoAudio: true,
		capVideoWebMVP9Opus:    true,
		capVideoWebMVP9Vorbis:  true,
		capVideoWebMVP9NoAudio: true,
	}
	result := make(map[string]bool)
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if allowed[value] {
			result[value] = true
		}
		if len(result) >= 16 {
			break
		}
	}
	return result
}

func forcePlaybackTranscode(r *http.Request) bool {
	value := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("forceTranscode")))
	return value == "1" || value == "true" || value == "yes"
}

type realtimeResourceKind uint8

const (
	realtimeResourceProbe realtimeResourceKind = iota
	realtimeResourceTranscode
)

var errRealtimeResourceBusy = errors.New("realtime media resource is busy")

func (s *Server) realtimeResourceChannels(kind realtimeResourceKind) (chan struct{}, chan struct{}) {
	s.realtimeResourceMu.Lock()
	defer s.realtimeResourceMu.Unlock()
	if kind == realtimeResourceProbe {
		if s.realtimeProbeSlots == nil {
			s.realtimeProbeSlots = make(chan struct{}, realtimeProbeSlotsSize)
		}
		if s.realtimeProbeQueue == nil {
			s.realtimeProbeQueue = make(chan struct{}, realtimeProbeQueueSize)
		}
		return s.realtimeProbeSlots, s.realtimeProbeQueue
	}
	if s.realtimeTranscodeSlots == nil {
		s.realtimeTranscodeSlots = make(chan struct{}, realtimeTranscodeSlotsSize)
	}
	if s.realtimeTranscodeQueue == nil {
		s.realtimeTranscodeQueue = make(chan struct{}, realtimeTranscodeQueueSize)
	}
	return s.realtimeTranscodeSlots, s.realtimeTranscodeQueue
}

func (s *Server) acquireRealtimeResource(ctx context.Context, kind realtimeResourceKind, queueTimeout time.Duration) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	slots, queue := s.realtimeResourceChannels(kind)
	newRelease := func() func() {
		var releaseOnce sync.Once
		return func() {
			releaseOnce.Do(func() { <-slots })
		}
	}
	select {
	case slots <- struct{}{}:
		return newRelease(), nil
	default:
	}
	select {
	case queue <- struct{}{}:
	default:
		return nil, errRealtimeResourceBusy
	}
	defer func() { <-queue }()
	queueContext, cancel := context.WithTimeout(ctx, queueTimeout)
	defer cancel()
	select {
	case slots <- struct{}{}:
		return newRelease(), nil
	case <-queueContext.Done():
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return nil, errRealtimeResourceBusy
	}
}

func (s *Server) acquireRealtimeProbe(ctx context.Context) (func(), error) {
	return s.acquireRealtimeResource(ctx, realtimeResourceProbe, realtimeProbeQueueTimeout)
}

func (s *Server) acquireRealtimeTranscode(ctx context.Context) (func(), error) {
	return s.acquireRealtimeResource(ctx, realtimeResourceTranscode, realtimeTranscodeQueueTimeout)
}

func (s *Server) cachedPlaybackProbe(path string, sizeBytes int64, modTime time.Time) (playbackProbe, bool) {
	now := time.Now()
	s.realtimeProbeCacheMu.Lock()
	defer s.realtimeProbeCacheMu.Unlock()
	if s.realtimeProbeCache == nil {
		s.realtimeProbeCache = make(map[string]playbackProbeCacheEntry)
	}
	entry, ok := s.realtimeProbeCache[path]
	if !ok || now.After(entry.ExpiresAt) || entry.SizeBytes != sizeBytes || !entry.ModTime.Equal(modTime) {
		if ok {
			delete(s.realtimeProbeCache, path)
		}
		return playbackProbe{}, false
	}
	entry.UsedAt = now
	s.realtimeProbeCache[path] = entry
	return entry.Probe, true
}

func (s *Server) cachePlaybackProbe(path string, info os.FileInfo, probe playbackProbe) {
	now := time.Now()
	s.realtimeProbeCacheMu.Lock()
	defer s.realtimeProbeCacheMu.Unlock()
	if s.realtimeProbeCache == nil {
		s.realtimeProbeCache = make(map[string]playbackProbeCacheEntry)
	}
	for key, entry := range s.realtimeProbeCache {
		if now.After(entry.ExpiresAt) {
			delete(s.realtimeProbeCache, key)
		}
	}
	for len(s.realtimeProbeCache) >= realtimeProbeCacheSize {
		var oldestKey string
		var oldest time.Time
		for key, entry := range s.realtimeProbeCache {
			if oldestKey == "" || entry.UsedAt.Before(oldest) {
				oldestKey, oldest = key, entry.UsedAt
			}
		}
		if oldestKey == "" {
			break
		}
		delete(s.realtimeProbeCache, oldestKey)
	}
	s.realtimeProbeCache[path] = playbackProbeCacheEntry{
		Probe: probe, SizeBytes: info.Size(), ModTime: info.ModTime(),
		ExpiresAt: now.Add(realtimeProbeCacheTTL), UsedAt: now,
	}
}

func (s *Server) probePlaybackFile(ctx context.Context, path string) (playbackProbe, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return playbackProbe{}, fmt.Errorf("media file was not found")
	}
	if probe, ok := s.cachedPlaybackProbe(path, info.Size(), info.ModTime()); ok {
		return probe, nil
	}
	output, err := s.runBoundedFFprobe(ctx, path, "format=format_name,duration:stream=codec_type,codec_name,profile,pix_fmt,width,height")
	if err != nil {
		return playbackProbe{}, err
	}
	var result playbackProbe
	if err := json.Unmarshal(output, &result); err != nil {
		return playbackProbe{}, fmt.Errorf("media probe returned invalid output")
	}
	s.cachePlaybackProbe(path, info, result)
	return result, nil
}

func (s *Server) runBoundedFFprobe(ctx context.Context, path string, showEntries string) ([]byte, error) {
	probeContext, cancel := context.WithTimeout(ctx, realtimeProbeTimeout)
	defer cancel()
	release, err := s.acquireRealtimeProbe(probeContext)
	if err != nil {
		return nil, fmt.Errorf("media probe is busy: %w", err)
	}
	defer release()
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		return nil, fmt.Errorf("ffprobe is unavailable")
	}
	command := exec.CommandContext(
		probeContext,
		ffprobePath,
		"-v", "error",
		"-threads", "1",
		"-probesize", "32M",
		"-analyzeduration", "10M",
		"-show_entries", showEntries,
		"-of", "json",
		path,
	)
	command.Stderr = io.Discard
	output := &limitedCommandOutput{limit: realtimeProbeOutputLimit}
	command.Stdout = output
	if err := command.Run(); err != nil {
		if output.exceeded {
			return nil, fmt.Errorf("ffprobe output exceeded limit")
		}
		if errors.Is(probeContext.Err(), context.DeadlineExceeded) {
			return nil, fmt.Errorf("media probe timed out")
		}
		return nil, fmt.Errorf("media probe failed")
	}
	return append([]byte(nil), output.buffer.Bytes()...), nil
}

func firstPlaybackStream(probe playbackProbe, codecType string) *playbackProbeStream {
	for index := range probe.Streams {
		if strings.EqualFold(strings.TrimSpace(probe.Streams[index].CodecType), codecType) {
			return &probe.Streams[index]
		}
	}
	return nil
}

func playbackFormatIncludes(probe playbackProbe, name string) bool {
	for _, value := range strings.Split(strings.ToLower(probe.Format.FormatName), ",") {
		if strings.TrimSpace(value) == name {
			return true
		}
	}
	return false
}

func directPlaybackContentType(probe playbackProbe, profile string, capabilities map[string]bool) (string, bool) {
	audio := firstPlaybackStream(probe, "audio")
	video := firstPlaybackStream(probe, "video")
	if profile == playbackProfileAudio {
		if audio == nil {
			return "", false
		}
		switch strings.ToLower(strings.TrimSpace(audio.CodecName)) {
		case "mp3":
			if playbackFormatIncludes(probe, "mp3") && capabilities[capAudioMP3] {
				return "audio/mpeg", true
			}
		case "aac":
			if (playbackFormatIncludes(probe, "mov") || playbackFormatIncludes(probe, "mp4") || playbackFormatIncludes(probe, "m4a") || playbackFormatIncludes(probe, "3gp")) && capabilities[capAudioMP4AAC] {
				return "audio/mp4", true
			}
		case "flac":
			if playbackFormatIncludes(probe, "flac") && capabilities[capAudioFLAC] {
				return "audio/flac", true
			}
		case "opus":
			if playbackFormatIncludes(probe, "webm") && capabilities[capAudioWebMOpus] {
				return "audio/webm", true
			}
			if (playbackFormatIncludes(probe, "ogg") || playbackFormatIncludes(probe, "opus")) && capabilities[capAudioOggOpus] {
				return `audio/ogg; codecs="opus"`, true
			}
		case "vorbis":
			if playbackFormatIncludes(probe, "webm") && capabilities[capAudioWebMVorbis] {
				return "audio/webm", true
			}
			if playbackFormatIncludes(probe, "ogg") && capabilities[capAudioOggVorbis] {
				return `audio/ogg; codecs="vorbis"`, true
			}
		case "pcm_s16le", "pcm_s24le", "pcm_s32le":
			if playbackFormatIncludes(probe, "wav") && capabilities[capAudioWAV] {
				return "audio/wav", true
			}
		}
		return "", false
	}
	if video == nil {
		return "", false
	}
	videoCodec := strings.ToLower(strings.TrimSpace(video.CodecName))
	audioCodec := "noaudio"
	if audio != nil {
		audioCodec = strings.ToLower(strings.TrimSpace(audio.CodecName))
	}
	if videoCodec == "h264" && browserSafeH264(video) && (playbackFormatIncludes(probe, "mov") || playbackFormatIncludes(probe, "mp4") || playbackFormatIncludes(probe, "m4v") || playbackFormatIncludes(probe, "3gp")) {
		switch audioCodec {
		case "aac":
			if capabilities[capVideoMP4H264AAC] {
				return "video/mp4", true
			}
		case "mp3":
			if capabilities[capVideoMP4H264MP3] {
				return "video/mp4", true
			}
		case "noaudio":
			if capabilities[capVideoMP4H264NoAudio] {
				return "video/mp4", true
			}
		}
	}
	if playbackFormatIncludes(probe, "webm") && (videoCodec == "vp8" || videoCodec == "vp9") {
		prefix := "video-webm-vp9-"
		if videoCodec == "vp8" {
			prefix = "video-webm-vp8-"
		}
		switch audioCodec {
		case "opus":
			if capabilities[prefix+"opus"] {
				return "video/webm", true
			}
		case "vorbis":
			if capabilities[prefix+"vorbis"] {
				return "video/webm", true
			}
		case "noaudio":
			if capabilities[prefix+"noaudio"] {
				return "video/webm", true
			}
		}
	}
	return "", false
}

func browserSafeH264(stream *playbackProbeStream) bool {
	pixelFormat := strings.ToLower(strings.TrimSpace(stream.PixelFmt))
	if pixelFormat != "" && pixelFormat != "yuv420p" && pixelFormat != "yuvj420p" {
		return false
	}
	profile := strings.ToLower(strings.TrimSpace(stream.Profile))
	if profile == "" {
		return true
	}
	for _, allowed := range []string{"baseline", "constrained baseline", "main", "high", "constrained high"} {
		if profile == allowed {
			return true
		}
	}
	return false
}

func fallbackDirectPlaybackContentType(path string, profile string) (string, bool) {
	extension := strings.ToLower(filepath.Ext(path))
	if profile == playbackProfileAudio {
		switch extension {
		case ".mp3":
			return "audio/mpeg", true
		case ".m4a", ".mp4":
			return "audio/mp4", true
		case ".wav":
			return "audio/wav", true
		case ".flac":
			return "audio/flac", true
		case ".oga", ".ogg", ".opus":
			return "audio/ogg", true
		case ".webm":
			return "audio/webm", true
		}
		return "", false
	}
	switch extension {
	case ".mp4", ".m4v":
		return "video/mp4", true
	case ".webm":
		return "video/webm", true
	}
	return "", false
}

func effectiveMediaKind(kind string, mediaPath string) string {
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind == "audio" || kind == "video" {
		return kind
	}
	inferred := mediaKindFromPath(mediaPath)
	if inferred == "audio" || inferred == "video" {
		return inferred
	}
	return kind
}

func (s *Server) serveAutomaticLocalPlayback(w http.ResponseWriter, r *http.Request, target mediaStreamTarget, path string) {
	info, statErr := os.Stat(path)
	if statErr != nil || !info.Mode().IsRegular() {
		writeAPIError(w, http.StatusNotFound, "media_not_found", "media file was not found", false)
		return
	}
	profile, err := s.playbackProfile(r, target.Kind)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	capabilities := playbackCapabilities(r)
	forceTranscode := forcePlaybackTranscode(r)
	if !forceTranscode {
		probe, probeErr := s.probePlaybackFile(r.Context(), path)
		if errors.Is(probeErr, errRealtimeResourceBusy) {
			w.Header().Set("Retry-After", "1")
			writeAPIError(w, http.StatusServiceUnavailable, "media_probe_busy", "media playback inspection is temporarily busy", true)
			return
		}
		if probeErr == nil {
			if contentType, direct := directPlaybackContentType(probe, profile, capabilities); direct {
				s.serveDirectPlaybackFile(w, r, path, contentType)
				return
			}
		}
		if probeErr != nil && len(capabilities) == 0 {
			// A small number of legacy/demo files are not probeable despite having a
			// browser-native extension. Keep those streams usable; valid media always
			// takes the probe decision above, and unknown extensions still transcode.
			if contentType, direct := fallbackDirectPlaybackContentType(path, profile); direct {
				slog.Warn("media probe failed; using extension fallback", "path", path, "profile", profile, "error", probeErr)
				s.serveDirectPlaybackFile(w, r, path, contentType)
				return
			}
		}
	}
	if r.Method == http.MethodHead {
		s.setRealtimePlaybackHeaders(w, realtimeContentType(profile))
		w.WriteHeader(http.StatusOK)
		return
	}
	if err := s.streamFFmpegFile(w, r, path, profile); err != nil {
		slog.Warn("realtime media transcode failed", "path", path, "profile", profile, "error", err)
	}
}

func (s *Server) serveDirectPlaybackFile(w http.ResponseWriter, r *http.Request, path string, contentType string) {
	file, err := os.Open(path)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "media_not_found", "media file was not found", false)
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeAPIError(w, http.StatusNotFound, "media_not_found", "media file was not found", false)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), file)
}

func realtimeContentType(profile string) string {
	if profile == playbackProfileAudio {
		return "audio/mpeg"
	}
	return "video/mp4"
}

func (s *Server) setRealtimePlaybackHeaders(w http.ResponseWriter, contentType string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Accept-Ranges", "none")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func stopRealtimeCommand(cancel context.CancelFunc, command *exec.Cmd, stdout io.ReadCloser) error {
	cancel()
	if stdout != nil {
		_ = stdout.Close()
	}
	return command.Wait()
}

func realtimeFFmpegArgs(profile string, input string) []string {
	args := []string{
		"-nostdin",
		"-hide_banner",
		"-loglevel", "error",
		"-threads", "2",
		"-filter_threads", "1",
		"-filter_complex_threads", "1",
		"-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe",
		"-i", input,
		"-map_metadata", "-1",
		"-sn",
		"-dn",
	}
	if profile == playbackProfileAudio {
		return append(args,
			"-map", "0:a:0",
			"-vn",
			"-c:a", "libmp3lame",
			"-threads:a", "1",
			"-q:a", "4",
			"-f", "mp3",
			"pipe:1",
		)
	}
	return append(args,
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-c:v", "libx264",
		"-threads:v", "2",
		"-preset", "veryfast",
		"-tune", "zerolatency",
		"-crf", "23",
		"-vf", "pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2:x=0:y=0",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
		"-threads:a", "1",
		"-b:a", "160k",
		"-movflags", "frag_keyframe+empty_moov+default_base_moof",
		"-f", "mp4",
		"pipe:1",
	)
}

func (s *Server) streamFFmpegFile(w http.ResponseWriter, r *http.Request, path string, profile string) error {
	contextWithTimeout, cancel := context.WithTimeout(r.Context(), realtimeTranscodeTimeout)
	defer cancel()
	release, err := s.acquireRealtimeTranscode(contextWithTimeout)
	if err != nil {
		w.Header().Set("Retry-After", "1")
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_busy", "media playback is temporarily busy", true)
		return err
	}
	return s.streamFFmpegFileWithLease(w, r, path, profile, contextWithTimeout, release)
}

func (s *Server) streamFFmpegFileWithLease(w http.ResponseWriter, r *http.Request, path string, profile string, contextWithTimeout context.Context, release func()) error {
	defer release()
	commandContext, cancel := context.WithCancel(contextWithTimeout)
	defer cancel()
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "media playback preparation is unavailable", true)
		return err
	}
	command := exec.CommandContext(commandContext, ffmpegPath, realtimeFFmpegArgs(profile, path)...)
	command.Stderr = io.Discard
	stdout, err := command.StdoutPipe()
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "media playback preparation is unavailable", true)
		return err
	}
	if err := command.Start(); err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "media playback preparation is unavailable", true)
		return err
	}
	initial, initialErr := readTranscodeStart(commandContext, stdout)
	if len(initial) == 0 && initialErr != nil {
		_ = stopRealtimeCommand(cancel, command, stdout)
		return writeTranscodeFailure(w, initialErr)
	}
	s.setRealtimePlaybackHeaders(w, realtimeContentType(profile))
	w.WriteHeader(http.StatusOK)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	if len(initial) > 0 {
		if _, err := w.Write(initial); err != nil {
			_ = stopRealtimeCommand(cancel, command, stdout)
			return err
		}
	}
	_, copyErr := io.Copy(w, stdout)
	if copyErr != nil {
		cancel()
		_ = stdout.Close()
	}
	waitErr := command.Wait()
	if copyErr != nil && !errors.Is(copyErr, context.Canceled) && !errors.Is(copyErr, context.DeadlineExceeded) {
		return copyErr
	}
	if waitErr != nil {
		if errors.Is(contextWithTimeout.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("media transcoding timed out")
		}
		return waitErr
	}
	return nil
}

func remotePlaybackURLAllowed(value string, source remoteSourceForUse) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return nil, fmt.Errorf("remote media URL is not allowed")
	}
	if !remotePreviewURLAllowed(parsed, source) {
		return nil, fmt.Errorf("remote media URL is not allowed")
	}
	return parsed, nil
}

var errRemotePlaybackSourceUnavailable = errors.New("remote playback source is unavailable")

func remotePlaybackSourceUsable(source remoteSourceForUse) bool {
	return source.ID > 0 && source.Enabled && isKikoeruSourceType(source.SourceType) && strings.TrimSpace(source.Endpoint.APIURL) != ""
}

func (s *Server) loadRemotePlaybackSource(ctx context.Context, sourceID int64) (remoteSourceForUse, error) {
	if sourceID <= 0 || s.db == nil {
		return remoteSourceForUse{}, errRemotePlaybackSourceUnavailable
	}
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, errRemotePlaybackSourceUnavailable
		}
		return remoteSourceForUse{}, err
	}
	if !remotePlaybackSourceUsable(source) {
		return remoteSourceForUse{}, errRemotePlaybackSourceUnavailable
	}
	return source, nil
}

func writeRemotePlaybackSourceError(w http.ResponseWriter, err error) bool {
	if errors.Is(err, errRemotePlaybackSourceUnavailable) || errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "remote media source is not available"})
		return true
	}
	return false
}

func (s *Server) openRemotePlaybackResponse(ctx context.Context, r *http.Request, source remoteSourceForUse, parsed *url.URL) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, r.Method, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	request.Header.Set("Accept-Encoding", "identity")
	for _, header := range []string{"Range", "If-Range", "If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"} {
		if value := strings.TrimSpace(r.Header.Get(header)); value != "" {
			request.Header.Set(header, value)
		}
	}
	if source.Config.RequestLanguage != "" {
		request.Header.Set("Accept-Language", source.Config.RequestLanguage)
	}
	return s.sourceHTTPClient(source, 0).Do(request)
}

func remotePlaybackContentType(response *http.Response, path string) string {
	contentType := strings.TrimSpace(response.Header.Get("Content-Type"))
	if strings.HasPrefix(strings.ToLower(contentType), "audio/") || strings.HasPrefix(strings.ToLower(contentType), "video/") {
		return contentType
	}
	extension := strings.ToLower(filepath.Ext(path))
	switch extension {
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".flac":
		return "audio/flac"
	case ".wav":
		return "audio/wav"
	case ".wma":
		return "audio/x-ms-wma"
	case ".oga", ".ogg", ".opus":
		return "audio/ogg"
	case ".aac":
		return "audio/aac"
	case ".mp4", ".m4v", ".ism", ".ismv":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mkv":
		return "video/x-matroska"
	case ".mov":
		return "video/quicktime"
	case ".avi", ".divx", ".xvid":
		return "video/x-msvideo"
	case ".wmv":
		return "video/x-ms-wmv"
	case ".flv", ".f4v":
		return "video/x-flv"
	case ".mpeg", ".mpg", ".mpe", ".m2v", ".vob":
		return "video/mpeg"
	case ".m2ts", ".mts", ".ts":
		return "video/mp2t"
	case ".3gp":
		return "video/3gpp"
	case ".3g2":
		return "video/3gpp2"
	case ".ogv", ".ogm":
		return "video/ogg"
	case ".asf":
		return "video/x-ms-asf"
	case ".mjpeg", ".mjpg":
		return "video/x-motion-jpeg"
	case ".y4m":
		return "video/x-yuv4mpeg"
	}
	if guessed := mime.TypeByExtension(extension); strings.HasPrefix(strings.ToLower(guessed), "audio/") || strings.HasPrefix(strings.ToLower(guessed), "video/") {
		return guessed
	}
	return ""
}

func copyRemotePlaybackHeaders(w http.ResponseWriter, response *http.Response, contentType string, maxBytes int64) {
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	for _, header := range []string{"Content-Range", "Accept-Ranges", "ETag", "Last-Modified"} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	if response.ContentLength >= 0 && (maxBytes <= 0 || response.ContentLength <= maxBytes) {
		w.Header().Set("Content-Length", strconv.FormatInt(response.ContentLength, 10))
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func (s *Server) serveRemotePlaybackResponse(w http.ResponseWriter, r *http.Request, response *http.Response, path string, maxBytes int64) error {
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotModified || response.StatusCode == http.StatusRequestedRangeNotSatisfiable {
		copyRemotePlaybackHeaders(w, response, "", maxBytes)
		w.WriteHeader(response.StatusCode)
		return nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeAPIError(w, http.StatusBadGateway, "remote_media_unavailable", "remote media source could not be read", true)
		return fmt.Errorf("remote media returned status %d", response.StatusCode)
	}
	if response.ContentLength > maxBytes && maxBytes > 0 {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "remote_media_too_large", "remote media is too large to play", false)
		return fmt.Errorf("remote media exceeds stream limit")
	}
	contentType := remotePlaybackContentType(response, path)
	if contentType == "" {
		writeAPIError(w, http.StatusBadGateway, "remote_media_type_unknown", "remote media type could not be determined", true)
		return fmt.Errorf("remote media content type is not supported")
	}
	copyRemotePlaybackHeaders(w, response, contentType, maxBytes)
	w.WriteHeader(response.StatusCode)
	if r.Method == http.MethodHead {
		return nil
	}
	if maxBytes <= 0 {
		_, err := io.Copy(w, response.Body)
		return err
	}
	limited := &io.LimitedReader{R: response.Body, N: maxBytes}
	if _, err := io.Copy(w, limited); err != nil {
		return err
	}
	if limited.N > 0 {
		return nil
	}
	var extra [1]byte
	read, err := io.ReadFull(response.Body, extra[:])
	if read > 0 {
		return fmt.Errorf("remote media exceeded stream limit")
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return nil
	}
	return err
}

func (s *Server) streamRemoteURL(w http.ResponseWriter, r *http.Request, source remoteSourceForUse, remoteURL string, path string, kind string) {
	_, err := s.playbackProfile(r, kind)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !remotePlaybackSourceUsable(source) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "remote media source is not available"})
		return
	}
	parsed, err := remotePlaybackURLAllowed(remoteURL, source)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "remote_media_blocked", "remote media source is not allowed", true)
		return
	}
	method := r.Method
	if method != http.MethodGet && method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	contextWithTimeout, cancel := context.WithTimeout(r.Context(), remotePlaybackTimeout)
	defer cancel()
	response, err := s.openRemotePlaybackResponse(contextWithTimeout, r, source, parsed)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	maxBytes := s.remoteMediaDownloadLimitBytes(r.Context())
	if response.ContentLength > maxBytes && maxBytes > 0 {
		_ = response.Body.Close()
		writeAPIError(w, http.StatusRequestEntityTooLarge, "remote_media_too_large", "remote media is too large to play", false)
		return
	}
	if err := s.serveRemotePlaybackResponse(w, r, response, path, maxBytes); err != nil {
		slog.Warn("remote media proxy failed", "path", path, "error", err)
	}
}

func (s *Server) streamRemoteSourceMedia(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
	path := cleanRemoteRelativePath(r.URL.Query().Get("path"))
	if code == "" || path == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code and media path are required"})
		return
	}
	source, err := s.loadRemotePlaybackSource(r.Context(), id)
	if err != nil {
		if writeRemotePlaybackSourceError(w, err) {
			return
		}
		writeUpstreamError(w, err)
		return
	}
	_, _, tracks, err := s.loadRemoteWorkTracksCached(r.Context(), id, code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeUpstreamError(w, err)
		return
	}
	remoteURL, kind, ok := remoteMediaTrackURL(tracks, path, "")
	if !ok || (kind != "audio" && kind != "video") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "remote media file was not found"})
		return
	}
	// In Demo mode, loadRemoteWorkTracksCached resolves the exact work through
	// the remote source's filtered search contract. Remote-only previews have no
	// local work row, so the local demoWorkCodeEligible check does not apply.
	s.streamRemoteURL(w, r, source, remoteURL, path, kind)
}

func remoteMediaTrackURL(nodes []kikoeru.Track, targetPath string, basePath string) (string, string, bool) {
	for _, node := range nodes {
		title := strings.TrimSpace(node.Title)
		if title == "" {
			continue
		}
		path := cleanRemoteRelativePath(joinRemotePath(basePath, title))
		kind := remoteTrackKindForPath(node.Type, path)
		if len(node.Children) > 0 || kind == "folder" {
			if value, childKind, ok := remoteMediaTrackURL(node.Children, targetPath, path); ok {
				return value, childKind, true
			}
			continue
		}
		if path != targetPath {
			continue
		}
		remoteURL := firstNonEmpty(node.MediaStreamURL, node.StreamLowQualityURL, node.MediaDownloadURL)
		if remoteURL == "" {
			return "", "", false
		}
		return remoteURL, kind, true
	}
	return "", "", false
}
