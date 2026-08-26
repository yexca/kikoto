package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	hlsProfileVersion                = "hls-v1-720p"
	hlsSegmentDurationSeconds        = 6.0
	hlsMaximumDurationSeconds        = 24 * 60 * 60
	hlsSegmentMaximumBytes     int64 = 16 << 20
	hlsSegmentTranscodeTimeout       = 2 * time.Minute
)

var (
	hlsSegmentPattern           = regexp.MustCompile(`^segment-([0-9]{6})\.ts$`)
	errHLSMediaNotFound         = errors.New("HLS media was not found")
	errHLSMediaUnsupported      = errors.New("HLS media is not supported")
	errHLSPlaybackSourceChanged = errors.New("HLS playback source changed")
	errHLSTranscodeUnavailable  = errors.New("HLS transcoding is unavailable")
)

type videoPlaybackInfoResponse struct {
	Delivery        string  `json:"delivery"`
	URL             string  `json:"url"`
	DurationSeconds float64 `json:"durationSeconds"`
	Seekable        bool    `json:"seekable"`
}

type hlsPlaybackSource struct {
	LocationID int64
	Path       string
	Revision   string
	Duration   float64
	Probe      playbackProbe
}

func (s *Server) getVideoPlaybackInfo(w http.ResponseWriter, r *http.Request) {
	locationID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	source, err := s.loadHLSPlaybackSource(r.Context(), locationID)
	if err != nil {
		s.writeHLSPlaybackError(w, err)
		return
	}
	if !forcePlaybackTranscode(r) {
		capabilities := playbackCapabilities(r)
		if _, direct := directPlaybackContentType(source.Probe, playbackProfileVideo, capabilities); direct {
			query := url.Values{"profile": []string{playbackProfileVideo}}
			if values := sortedPlaybackCapabilities(capabilities); len(values) > 0 {
				query.Set("capabilities", strings.Join(values, ","))
			}
			writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
				Delivery: "direct", URL: fmt.Sprintf("/api/media/%d/stream?%s", locationID, query.Encode()),
				DurationSeconds: source.Duration, Seekable: true,
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
		Delivery:        "hls",
		URL:             fmt.Sprintf("/api/media/%d/hls/index.m3u8?v=%s", locationID, source.Revision),
		DurationSeconds: source.Duration,
		Seekable:        true,
	})
}

func sortedPlaybackCapabilities(capabilities map[string]bool) []string {
	values := make([]string, 0, len(capabilities))
	for capability, enabled := range capabilities {
		if enabled {
			values = append(values, capability)
		}
	}
	sort.Strings(values)
	return values
}

func (s *Server) serveVideoHLS(w http.ResponseWriter, r *http.Request) {
	file := strings.TrimSpace(r.PathValue("file"))
	segmentMatch := hlsSegmentPattern.FindStringSubmatch(file)
	if file != "index.m3u8" && segmentMatch == nil {
		writeAPIError(w, http.StatusNotFound, "hls_resource_not_found", "playback resource was not found", false)
		return
	}
	locationID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	source, err := s.loadHLSPlaybackSource(r.Context(), locationID)
	if err != nil {
		s.writeHLSPlaybackError(w, err)
		return
	}
	if revision := strings.TrimSpace(r.URL.Query().Get("v")); revision != "" && revision != source.Revision {
		s.writeHLSPlaybackError(w, errHLSPlaybackSourceChanged)
		return
	}
	if file == "index.m3u8" {
		playlist := buildHLSPlaylist(source.Duration, source.Revision)
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write([]byte(playlist))
		return
	}
	segmentIndex, err := strconv.Atoi(segmentMatch[1])
	if err != nil || segmentIndex < 0 || segmentIndex >= hlsSegmentCount(source.Duration) {
		writeAPIError(w, http.StatusNotFound, "hls_segment_not_found", "playback segment was not found", false)
		return
	}
	if err := s.serveHLSSegment(w, r, source, segmentIndex); err != nil {
		if errors.Is(err, errRealtimeResourceBusy) {
			w.Header().Set("Retry-After", "1")
			writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_busy", "media playback is temporarily busy", true)
			return
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return
		}
		if errors.Is(err, errHLSTranscodeUnavailable) {
			writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "video playback preparation failed", true)
			return
		}
		writeAPIError(w, http.StatusInsufficientStorage, "transcode_cache_unavailable", "video playback cache is unavailable", true)
	}
}

