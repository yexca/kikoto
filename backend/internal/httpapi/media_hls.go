package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	hlsProfileVersion               = "hls-v2-720p"
	videoHLSSessionPlaylist         = ".video-hls-session.m3u8"
	hlsSegmentDurationSeconds       = 6.0
	hlsMaximumDurationSeconds       = 24 * 60 * 60
	hlsSegmentMaximumBytes    int64 = 16 << 20
	// Video segment timestamps start here instead of at zero.
	videoHLSTimelineOffsetSeconds = 10.0
)

var (
	hlsSegmentPattern           = regexp.MustCompile(`^segment-([0-9]{6})\.ts$`)
	errHLSMediaNotFound         = errors.New("HLS media was not found")
	errHLSMediaUnsupported      = errors.New("HLS media is not supported")
	errHLSPlaybackSourceChanged = errors.New("HLS playback source changed")
	errHLSTranscodeUnavailable  = errors.New("HLS transcoding is unavailable")
)

type videoPlaybackInfoResponse struct {
	Delivery string `json:"delivery"`
	// Conversion says how the server prepares the stream: "none", "remux", or
	// "transcode". Playback needs only Delivery.
	Conversion      string  `json:"conversion"`
	URL             string  `json:"url"`
	DurationSeconds float64 `json:"durationSeconds"`
	Seekable        bool    `json:"seekable"`
}

type hlsPlaybackSource struct {
	LocationID int64
	Path       string
	// Profile is playbackProfileVideo or playbackProfileAudio, the media kind
	// unless the audio player requested the audio of a video.
	Profile string
	// Encode produces the segments of Profile from this media kind.
	Encode   *hlsEncodeProfile
	Revision string
	Duration float64
	Probe    playbackProbe
	// Keyframes places the segments of remuxed video; other playlists follow
	// the six-second grid.
	Keyframes *videoKeyframeIndex
}

func (source hlsPlaybackSource) segmentCount() int {
	if source.Keyframes != nil {
		return len(source.Keyframes.cuts)
	}
	return hlsSegmentCount(source.Duration)
}

func (s *Server) getVideoPlaybackInfo(w http.ResponseWriter, r *http.Request) {
	locationID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
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
	// A client asks for a transcode after direct playback failed, which a
	// remux of the same video stream would repeat.
	if !forcePlaybackTranscode(r) {
		capabilities := playbackCapabilities(r)
		if _, direct := directPlaybackContentType(source.Probe, playbackProfileVideo, capabilities); direct {
			query := url.Values{"profile": []string{playbackProfileVideo}}
			if values := sortedPlaybackCapabilities(capabilities); len(values) > 0 {
				query.Set("capabilities", strings.Join(values, ","))
			}
			writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
				Delivery: "direct", Conversion: "none", URL: fmt.Sprintf("/api/media/%d/stream?%s", locationID, query.Encode()),
				DurationSeconds: source.Duration, Seekable: true,
			})
			return
		}
		if s.videoRemuxAvailable(r.Context(), source, capabilities) {
			writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
				Delivery:        "hls",
				Conversion:      "remux",
				URL:             fmt.Sprintf("/api/media/%d/hls/index.m3u8?v=%s", locationID, videoRemuxRevision(source)),
				DurationSeconds: source.Duration,
				Seekable:        true,
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
		Delivery:        "hls",
		Conversion:      "transcode",
		URL:             fmt.Sprintf("/api/media/%d/hls/index.m3u8?v=%s", locationID, source.Revision),
		DurationSeconds: source.Duration,
		Seekable:        true,
	})
}

// videoRemuxAvailable reports whether the client gets a remux of the source:
// it decodes the video stream, the source's bitrate and keyframes fit the
// remux limits, and a remux of this revision has not failed recently.
func (s *Server) videoRemuxAvailable(ctx context.Context, source hlsPlaybackSource, capabilities map[string]bool) bool {
	info, err := os.Stat(source.Path)
	if err != nil || !remuxableVideo(source, capabilities, info.Size()) ||
		s.mediaPreparationFailures.failedRecently(mediaPreparationFailureKey(videoRemuxHLSProfile.name, source.Path, info)) {
		return false
	}
	_, err = s.videoKeyframeIndex(ctx, source, videoKeyframeIndexInfoWait)
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, errRealtimeResourceBusy) {
		slog.Info("video is transcoded because it cannot be remuxed", "location_id", source.LocationID, "error", err)
	}
	return err == nil
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

