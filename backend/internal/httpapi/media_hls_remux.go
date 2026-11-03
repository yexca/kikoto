package httpapi

import (
	"bufio"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Remuxed video HLS copies an H.264 or HEVC stream the client decodes into the
// segments and encodes only the audio, so playback keeps the source picture
// for a small part of a transcode's CPU. Copied video can be cut only at its
// own keyframes, so the playlist follows a keyframe index of the source
// instead of the six-second grid. H.264 is copied into MPEG-TS segments, and
// HEVC into fMP4 segments, the only HEVC segments HLS players accept.
const (
	videoRemuxHLSProfileVersion  = "hls-remux-v1"
	videoHEVCRemuxProfileVersion = "hls-remux-hevc-fmp4-v1"
	videoRemuxHLSSessionPlaylist = ".video-remux-session.list"
	// Segments start at the keyframe nearest each six-second target, but never
	// less than the minimum after the previous start. A gap between keyframes
	// that leaves a segment longer than the maximum makes the source
	// transcoded instead.
	videoRemuxTargetSegmentSeconds  = 6.0
	videoRemuxMinimumSegmentSeconds = 3.0
	videoRemuxMaximumSegmentSeconds = 15.0
	// A source above this average bitrate is transcoded, which also bounds the
	// size of a segment and of an encode's quota reservation.
	videoRemuxMaximumBitsPerSecond = 20_000_000
	videoRemuxSegmentMaximumBytes  = 64 << 20
	videoRemuxAheadSegments        = 20
	videoRemuxMaximumSegments      = videoRemuxAheadSegments + 10
	// Building a keyframe index reads every video packet header of the file.
	videoKeyframeIndexTimeout     = time.Minute
	videoKeyframeIndexOutputLimit = 64 << 20
	videoKeyframeIndexCacheSize   = 64
	videoKeyframeIndexFailureTTL  = 10 * time.Minute
	// Playback info waits this long for an index before it offers a transcode;
	// the index keeps building for the next playback.
	videoKeyframeIndexInfoWait = 5 * time.Second
)

var errVideoKeyframeIndexUnusable = errors.New("video keyframes cannot be segmented")

var videoRemuxHLSProfile = hlsEncodeProfile{
	name:     "video-remux-hls",
	cacheDir: "hls-remux",
	playlist: videoRemuxHLSSessionPlaylist,
	// Two minutes ahead of the viewer, refilled one minute before a gap.
	aheadSegments:      videoRemuxAheadSegments,
	refillLeadSegments: 10,
	// Copying is far faster than playback, so waiting for nearby segments
	// costs less than a restart.
	waitWindowSegments:  10,
	maximumSegments:     videoRemuxMaximumSegments,
	segmentMaximumBytes: videoRemuxSegmentMaximumBytes,
	idleTimeout:         time.Minute,
	// FFmpeg's segment muxer, which cuts at listed packet counts, writes each
	// segment under a temporary name that the session renames once the next
	// one starts.
	renamesSegments: true,
	reservation: func(source hlsPlaybackSource, startIndex int) int64 {
		index := source.Keyframes
		end := min(startIndex+videoRemuxMaximumSegments, len(index.cuts))
		seconds := index.segmentEnd(end-1) - index.cuts[startIndex]
		// The copied video's own bitrate varies around its average.
		return int64(seconds*index.bytesPerSecond*1.25) + int64(seconds*videoRemuxAudioBitsPerSecond/8)
	},
	args: func(source hlsPlaybackSource, outputDir string, startIndex int) []string {
		return videoRemuxHLSFFmpegArgs(source.Path, outputDir, startIndex, source.Keyframes)
	},
}

const videoRemuxAudioBitsPerSecond = 192_000

// HEVC remux sessions share every limit of an H.264 remux and keep their
// segments apart, with the initialization section beside them.
var videoHEVCRemuxHLSProfile = func() hlsEncodeProfile {
	profile := videoRemuxHLSProfile
	profile.name = "video-remux-hevc-hls"
	profile.cacheDir = "hls-remux-hevc"
	profile.segments = &hlsFMP4Segments
	profile.args = func(source hlsPlaybackSource, outputDir string, startIndex int) []string {
		return videoHEVCRemuxHLSFFmpegArgs(source.Path, outputDir, startIndex, source.Keyframes)
	}
	return profile
}()

// videoRemux is one kind of remuxed video: the streams it copies, whether a
// client decodes them in its segments, and the encode that writes them.
type videoRemux struct {
	version  string
	profile  *hlsEncodeProfile
	copyable func(video *playbackProbeStream) bool
	decodes  func(video *playbackProbeStream, capabilities map[string]bool) bool
}

var (
	videoH264Remux = videoRemux{
		version:  videoRemuxHLSProfileVersion,
		profile:  &videoRemuxHLSProfile,
		copyable: copyableH264,
		decodes: func(video *playbackProbeStream, capabilities map[string]bool) bool {
			return videoDecoderSupported(video, "h264", capabilities)
		},
	}
	videoHEVCRemux = videoRemux{
		version:  videoHEVCRemuxProfileVersion,
		profile:  &videoHEVCRemuxHLSProfile,
		copyable: copyableHEVC,
		decodes:  hlsHEVCDecoderSupported,
	}
	videoRemuxes = []*videoRemux{&videoH264Remux, &videoHEVCRemux}
)

// revision names the playlist of this remux of a source revision.
func (remux *videoRemux) revision(source hlsPlaybackSource) string {
	revision := sha256.Sum256([]byte(remux.version + "\x00" + source.Revision))
	return fmt.Sprintf("%x", revision[:12])
}

// videoRemuxOfRevision returns the remux whose playlist revision of source is
// revision, or nil.
func videoRemuxOfRevision(source hlsPlaybackSource, revision string) *videoRemux {
	for _, remux := range videoRemuxes {
		if revision == remux.revision(source) {
			return remux
		}
	}
	return nil
}

// videoKeyframeIndex holds where the segments of a remuxed video start: the
// keyframe times in seconds of the source timeline, and how many video
// packets precede each keyframe in decode order.
type videoKeyframeIndex struct {
	cuts    []float64
	packets []int
	// end is where the last segment ends.
	end            float64
	bytesPerSecond float64
}

func (index *videoKeyframeIndex) segmentEnd(segment int) float64 {
	if segment+1 < len(index.cuts) {
		return index.cuts[segment+1]
	}
	return index.end
}

func (index *videoKeyframeIndex) durations() []float64 {
	durations := make([]float64, len(index.cuts))
	for segment := range index.cuts {
		durations[segment] = index.segmentEnd(segment) - index.cuts[segment]
	}
	return durations
}

// videoRemuxCutter chooses segment starts from keyframe times as FFprobe
// reports them, which are in decode order.
type videoRemuxCutter struct {
	cuts    []float64
	packets []int
	// pending is the latest keyframe before the next target.
	pending       float64
	pendingPacket int
	hasPending    bool
}

func (cutter *videoRemuxCutter) cut(keyframe float64, packet int) {
	cutter.cuts = append(cutter.cuts, keyframe)
	cutter.packets = append(cutter.packets, packet)
	cutter.hasPending = false
}

// add considers a keyframe at the given time that follows packet earlier
// video packets.
func (cutter *videoRemuxCutter) add(keyframe float64, packet int) {
	if len(cutter.cuts) == 0 {
		cutter.cut(keyframe, packet)
		return
	}
	last := cutter.cuts[len(cutter.cuts)-1]
	if keyframe <= last || cutter.hasPending && keyframe <= cutter.pending {
		return
	}
	target := last + videoRemuxTargetSegmentSeconds
	if keyframe < target {
		cutter.pending, cutter.pendingPacket, cutter.hasPending = keyframe, packet, true
		return
	}
	// Cut at whichever of the two keyframes around the target is nearer.
	if cutter.hasPending && cutter.pending-last >= videoRemuxMinimumSegmentSeconds && target-cutter.pending < keyframe-target {
		cutter.cut(cutter.pending, cutter.pendingPacket)
		cutter.add(keyframe, packet)
		return
	}
	cutter.cut(keyframe, packet)
}

// finish returns the index of a stream that ends at end, or an error when a
// segment would exceed the maximum length.
func (cutter *videoRemuxCutter) finish(start float64, end float64) (*videoKeyframeIndex, error) {
	if len(cutter.cuts) == 0 {
		return nil, fmt.Errorf("%w: the video has no keyframe", errVideoKeyframeIndexUnusable)
	}
	// The end of the stream ends the last segment the way a keyframe would.
	last := cutter.cuts[len(cutter.cuts)-1]
	target := last + videoRemuxTargetSegmentSeconds
	if cutter.hasPending && end > target && target-cutter.pending < end-target &&
		cutter.pending-last >= videoRemuxMinimumSegmentSeconds && end-cutter.pending >= videoRemuxMinimumSegmentSeconds {
		cutter.cut(cutter.pending, cutter.pendingPacket)
	}
	index := &videoKeyframeIndex{cuts: cutter.cuts, packets: cutter.packets, end: end}
	if index.cuts[0]-start > videoRemuxMaximumSegmentSeconds {
		return nil, fmt.Errorf("%w: the first keyframe is %.1f s in", errVideoKeyframeIndexUnusable, index.cuts[0]-start)
	}
	if end <= index.cuts[len(index.cuts)-1] {
		return nil, fmt.Errorf("%w: the video ends before its last keyframe", errVideoKeyframeIndexUnusable)
	}
	if longest := slices.Max(index.durations()); longest > videoRemuxMaximumSegmentSeconds {
		return nil, fmt.Errorf("%w: a segment would last %.1f s", errVideoKeyframeIndexUnusable, longest)
	}
	return index, nil
}

// copyableH264 reports whether a video stream is H.264 that HLS can carry
// unchanged to a browser decoder: 8-bit 4:2:0 in a Baseline, Main, or High
// profile.
func copyableH264(video *playbackProbeStream) bool {
	if video == nil || !strings.EqualFold(strings.TrimSpace(video.CodecName), "h264") {
		return false
	}
	depth, ok := videoBitDepth(video.PixelFmt)
	return ok && depth == 8 && slices.Contains(h264HighProfiles, strings.ToLower(strings.TrimSpace(video.Profile)))
}

// copyableHEVC reports whether a video stream is 8- or 10-bit 4:2:0 HEVC in
// the Main or Main 10 profile, which fMP4 HLS segments carry unchanged.
func copyableHEVC(video *playbackProbeStream) bool {
	if video == nil || !strings.EqualFold(strings.TrimSpace(video.CodecName), "hevc") {
		return false
	}
	_, ok := videoBitDepth(video.PixelFmt)
	return ok && slices.Contains([]string{"main", "main 10"}, strings.ToLower(strings.TrimSpace(video.Profile)))
}

// remuxForVideo returns the remux whose segments a client with these
// capabilities decodes, for a source it cannot play directly, or nil when the
// source needs a transcode.
func remuxForVideo(source hlsPlaybackSource, capabilities map[string]bool, sizeBytes int64) *videoRemux {
	if float64(sizeBytes)*8/source.Duration > videoRemuxMaximumBitsPerSecond {
		return nil
	}
	video := firstPlaybackStream(source.Probe, "video")
	for _, remux := range videoRemuxes {
		if remux.copyable(video) && remux.decodes(video, capabilities) {
			return remux
		}
	}
	return nil
}

type videoKeyframeIndexBuild struct {
	done       chan struct{}
	index      *videoKeyframeIndex
	err        error
	finishedAt time.Time
}

// videoKeyframeIndexes builds one index at a time and keeps recent results per
// source revision, so concurrent requests share a build.
type videoKeyframeIndexes struct {
	mu     sync.Mutex
	builds map[string]*videoKeyframeIndexBuild
	slot   chan struct{}
}

// videoKeyframeIndex returns the keyframe index of a source revision, waiting
// at most wait for a build that runs under the server lifetime.
func (s *Server) videoKeyframeIndex(ctx context.Context, source hlsPlaybackSource, wait time.Duration) (*videoKeyframeIndex, error) {
	indexes := &s.videoKeyframeIndexes
	indexes.mu.Lock()
	if indexes.builds == nil {
		indexes.builds = map[string]*videoKeyframeIndexBuild{}
		indexes.slot = make(chan struct{}, 1)
	}
	build := indexes.builds[source.Revision]
	if build != nil && build.err != nil && time.Since(build.finishedAt) >= videoKeyframeIndexFailureTTL {
		build = nil
	}
	if build == nil {
		indexes.evictLocked()
		build = &videoKeyframeIndexBuild{done: make(chan struct{})}
		indexes.builds[source.Revision] = build
		if !s.Go(func(lifetime context.Context) {
			index, err := s.buildVideoKeyframeIndex(lifetime, source)
			indexes.mu.Lock()
			build.index, build.err, build.finishedAt = index, err, time.Now()
			if err != nil && lifetime.Err() != nil {
				// A shutdown says nothing about the file.
				delete(indexes.builds, source.Revision)
			}
			indexes.mu.Unlock()
			close(build.done)
		}) {
			delete(indexes.builds, source.Revision)
			indexes.mu.Unlock()
			return nil, ErrShuttingDown
		}
	}
	indexes.mu.Unlock()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-build.done:
		return build.index, build.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, errRealtimeResourceBusy
	}
}