func (s *Server) writeHLSPlaybackError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errHLSMediaNotFound):
		writeAPIError(w, http.StatusNotFound, "media_not_found", "media file was not found", false)
	case errors.Is(err, errHLSMediaUnsupported):
		writeAPIError(w, http.StatusUnprocessableEntity, "media_hls_unsupported", "video cannot be prepared for seekable playback", false)
	case errors.Is(err, errHLSPlaybackSourceChanged):
		writeAPIError(w, http.StatusConflict, "playback_source_changed", "video source changed; reload playback", true)
	case errors.Is(err, errRealtimeResourceBusy):
		w.Header().Set("Retry-After", "1")
		writeAPIError(w, http.StatusServiceUnavailable, "media_probe_busy", "media playback inspection is temporarily busy", true)
	default:
		writeAPIError(w, http.StatusServiceUnavailable, "media_playback_unavailable", "video playback preparation is unavailable", true)
	}
}

func (s *Server) loadHLSPlaybackSource(ctx context.Context, locationID int64) (hlsPlaybackSource, error) {
	target, _, err := s.loadMediaStreamTarget(ctx, locationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return hlsPlaybackSource{}, errHLSMediaNotFound
		}
		return hlsPlaybackSource{}, err
	}
	if (target.LocationType != "local" && target.LocationType != "cache") || target.Availability != "available" || effectiveMediaKind(target.Kind, target.RelativePath) != "video" {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	root := s.cfg.DataRoot
	if target.LocationType == "cache" {
		root = s.cfg.CacheRoot
	}
	mediaPath, err := safeDataPath(root, target.RelativePath)
	if err != nil {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	info, err := os.Stat(mediaPath)
	if err != nil || !info.Mode().IsRegular() {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	probe, err := s.probePlaybackFile(ctx, mediaPath)
	if err != nil {
		return hlsPlaybackSource{}, err
	}
	if firstPlaybackStream(probe, "video") == nil {
		return hlsPlaybackSource{}, errHLSMediaUnsupported
	}
	duration := playbackDurationSeconds(target, probe)
	if duration <= 0 || duration > hlsMaximumDurationSeconds || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return hlsPlaybackSource{}, errHLSMediaUnsupported
	}
	revisionInput := fmt.Sprintf("%s\x00%d\x00%s\x00%d\x00%d", hlsProfileVersion, locationID, filepath.ToSlash(target.RelativePath), info.Size(), info.ModTime().UnixNano())
	revision := sha256.Sum256([]byte(revisionInput))
	return hlsPlaybackSource{
		LocationID: locationID,
		Path:       mediaPath,
		Revision:   fmt.Sprintf("%x", revision[:12]),
		Duration:   duration,
		Probe:      probe,
	}, nil
}

func playbackDurationSeconds(target mediaStreamTarget, probe playbackProbe) float64 {
	if value, err := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64); err == nil && value > 0 {
		return value
	}
	if target.Duration.Valid && target.Duration.Int64 > 0 {
		return float64(target.Duration.Int64)
	}
	return 0
}

func hlsSegmentCount(duration float64) int {
	return int(math.Ceil(duration / hlsSegmentDurationSeconds))
}

func hlsSegmentWindow(duration float64, index int) (float64, float64) {
	start := float64(index) * hlsSegmentDurationSeconds
	return start, math.Min(hlsSegmentDurationSeconds, math.Max(0, duration-start))
}

func buildHLSPlaylist(duration float64, revision string) string {
	var playlist strings.Builder
	playlist.WriteString("#EXTM3U\n")
	playlist.WriteString("#EXT-X-VERSION:3\n")
	playlist.WriteString("#EXT-X-TARGETDURATION:6\n")
	playlist.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n")
	playlist.WriteString("#EXT-X-PLAYLIST-TYPE:VOD\n")
	playlist.WriteString("#EXT-X-INDEPENDENT-SEGMENTS\n")
	for index := 0; index < hlsSegmentCount(duration); index++ {
		_, segmentDuration := hlsSegmentWindow(duration, index)
		fmt.Fprintf(&playlist, "#EXTINF:%.3f,\nsegment-%06d.ts?v=%s\n", segmentDuration, index, revision)
	}
	playlist.WriteString("#EXT-X-ENDLIST\n")
	return playlist.String()
}