// serveMediaHLS serves the HLS VOD playlist and segments of a local or cached
// video or audio file. Segments come from continuous encoding sessions (see
// media_hls_session.go). The profile query "audio" plays only the audio of a
// video, for the audio player.
func (s *Server) serveMediaHLS(w http.ResponseWriter, r *http.Request) {
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
	requestedProfile := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("profile")))
	if requestedProfile != "" && requestedProfile != playbackProfileAudio && requestedProfile != playbackProfileVideo {
		writeAPIError(w, http.StatusBadRequest, "invalid_playback_profile", "playback profile is invalid", false)
		return
	}
	source, err := s.loadHLSPlaybackSourceProfile(r.Context(), locationID, requestedProfile)
	if err != nil {
		s.writeHLSPlaybackError(w, err, "media")
		return
	}
	profile := source.Encode
	if revision := strings.TrimSpace(r.URL.Query().Get("v")); revision != "" && revision != source.Revision {
		// Playback info names a remux by its own revision of the source.
		if source.Profile != playbackProfileVideo || revision != videoRemuxRevision(source) {
			s.writeHLSPlaybackError(w, errHLSPlaybackSourceChanged, source.Profile)
			return
		}
		if !copyableH264(firstPlaybackStream(source.Probe, "video")) {
			s.writeHLSPlaybackError(w, errHLSMediaUnsupported, source.Profile)
			return
		}
		keyframes, err := s.videoKeyframeIndex(r.Context(), source, hlsSegmentWait)
		if err != nil {
			if errors.Is(err, errVideoKeyframeIndexUnusable) {
				err = errHLSMediaUnsupported
			}
			s.writeHLSPlaybackError(w, err, source.Profile)
			return
		}
		source.Revision, source.Keyframes, profile = revision, keyframes, &videoRemuxHLSProfile
	}
	if file == "index.m3u8" {
		// Segments repeat the requested profile, which selects their encode.
		segmentQuery := url.Values{"v": []string{source.Revision}}
		if requestedProfile != "" {
			segmentQuery.Set("profile", requestedProfile)
		}
		playlist := buildHLSPlaylist(source.Duration, segmentQuery.Encode())
		if source.Keyframes != nil {
			playlist = buildHLSPlaylistOfSegments(source.Keyframes.durations(), segmentQuery.Encode())
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "private, no-cache")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// The player's failure check reads this to know the stream is already converted.
		w.Header().Set("X-Kikoto-Playback-Delivery", "transcoded")
		_, _ = w.Write([]byte(playlist))
		return
	}
	segmentIndex, err := strconv.Atoi(segmentMatch[1])
	if err != nil || segmentIndex < 0 || segmentIndex >= source.segmentCount() {
		writeAPIError(w, http.StatusNotFound, "hls_segment_not_found", "playback segment was not found", false)
		return
	}
	err = s.serveHLSSessionSegment(w, r, profile, source, segmentIndex)
	if err != nil {
		if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
			slog.Warn("playback segment preparation failed", "location_id", source.LocationID, "profile", source.Profile, "segment", segmentIndex, "error", err)
		}
		if errors.Is(err, errRealtimeResourceBusy) {
			w.Header().Set("Retry-After", "1")
			writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_busy", "media playback is temporarily busy", true)
			return
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return
		}
		if errors.Is(err, errHLSSegmentNotFound) {
			writeAPIError(w, http.StatusNotFound, "hls_segment_not_found", "playback segment was not found", false)
			return
		}
		if errors.Is(err, errHLSTranscodeUnavailable) {
			writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", source.Profile+" playback preparation failed", true)
			return
		}
		writeAPIError(w, http.StatusInsufficientStorage, "transcode_cache_unavailable", source.Profile+" playback cache is unavailable", true)
	}
}

