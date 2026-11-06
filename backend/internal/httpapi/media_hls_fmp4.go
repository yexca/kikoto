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
	// A section is written beside its final name under this prefix and
	// renamed into place; the cache scan reclaims one left by a crash.
	hlsInitSectionPartialPrefix = ".hls-init-"
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
// and an empty segment and segment list into scratchDir.
func videoHEVCRemuxInitArgs(input string, scratchDir string, index *videoKeyframeIndex) []string {
	muxer := append([]string{"-t", "0"}, videoHEVCRemuxMuxerArgs("pipe:1")...)
	return videoRemuxFFmpegArgs(input, 0, index, videoRemuxOutput{
		muxer:   muxer,
		list:    filepath.Join(scratchDir, "init.list"),
		pattern: filepath.Join(strings.ReplaceAll(scratchDir, "%", "%%"), "init-%06d"),
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

// serveCachedHLSInitSection serves the revision's cached section, producing it
// first when none is cached. The init encode holds no transcode cache lock, so
// clearing the cache never waits for it; only storing the section does.
func (s *Server) serveCachedHLSInitSection(w http.ResponseWriter, r *http.Request, profile *hlsEncodeProfile, source hlsPlaybackSource) error {
	relDir := hlsSessionRelativeDir(profile, source)
	relPath := path.Join(relDir, profile.segmentFormat().initSection)
	dir, err := safeCachePath(s.cfg.CacheRoot, relDir)
	if err != nil {
		return err
	}
	absolutePath := filepath.Join(dir, profile.segmentFormat().initSection)
	// Concurrent requests for one section share its encode.
	releasePreparation, err := s.audioTranscodeLocks.acquire(r.Context(), absolutePath)
	if err != nil {
		return err
	}
	defer releasePreparation()
	if served, err := s.serveStoredHLSInitSection(w, r, profile, relPath, absolutePath, nil); served || err != nil {
		return err
	}
	section, err := s.encodeHLSInitSection(r.Context(), profile, source)
	if err != nil {
		return err
	}
	_, err = s.serveStoredHLSInitSection(w, r, profile, relPath, absolutePath, section)
	return err
}

// serveStoredHLSInitSection publishes section at absolutePath when it is given,
// then serves the cached section. It reports false when none is cached.
func (s *Server) serveStoredHLSInitSection(w http.ResponseWriter, r *http.Request, profile *hlsEncodeProfile, relPath string, absolutePath string, section []byte) (bool, error) {
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	releasePath, err := s.acquireCachePathLock(r.Context(), relPath)
	if err != nil {
		return false, err
	}
	defer releasePath()
	if section != nil {
		if err := publishHLSInitSection(absolutePath, section); err != nil {
			return false, err
		}
	}
	if !validCachedHLSSegment(absolutePath, hlsInitSectionMaximumBytes) {
		return false, nil
	}
	return true, serveCachedHLSSegment(w, r, absolutePath, profile.segmentFormat().contentType)
}

// publishHLSInitSection writes section beside absolutePath and renames it into
// place.
func publishHLSInitSection(absolutePath string, section []byte) error {
	dir := filepath.Dir(absolutePath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(dir, hlsInitSectionPartialPrefix+"*.part")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(temporary.Name()) }()
	_, writeErr := temporary.Write(section)
	closeErr := temporary.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return err
	}
	return os.Rename(temporary.Name(), absolutePath)
}

// encodeHLSInitSection runs the init encode under a transcode slot and returns
// its section. A failure is remembered like a remux that produced nothing, so
// playback info offers a transcode instead.
func (s *Server) encodeHLSInitSection(ctx context.Context, profile *hlsEncodeProfile, source hlsPlaybackSource) ([]byte, error) {
	info, err := os.Stat(source.Path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errHLSMediaNotFound
	}
	failureKey := mediaPreparationFailureKey(profile.name, source.Path, info)
	if s.mediaPreparationFailures.failedRecently(failureKey) {
		return nil, fmt.Errorf("%w: preparation failed recently", errHLSTranscodeUnavailable)
	}
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, fmt.Errorf("%w: ffmpeg executable was not found", errHLSTranscodeUnavailable)
	}
	releaseSlot, err := s.acquireRealtimeTranscode(ctx)
	if err != nil {
		return nil, err
	}
	defer releaseSlot()
	// The empty segment and list the encode also writes stay out of the cache.
	scratch, err := os.MkdirTemp("", "kikoto-hls-init-*")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(scratch) }()
	runContext, cancel := context.WithTimeout(ctx, hlsInitSectionTimeout)
	defer cancel()
	command := exec.CommandContext(runContext, ffmpegPath, withVideoAudioTrack(videoHEVCRemuxInitArgs(source.Path, scratch, source.Keyframes), source.AudioTrack)...)
	diagnostics := &transcodeDiagnosticOutput{}
	command.Stderr = diagnostics
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("%w: command failed to start", errHLSTranscodeUnavailable)
	}
	section, readErr := io.ReadAll(io.LimitReader(stdout, hlsInitSectionMaximumBytes+1))
	if readErr != nil || int64(len(section)) > hlsInitSectionMaximumBytes {
		cancel()
	}
	waitErr := command.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
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
		return nil, err
	}
	return section, nil
}