// evictLocked keeps the cache within its size, removing the builds that
// finished first.
func (indexes *videoKeyframeIndexes) evictLocked() {
	for len(indexes.builds) >= videoKeyframeIndexCacheSize {
		oldestKey := ""
		var oldest time.Time
		for key, build := range indexes.builds {
			if build.finishedAt.IsZero() {
				continue
			}
			if oldestKey == "" || build.finishedAt.Before(oldest) {
				oldestKey, oldest = key, build.finishedAt
			}
		}
		if oldestKey == "" {
			return
		}
		delete(indexes.builds, oldestKey)
	}
}

func (s *Server) buildVideoKeyframeIndex(ctx context.Context, source hlsPlaybackSource) (*videoKeyframeIndex, error) {
	ctx, cancel := context.WithTimeout(ctx, videoKeyframeIndexTimeout)
	defer cancel()
	select {
	case s.videoKeyframeIndexes.slot <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.videoKeyframeIndexes.slot }()
	info, err := os.Stat(source.Path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errHLSMediaNotFound
	}
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		return nil, fmt.Errorf("ffprobe is unavailable")
	}
	command := exec.CommandContext(ctx, ffprobePath, videoKeyframeIndexFFprobeArgs(source.Path)...)
	command.Stderr = io.Discard
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("ffprobe failed to start")
	}
	index, parseErr := parseVideoKeyframePackets(io.LimitReader(stdout, videoKeyframeIndexOutputLimit+1))
	if parseErr != nil {
		cancel()
	}
	waitErr := command.Wait()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, fmt.Errorf("%w: the keyframe scan timed out", errVideoKeyframeIndexUnusable)
	}
	if err := ctx.Err(); err != nil && parseErr == nil {
		return nil, err
	}
	if parseErr != nil {
		return nil, parseErr
	}
	if waitErr != nil {
		return nil, fmt.Errorf("%w: ffprobe exited with an error", errVideoKeyframeIndexUnusable)
	}
	index.bytesPerSecond = float64(info.Size()) / (index.end - index.cuts[0])
	return index, nil
}