// writeHLSPlaybackError names the media in messages as noun: "video", "audio",
// or "media" before the kind is known.
func (s *Server) writeHLSPlaybackError(w http.ResponseWriter, err error, noun string) {
	if writeLibraryStorageError(w, err) {
		return
	}
	switch {
	case errors.Is(err, errHLSMediaNotFound):
		writeAPIError(w, http.StatusNotFound, "media_not_found", "media file was not found", false)
	case errors.Is(err, errHLSMediaUnsupported):
		writeAPIError(w, http.StatusUnprocessableEntity, "media_hls_unsupported", noun+" cannot be prepared for seekable playback", false)
	case errors.Is(err, errHLSPlaybackSourceChanged):
		writeAPIError(w, http.StatusConflict, "playback_source_changed", noun+" source changed; reload playback", true)
	case errors.Is(err, errRealtimeResourceBusy):
		w.Header().Set("Retry-After", "1")
		writeAPIError(w, http.StatusServiceUnavailable, "media_probe_busy", "media playback inspection is temporarily busy", true)
	default:
		writeAPIError(w, http.StatusServiceUnavailable, "media_playback_unavailable", noun+" playback preparation is unavailable", true)
	}
}

func (s *Server) loadHLSPlaybackSource(ctx context.Context, locationID int64) (hlsPlaybackSource, error) {
	return s.loadHLSPlaybackSourceProfile(ctx, locationID, "")
}

// hlsPlaybackProfile selects what an HLS playlist of a media kind plays: the
// kind itself when requested is empty, or the audio alone of a video. The
// profile version is part of the revision, so the sessions of one file under
// different profiles never share segments.
func hlsPlaybackProfile(kind string, requested string) (profile string, encode *hlsEncodeProfile, version string, ok bool) {
	switch {
	case kind == "audio" && (requested == "" || requested == playbackProfileAudio):
		return playbackProfileAudio, &audioHLSProfile, audioHLSProfileVersion, true
	case kind == "video" && (requested == "" || requested == playbackProfileVideo):
		return playbackProfileVideo, &videoHLSProfile, hlsProfileVersion, true
	case kind == "video" && requested == playbackProfileAudio:
		return playbackProfileAudio, &videoAudioHLSProfile, videoAudioHLSProfileVersion, true
	}
	return "", nil, "", false
}

