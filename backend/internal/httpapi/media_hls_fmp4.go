package httpapi

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// An fMP4 playlist names one initialization section, the ftyp and moov boxes
// that every segment of the revision depends on. Encodes write the same
// section, so it is produced once per revision by a run of the remux encode
// that copies no media, and cached beside the segments.
const (
	hlsInitSectionMaximumBytes int64 = 1 << 20
	hlsInitSectionTimeout            = 30 * time.Second
	// The init run writes its partial files under the session playlist's
	// name, so session cleanup and the cache scan treat them as partials.
	hlsInitSectionPartial = videoRemuxHLSSessionPlaylist + ".init"
)

// HEVC in HLS segments plays through Media Source Extensions in hls.js, or the
// native HLS player on Apple devices, so the client probes these keys against
// Media Source rather than file playback. Each mirrors an HEVC decoder key of
// direct playback.
var hlsHEVCDecoderCapabilities = map[string]string{
	capVideoHEVCMain:      capVideoHLSHEVCMain,
	capVideoHEVCMainL51:   capVideoHLSHEVCMainL51,
	capVideoHEVCMain10:    capVideoHLSHEVCMain10,
	capVideoHEVCMain10L51: capVideoHLSHEVCMain10L51,
}

// hlsHEVCDecoderSupported reports whether the client decodes the HEVC stream
// in HLS segments, by the decoder tiers of direct playback.
func hlsHEVCDecoderSupported(video *playbackProbeStream, capabilities map[string]bool) bool {
	decoders := make(map[string]bool, len(hlsHEVCDecoderCapabilities))
	for decoder, hls := range hlsHEVCDecoderCapabilities {
		decoders[decoder] = capabilities[hls]
	}
	return videoDecoderSupported(video, "hevc", decoders)
}

// videoHEVCRemuxInitArgs runs the remux encode of the first segment with no
// output duration, which writes the initialization section to standard output
// and an empty segment under a partial name.
func videoHEVCRemuxInitArgs(input string, outputDir string, index *videoKeyframeIndex) []string {
	muxer := append([]string{"-t", "0"}, videoHEVCRemuxMuxerArgs("pipe:1")...)
	return videoRemuxFFmpegArgs(input, 0, index, videoRemuxOutput{
		muxer:   muxer,
		list:    filepath.Join(outputDir, hlsInitSectionPartial+".list"),
		pattern: filepath.Join(strings.ReplaceAll(outputDir, "%", "%%"), hlsInitSectionPartial+"-%06d"),
	})
}

// validHLSInitSection reports whether data is exactly an ftyp box followed by
// a moov box.
func validHLSInitSection(data []byte) bool {
	var types []string
	for offset := 0; offset < len(data); {
		if len(data)-offset < 8 {
			return false
		}
		size := int(binary.BigEndian.Uint32(data[offset:]))
		if size < 8 || size > len(data)-offset {
			return false
		}
		types = append(types, string(data[offset+4:offset+8]))
		offset += size
	}
	return slices.Equal(types, []string{"ftyp", "moov"})
}

func (s *Server) serveHLSInitSection(w http.ResponseWriter, r *http.Request, profile *hlsEncodeProfile, source hlsPlaybackSource) {
	err := s.serveCachedHLSInitSection(w, r, profile, source)
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	slog.Warn("playback initialization section preparation failed", "location_id", source.LocationID, "error", err)
	switch {
	case errors.Is(err, errRealtimeResourceBusy):
		w.Header().Set("Retry-After", "1")
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_busy", "media playback is temporarily busy", true)
	case errors.Is(err, errHLSMediaNotFound):
		writeAPIError(w, http.StatusNotFound, "media_not_found", "media file was not found", false)
	case errors.Is(err, errHLSTranscodeUnavailable):
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", source.Profile+" playback preparation failed", true)
	default:
		writeAPIError(w, http.StatusInsufficientStorage, "transcode_cache_unavailable", source.Profile+" playback cache is unavailable", true)
	}
}