func (s *Server) serveHLSSegment(w http.ResponseWriter, r *http.Request, source hlsPlaybackSource, index int) error {
	relPath := path.Join(
		transcodeCacheRootRelative,
		"hls",
		strconv.FormatInt(source.LocationID, 10),
		source.Revision,
		fmt.Sprintf("segment-%06d.ts", index),
	)
	absolutePath, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return err
	}
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()

	// A cached segment only needs its path lock. New segments reserve quota
	// before taking that lock so LRU eviction never waits on a path held by a
	// request that is itself waiting for the quota lock.
	releasePath, err := s.acquireCachePathLock(r.Context(), relPath)
	if err != nil {
		return err
	}
	if validCachedHLSSegment(absolutePath) {
		defer releasePath()
		return serveCachedHLSSegment(w, r, absolutePath)
	}
	releasePath()

	releaseReservation, err := s.reserveTranscodeCache(r.Context(), hlsSegmentMaximumBytes)
	if err != nil {
		return err
	}
	defer releaseReservation()
	releasePath, err = s.acquireCachePathLock(r.Context(), relPath)
	if err != nil {
		return err
	}
	defer releasePath()
	if !validCachedHLSSegment(absolutePath) {
		_, _, _ = s.removeCacheFileUnlocked(relPath)
		start, duration := hlsSegmentWindow(source.Duration, index)
		if duration <= 0 {
			return errHLSMediaUnsupported
		}
		if err := os.MkdirAll(filepath.Dir(absolutePath), 0o755); err != nil {
			return err
		}
		if err := s.generateHLSSegment(r.Context(), source.Path, absolutePath, start, duration); err != nil {
			return err
		}
	}
	return serveCachedHLSSegment(w, r, absolutePath)
}

func serveCachedHLSSegment(w http.ResponseWriter, r *http.Request, absolutePath string) error {
	file, err := os.Open(absolutePath)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("cached HLS segment is unavailable")
	}
	if time.Since(info.ModTime()) > 5*time.Minute {
		now := time.Now()
		if err := os.Chtimes(absolutePath, now, now); err == nil {
			info, _ = file.Stat()
		}
	}
	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, filepath.Base(absolutePath), info.ModTime(), file)
	return nil
}

func validCachedHLSSegment(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0 && info.Size() <= hlsSegmentMaximumBytes
}

func (s *Server) generateHLSSegment(ctx context.Context, inputPath string, outputPath string, start float64, duration float64) error {
	transcodeContext, cancel := context.WithTimeout(ctx, hlsSegmentTranscodeTimeout)
	defer cancel()
	release, err := s.acquireRealtimeTranscode(transcodeContext)
	if err != nil {
		return err
	}
	defer release()
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		return fmt.Errorf("%w: ffmpeg executable was not found", errHLSTranscodeUnavailable)
	}
	temporary, err := os.CreateTemp(filepath.Dir(outputPath), ".hls-segment-*.part")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	command := exec.CommandContext(transcodeContext, ffmpegPath, hlsSegmentFFmpegArgs(inputPath, start, duration)...)
	command.Stderr = io.Discard
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("%w: command failed to start", errHLSTranscodeUnavailable)
	}
	written, copyErr := io.Copy(temporary, io.LimitReader(stdout, hlsSegmentMaximumBytes+1))
	if written > hlsSegmentMaximumBytes {
		cancel()
		_ = stdout.Close()
		_ = command.Wait()
		return fmt.Errorf("%w: segment exceeded its byte limit", errHLSTranscodeUnavailable)
	}
	waitErr := command.Wait()
	if copyErr != nil {
		return copyErr
	}
	if waitErr != nil {
		if err := transcodeContext.Err(); err != nil {
			if parentErr := ctx.Err(); parentErr != nil {
				return parentErr
			}
			return fmt.Errorf("%w: command timed out", errHLSTranscodeUnavailable)
		}
		return fmt.Errorf("%w: command failed", errHLSTranscodeUnavailable)
	}
	if written == 0 {
		return fmt.Errorf("%w: command produced no output", errHLSTranscodeUnavailable)
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, outputPath); err != nil {
		return err
	}
	return nil
}

func hlsSegmentFFmpegArgs(input string, start float64, duration float64) []string {
	return []string{
		"-nostdin",
		"-hide_banner",
		"-loglevel", "error",
		"-threads", "2",
		"-filter_threads", "1",
		"-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe",
		"-ss", strconv.FormatFloat(start, 'f', 3, 64),
		"-i", input,
		"-t", strconv.FormatFloat(duration, 'f', 3, 64),
		"-map", "0:v:0",
		"-map", "0:a:0?",
		"-map_metadata", "-1",
		"-sn",
		"-dn",
		"-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2:x=0:y=0",
		"-c:v", "libx264",
		"-threads:v", "2",
		"-preset", "veryfast",
		"-tune", "zerolatency",
		"-crf", "24",
		"-maxrate", "2800k",
		"-bufsize", "5600k",
		"-pix_fmt", "yuv420p",
		"-g", "60",
		"-keyint_min", "30",
		"-sc_threshold", "0",
		"-force_key_frames", "expr:gte(t,n_forced*2)",
		"-c:a", "aac",
		"-threads:a", "1",
		"-b:a", "128k",
		"-ac", "2",
		"-ar", "48000",
		"-output_ts_offset", strconv.FormatFloat(start, 'f', 3, 64),
		"-mpegts_flags", "+resend_headers+initial_discontinuity",
		"-muxdelay", "0",
		"-muxpreload", "0",
		"-f", "mpegts",
		"pipe:1",
	}
}