func (s *Server) loadHLSPlaybackSourceProfile(ctx context.Context, locationID int64, requestedProfile string) (hlsPlaybackSource, error) {
	target, _, err := s.loadMediaStreamTarget(ctx, locationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return hlsPlaybackSource{}, errHLSMediaNotFound
		}
		return hlsPlaybackSource{}, err
	}
	kind := effectiveMediaKind(target.Kind, target.RelativePath)
	if (target.LocationType != "local" && target.LocationType != "cache") || target.Availability != "available" || (kind != "video" && kind != "audio") {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	if err := s.ensureMediaLocationReadable(ctx, target.LocationType, target.RelativePath); err != nil {
		return hlsPlaybackSource{}, err
	}
	root := s.cfg.DataRoot
	if target.LocationType == "cache" {
		root = s.cfg.CacheRoot
	}
	mediaPath, err := safeResolvedPath(root, target.RelativePath)
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
	profile, encode, profileVersion, ok := hlsPlaybackProfile(kind, requestedProfile)
	if !ok {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	if firstPlaybackStream(probe, profile) == nil {
		return hlsPlaybackSource{}, errHLSMediaUnsupported
	}
	duration := playbackDurationSeconds(target, probe)
	if duration <= 0 || duration > hlsMaximumDurationSeconds || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return hlsPlaybackSource{}, errHLSMediaUnsupported
	}
	revisionInput := fmt.Sprintf("%s\x00%d\x00%s\x00%d\x00%d", profileVersion, locationID, filepath.ToSlash(target.RelativePath), info.Size(), info.ModTime().UnixNano())
	revision := sha256.Sum256([]byte(revisionInput))
	return hlsPlaybackSource{
		LocationID: locationID,
		Path:       mediaPath,
		Profile:    profile,
		Encode:     encode,
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

// buildHLSPlaylist lists the segments of duration, each URL with segmentQuery.
func buildHLSPlaylist(duration float64, segmentQuery string) string {
	durations := make([]float64, hlsSegmentCount(duration))
	for index := range durations {
		_, durations[index] = hlsSegmentWindow(duration, index)
	}
	return buildHLSPlaylistOfSegments(durations, segmentQuery)
}

// buildHLSPlaylistOfSegments lists segments of the given durations, each URL
// with segmentQuery.
func buildHLSPlaylistOfSegments(durations []float64, segmentQuery string) string {
	var playlist strings.Builder
	playlist.WriteString("#EXTM3U\n")
	playlist.WriteString("#EXT-X-VERSION:3\n")
	// The target duration is the longest segment rounded up.
	fmt.Fprintf(&playlist, "#EXT-X-TARGETDURATION:%d\n", int(math.Ceil(slices.Max(durations)-0.0005)))
	playlist.WriteString("#EXT-X-MEDIA-SEQUENCE:0\n")
	playlist.WriteString("#EXT-X-PLAYLIST-TYPE:VOD\n")
	playlist.WriteString("#EXT-X-INDEPENDENT-SEGMENTS\n")
	for index, duration := range durations {
		fmt.Fprintf(&playlist, "#EXTINF:%.3f,\nsegment-%06d.ts?%s\n", duration, index, segmentQuery)
	}
	playlist.WriteString("#EXT-X-ENDLIST\n")
	return playlist.String()
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

func validCachedHLSSegment(path string, maximumBytes int64) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0 && info.Size() <= maximumBytes
}

// Video HLS encodes stop a few minutes ahead of the viewer and when no request
// arrives for a minute, because a 720p H.264 encode keeps a transcode slot and
// two CPU threads busy for as long as it runs.
var videoHLSProfile = hlsEncodeProfile{
	name:     "video-hls",
	cacheDir: "hls",
	playlist: videoHLSSessionPlaylist,
	// Six minutes ahead of the viewer, refilled two minutes before a gap.
	aheadSegments:      60,
	refillLeadSegments: 20,
	// Restarting at a later segment produces it sooner than encoding the
	// segments before it.
	waitWindowSegments:  2,
	maximumSegments:     60 + 20,
	segmentMaximumBytes: hlsSegmentMaximumBytes,
	// 2800 kbit/s video and 128 kbit/s audio are about 2.2 MB per segment, and
	// the rate control buffer allows a segment to exceed that average.
	reservation: fixedHLSSegmentReservation(60+20, 3<<20),
	idleTimeout: time.Minute,
	args: func(source hlsPlaybackSource, outputDir string, startIndex int) []string {
		return videoHLSFFmpegArgs(source.Path, outputDir, startIndex, source.Duration)
	},
}

func videoHLSFFmpegArgs(input string, outputDir string, startIndex int, durationSeconds float64) []string {
	start := float64(startIndex) * hlsSegmentDurationSeconds
	formatSeconds := func(value float64) string { return strconv.FormatFloat(value, 'f', 3, 64) }
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-threads", "2", "-filter_threads", "1", "-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe",
		"-ss", formatSeconds(start), "-i", input,
		"-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-sn", "-dn",
		// Cloning the last frame keeps a video stream ending before the audio
		// cutting segments until the published duration, where -t ends it.
		"-vf", "tpad=stop=-1:stop_mode=clone," +
			"scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2," +
			"pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2:x=0:y=0",
		"-t", formatSeconds(durationSeconds - start),
		// A constant frame rate puts a frame at every segment boundary of a
		// variable or sparse frame rate source.
		"-fps_mode", "cfr", "-fpsmax", "60",
		"-c:v", "libx264", "-threads:v", "2", "-preset", "veryfast",
		"-crf", "24", "-maxrate", "2800k", "-bufsize", "5600k", "-pix_fmt", "yuv420p",
		// Keyframes, where the HLS muxer cuts segments, fall only on the
		// six-second grid that the published playlist describes.
		"-g", "600", "-sc_threshold", "0",
		"-force_key_frames", "expr:gte(t,n_forced*" + strconv.FormatFloat(hlsSegmentDurationSeconds, 'f', -1, 64) + ")",
		"-c:a", "aac", "-threads:a", "1", "-b:a", "128k", "-ac", "2", "-ar", "48000",
		// Every session writes the timestamps of one shared timeline, offset so
		// that B-frame decode timestamps stay positive from the first segment;
		// FFmpeg would otherwise shift only the session that starts at zero.
		"-output_ts_offset", formatSeconds(start + videoHLSTimelineOffsetSeconds),
		// Strict interleaving keeps each audio packet in the segment of its
		// timestamp even when the video encoder lags behind the audio.
		"-max_interleave_delta", "0",
		"-muxdelay", "0", "-muxpreload", "0",
	}
	return append(args, hlsSegmentFFmpegOutputArgs(outputDir, videoHLSSessionPlaylist, startIndex)...)
}