func (s *Server) serveCachedHLSInitSection(w http.ResponseWriter, r *http.Request, profile *hlsEncodeProfile, source hlsPlaybackSource) error {
	relDir := hlsSessionRelativeDir(profile, source)
	relPath := path.Join(relDir, profile.segmentFormat().initSection)
	dir, err := safeCachePath(s.cfg.CacheRoot, relDir)
	if err != nil {
		return err
	}
	absolutePath := filepath.Join(dir, profile.segmentFormat().initSection)
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	releasePath, err := s.acquireCachePathLock(r.Context(), relPath)
	if err != nil {
		return err
	}
	defer releasePath()
	if !validCachedHLSSegment(absolutePath, hlsInitSectionMaximumBytes) {
		if err := s.writeHLSInitSection(r.Context(), profile, source, dir, absolutePath); err != nil {
			return err
		}
	}
	return serveCachedHLSSegment(w, r, absolutePath, profile.segmentFormat().contentType)
}

// writeHLSInitSection runs the init encode under a transcode slot and
// publishes its section at absolutePath. A failure is remembered like a remux
// that produced nothing, so playback info offers a transcode instead.
func (s *Server) writeHLSInitSection(ctx context.Context, profile *hlsEncodeProfile, source hlsPlaybackSource, dir string, absolutePath string) error {
	info, err := os.Stat(source.Path)
	if err != nil || !info.Mode().IsRegular() {
		return errHLSMediaNotFound
	}
	failureKey := mediaPreparationFailureKey(profile.name, source.Path, info)
	if s.mediaPreparationFailures.failedRecently(failureKey) {
		return fmt.Errorf("%w: preparation failed recently", errHLSTranscodeUnavailable)
	}
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		return fmt.Errorf("%w: ffmpeg executable was not found", errHLSTranscodeUnavailable)
	}
	releaseSlot, err := s.acquireRealtimeTranscode(ctx)
	if err != nil {
		return err
	}
	defer releaseSlot()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	runContext, cancel := context.WithTimeout(ctx, hlsInitSectionTimeout)
	defer cancel()
	command := exec.CommandContext(runContext, ffmpegPath, videoHEVCRemuxInitArgs(source.Path, dir, source.Keyframes)...)
	diagnostics := &transcodeDiagnosticOutput{}
	command.Stderr = diagnostics
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	defer removeHLSInitPartials(dir)
	if err := command.Start(); err != nil {
		return fmt.Errorf("%w: command failed to start", errHLSTranscodeUnavailable)
	}
	section, readErr := io.ReadAll(io.LimitReader(stdout, hlsInitSectionMaximumBytes+1))
	if readErr != nil || int64(len(section)) > hlsInitSectionMaximumBytes {
		cancel()
	}
	waitErr := command.Wait()
	if err := ctx.Err(); err != nil {
		return err
	}
	switch {
	case readErr != nil:
		err = fmt.Errorf("%w: initialization section was not read", errHLSTranscodeUnavailable)
	case int64(len(section)) > hlsInitSectionMaximumBytes:
		err = fmt.Errorf("%w: initialization section exceeded its byte limit", errHLSTranscodeUnavailable)
	case waitErr != nil:
		err = fmt.Errorf("%w: command failed: %s", errHLSTranscodeUnavailable, diagnostics.String())
	case !validHLSInitSection(section):
		err = fmt.Errorf("%w: initialization section is malformed", errHLSTranscodeUnavailable)
	}
	if err != nil {
		s.mediaPreparationFailures.remember(failureKey)
		return err
	}
	temporary := filepath.Join(dir, hlsInitSectionPartial+".part")
	if err := os.WriteFile(temporary, section, 0o644); err != nil {
		return err
	}
	return os.Rename(temporary, absolutePath)
}

// removeHLSInitPartials removes what an init encode left besides its section.
func removeHLSInitPartials(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasPrefix(entry.Name(), hlsInitSectionPartial) {
			_ = os.Remove(filepath.Join(dir, entry.Name()))
		}
	}
}
