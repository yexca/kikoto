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
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

const (
	realtimeProbeTimeout       = 5 * time.Second
	realtimeTranscodeStartup   = 15 * time.Second
	realtimeTranscodeTimeout   = 2 * time.Hour
	realtimeInputShutdown      = 5 * time.Second
	realtimeProbeOutputLimit   = 128 << 10
	realtimeTranscodeSlotsSize = 2
)

const (
	playbackProfileAudio = "audio"
	playbackProfileVideo = "video"
)

const (
	capAudioMP3            = "audio-mp3"
	capAudioMP4AAC         = "audio-mp4-aac"
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
}

type playbackProbeStream struct {
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	Profile   string `json:"profile"`
	PixelFmt  string `json:"pix_fmt"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
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

func (s *Server) probePlaybackFile(ctx context.Context, path string) (playbackProbe, error) {
	probeContext, cancel := context.WithTimeout(ctx, realtimeProbeTimeout)
	defer cancel()
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		return playbackProbe{}, fmt.Errorf("ffprobe is unavailable")
	}
	command := exec.CommandContext(
		probeContext,
		ffprobePath,
		"-v", "error",
		"-show_entries", "format=format_name:stream=codec_type,codec_name,profile,pix_fmt,width,height",
		"-of", "json",
		path,
	)
	command.Stderr = io.Discard
	output := &limitedCommandOutput{limit: realtimeProbeOutputLimit}
	command.Stdout = output
	if err := command.Run(); err != nil {
		if output.exceeded {
			return playbackProbe{}, fmt.Errorf("ffprobe output exceeded limit")
		}
		if errors.Is(probeContext.Err(), context.DeadlineExceeded) {
			return playbackProbe{}, fmt.Errorf("media probe timed out")
		}
		return playbackProbe{}, fmt.Errorf("media probe failed")
	}
	var result playbackProbe
	if err := json.Unmarshal(output.buffer.Bytes(), &result); err != nil {
		return playbackProbe{}, fmt.Errorf("media probe returned invalid output")
	}
	return result, nil
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
		case "opus":
			if playbackFormatIncludes(probe, "webm") && capabilities[capAudioWebMOpus] {
				return "audio/webm", true
			}
		case "vorbis":
			if playbackFormatIncludes(probe, "webm") && capabilities[capAudioWebMVorbis] {
				return "audio/webm", true
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

func closeRealtimeReader(reader io.Reader) {
	if closer, ok := reader.(io.Closer); ok {
		_ = closer.Close()
	}
}

func (s *Server) acquireRealtimeTranscode(ctx context.Context) (func(), error) {
	s.realtimeTranscodeMu.Lock()
	if s.realtimeTranscodeSlots == nil {
		s.realtimeTranscodeSlots = make(chan struct{}, realtimeTranscodeSlotsSize)
	}
	slots := s.realtimeTranscodeSlots
	s.realtimeTranscodeMu.Unlock()
	select {
	case slots <- struct{}{}:
		return func() { <-slots }, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func realtimeFFmpegArgs(profile string, input string) []string {
	args := []string{
		"-nostdin",
		"-hide_banner",
		"-loglevel", "error",
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
			"-q:a", "4",
			"-f", "mp3",
			"pipe:1",
		)
	}
	return append(args,
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-c:v", "libx264",
		"-preset", "veryfast",
		"-tune", "zerolatency",
		"-crf", "23",
		"-pix_fmt", "yuv420p",
		"-c:a", "aac",
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
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_busy", "media playback is temporarily busy", true)
		return err
	}
	defer release()
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "media playback preparation is unavailable", true)
		return err
	}
	command := exec.CommandContext(contextWithTimeout, ffmpegPath, realtimeFFmpegArgs(profile, path)...)
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
	initial, initialErr := readTranscodeStart(contextWithTimeout, stdout)
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

func (s *Server) streamFFmpegReader(w http.ResponseWriter, r *http.Request, reader io.Reader, profile string, maxBytes int64) error {
	contextWithTimeout, cancel := context.WithTimeout(r.Context(), realtimeTranscodeTimeout)
	defer cancel()
	release, err := s.acquireRealtimeTranscode(contextWithTimeout)
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_busy", "media playback is temporarily busy", true)
		return err
	}
	defer release()
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "media playback preparation is unavailable", true)
		return err
	}
	command := exec.CommandContext(contextWithTimeout, ffmpegPath, realtimeFFmpegArgs(profile, "pipe:0")...)
	command.Stderr = io.Discard
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "media playback preparation is unavailable", true)
		return err
	}
	inputErr := make(chan error, 1)
	go func() {
		<-contextWithTimeout.Done()
		closeRealtimeReader(reader)
		_ = stdin.Close()
	}()
	go func() {
		const maxInt64 = int64(^uint64(0) >> 1)
		limited := reader
		if maxBytes > 0 && maxBytes < maxInt64 {
			limited = io.LimitReader(reader, maxBytes+1)
		}
		written, copyErr := io.Copy(stdin, limited)
		closeErr := stdin.Close()
		if copyErr == nil && closeErr != nil {
			copyErr = closeErr
		}
		if copyErr == nil && maxBytes > 0 && written > maxBytes {
			copyErr = fmt.Errorf("remote media exceeds stream limit")
		}
		inputErr <- copyErr
		if copyErr != nil {
			cancel()
		}
	}()
	initial, initialErr := readTranscodeStart(contextWithTimeout, stdout)
	if len(initial) == 0 && initialErr != nil {
		cancel()
		closeRealtimeReader(reader)
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
			cancel()
			closeRealtimeReader(reader)
			_ = stopRealtimeCommand(cancel, command, stdout)
			return err
		}
	}
	_, copyErr := io.Copy(w, stdout)
	if copyErr != nil {
		cancel()
		_ = stdout.Close()
		closeRealtimeReader(reader)
	} else {
		// FFmpeg can finish after consuming only the useful part of an
		// upstream response. Close the body so the feeder goroutine cannot
		// keep the transcode slot occupied waiting for trailing bytes.
		closeRealtimeReader(reader)
	}
	waitErr := command.Wait()
	cancel()
	var remoteCopyErr error
	shutdownTimer := time.NewTimer(realtimeInputShutdown)
	select {
	case remoteCopyErr = <-inputErr:
	case <-contextWithTimeout.Done():
		remoteCopyErr = contextWithTimeout.Err()
	case <-shutdownTimer.C:
		remoteCopyErr = nil
	}
	if !shutdownTimer.Stop() {
		select {
		case <-shutdownTimer.C:
		default:
		}
	}
	if copyErr != nil && !errors.Is(copyErr, context.Canceled) && !errors.Is(copyErr, context.DeadlineExceeded) {
		return copyErr
	}
	if remoteCopyErr != nil {
		return remoteCopyErr
	}
	if waitErr != nil {
		if errors.Is(contextWithTimeout.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("remote media transcoding timed out")
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

func (s *Server) streamRemoteURL(w http.ResponseWriter, r *http.Request, source remoteSourceForUse, remoteURL string, path string, kind string) {
	profile, err := s.playbackProfile(r, kind)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	parsed, err := remotePlaybackURLAllowed(remoteURL, source)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "remote_media_blocked", "remote media source is not allowed", true)
		return
	}
	contextWithTimeout, cancel := context.WithTimeout(r.Context(), realtimeTranscodeTimeout)
	defer cancel()
	method := r.Method
	if method != http.MethodGet && method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	request, err := http.NewRequestWithContext(contextWithTimeout, method, parsed.String(), nil)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "remote_media_unavailable", "remote media request could not be created", true)
		return
	}
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	if source.Config.RequestLanguage != "" {
		request.Header.Set("Accept-Language", source.Config.RequestLanguage)
	}
	response, err := s.sourceHTTPClient(source, 0).Do(request)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeAPIError(w, http.StatusBadGateway, "remote_media_unavailable", "remote media source could not be read", true)
		return
	}
	maxBytes := s.remoteMediaDownloadLimitBytes(r.Context())
	if response.ContentLength > maxBytes && maxBytes > 0 {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "remote_media_too_large", "remote media is too large to play", false)
		return
	}
	if method == http.MethodHead {
		s.setRealtimePlaybackHeaders(w, realtimeContentType(profile))
		w.WriteHeader(http.StatusOK)
		return
	}
	if err := s.streamFFmpegReader(w, r, response.Body, profile, maxBytes); err != nil {
		slog.Warn("realtime remote media transcode failed", "path", path, "profile", profile, "error", err)
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
	source, _, tracks, err := s.loadRemoteWorkTracksCached(r.Context(), id, code)
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
	if s.cfg.IsDemo() {
		eligible, eligibleErr := s.demoWorkCodeEligible(r.Context(), code)
		if eligibleErr != nil || !eligible {
			writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
			return
		}
	}
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