func videoKeyframeIndexFFprobeArgs(input string) []string {
	return []string{
		"-v", "error", "-threads", "1",
		"-protocol_whitelist", "file,pipe",
		"-select_streams", "v:0",
		"-show_entries", "packet=pts_time,flags:format=start_time,duration",
		"-of", "compact",
		input,
	}
}

// parseVideoKeyframePackets reads FFprobe's compact packet and format lines
// and returns the segment index they describe.
func parseVideoKeyframePackets(reader io.Reader) (*videoKeyframeIndex, error) {
	var cutter videoRemuxCutter
	start, duration := 0.0, 0.0
	read, packets := 0, 0
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		line := scanner.Text()
		read += len(line) + 1
		if read > videoKeyframeIndexOutputLimit {
			return nil, fmt.Errorf("%w: the keyframe scan output exceeded its limit", errVideoKeyframeIndexUnusable)
		}
		fields := map[string]string{}
		section, rest, _ := strings.Cut(line, "|")
		for _, field := range strings.Split(rest, "|") {
			if key, value, ok := strings.Cut(field, "="); ok {
				fields[key] = value
			}
		}
		switch section {
		case "packet":
			packets++
			if !strings.HasPrefix(fields["flags"], "K") {
				continue
			}
			time, err := strconv.ParseFloat(fields["pts_time"], 64)
			if err != nil || math.IsNaN(time) || math.IsInf(time, 0) {
				return nil, fmt.Errorf("%w: a keyframe has no presentation time", errVideoKeyframeIndexUnusable)
			}
			cutter.add(time, packets-1)
		case "format":
			if value, err := strconv.ParseFloat(fields["start_time"], 64); err == nil {
				start = value
			}
			if value, err := strconv.ParseFloat(fields["duration"], 64); err == nil {
				duration = value
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", errVideoKeyframeIndexUnusable, err)
	}
	if duration <= 0 {
		return nil, fmt.Errorf("%w: the file has no duration", errVideoKeyframeIndexUnusable)
	}
	return cutter.finish(start, start+duration)
}

// videoRemuxOutput is where a remux encode writes its segments.
type videoRemuxOutput struct {
	// muxer holds the options of the segments' container.
	muxer []string
	// list is the segment muxer's list, and pattern the segment names.
	list    string
	pattern string
}

func videoRemuxHLSFFmpegArgs(input string, outputDir string, startIndex int, index *videoKeyframeIndex) []string {
	return videoRemuxFFmpegArgs(input, startIndex, index, videoRemuxOutput{
		muxer:   []string{"-segment_format", "mpegts"},
		list:    filepath.Join(outputDir, videoRemuxHLSSessionPlaylist),
		pattern: videoRemuxSegmentPattern(outputDir, &hlsMPEGTSSegments),
	})
}

// videoHEVCRemuxHLSFFmpegArgs writes fMP4 segments without their
// initialization section, which every encode of a revision writes alike and
// videoHEVCRemuxInitArgs produces on its own.
func videoHEVCRemuxHLSFFmpegArgs(input string, outputDir string, startIndex int, index *videoKeyframeIndex) []string {
	return videoRemuxFFmpegArgs(input, startIndex, index, videoRemuxOutput{
		muxer:   videoHEVCRemuxMuxerArgs(os.DevNull),
		list:    filepath.Join(outputDir, videoRemuxHLSSessionPlaylist),
		pattern: videoRemuxSegmentPattern(outputDir, &hlsFMP4Segments),
	})
}

// videoHEVCRemuxMuxerArgs writes the fMP4 initialization section to header
// and one fragment per segment. Each segment's first fragment carries the
// decode time of its first packet on the shared timeline, and later fragments
// continue from it.
func videoHEVCRemuxMuxerArgs(header string) []string {
	return []string{
		// Apple's HLS players accept HEVC only under the hvc1 sample entry.
		"-tag:v", "hvc1",
		"-segment_format", "mp4",
		"-segment_format_options", "movflags=+frag_custom+empty_moov+default_base_moof+frag_discont+skip_trailer:use_editlist=0:avoid_negative_ts=disabled",
		"-segment_header_filename", header,
		"-individual_header_trailer", "0",
	}
}

// The segment name is an FFmpeg pattern, so a literal % in the cache path is doubled.
func videoRemuxSegmentPattern(outputDir string, format *hlsSegmentFormat) string {
	return filepath.Join(strings.ReplaceAll(outputDir, "%", "%%"), "segment-%06d"+format.extension+".tmp")
}

func videoRemuxFFmpegArgs(input string, startIndex int, index *videoKeyframeIndex, output videoRemuxOutput) []string {
	formatSeconds := func(value float64) string { return strconv.FormatFloat(value, 'f', 6, 64) }
	// The segment muxer starts a segment at the first keyframe after each
	// listed count of video packets, counted from the first packet it writes.
	// FFmpeg versions disagree on the timeline of listed times, but not on
	// packet counts.
	var cutPackets []string
	for segment := startIndex + 1; segment < len(index.cuts) && segment <= startIndex+videoRemuxMaximumSegments; segment++ {
		cutPackets = append(cutPackets, strconv.Itoa(index.packets[segment]-index.packets[startIndex]))
	}
	args := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-threads", "1", "-filter_threads", "1", "-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe",
		// Seeking to the source timestamp just before the first keyframe of the
		// segment, keeping source timestamps and discarding packets before that
		// time, makes the keyframe the first copied packet and trims the audio
		// there.
		"-seek_timestamp", "1", "-ss", formatSeconds(index.cuts[startIndex] - 0.001), "-copyts",
		"-i", input,
		"-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-sn", "-dn",
		"-c:v", "copy", "-copypriorss", "0",
		"-c:a", "aac", "-threads:a", "1", "-b:a", strconv.Itoa(videoRemuxAudioBitsPerSecond), "-ac", "2", "-ar", "48000",
		// The same offset as transcoded video keeps the decode timestamps of
		// sources that start at zero positive.
		"-output_ts_offset", formatSeconds(videoHLSTimelineOffsetSeconds),
		"-max_interleave_delta", "0",
		"-muxdelay", "0", "-muxpreload", "0",
		"-f", "segment",
		"-segment_start_number", strconv.Itoa(startIndex),
		"-segment_list", output.list, "-segment_list_type", "flat",
	}
	args = append(args, output.muxer...)
	if len(cutPackets) > 0 {
		args = append(args, "-segment_frames", strings.Join(cutPackets, ","))
	} else {
		// The last segment runs to the end of the file.
		args = append(args, "-segment_time", strconv.Itoa(2*hlsMaximumDurationSeconds))
	}
	return append(args, output.pattern)
}
