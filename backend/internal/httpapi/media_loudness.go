package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

const (
	// A measurement decodes the whole file once, much faster than real time.
	// It shares the transcode slots and their bound on wall time.
	loudnessMeasureTimeout = audioTranscodeTimeout
	// FFmpeg prints the summary last; only this much of stderr is kept.
	loudnessStderrTailLimit = 16 << 10
)

var errLoudnessUnavailable = errors.New("media loudness is unavailable")

// mediaLoudnessDetail is the integrated loudness (EBU R 128) and peak level of
// one file version. PeakKind is "true" for a true peak, or "sample" when only
// the sample peak could be measured.
type mediaLoudnessDetail struct {
	IntegratedLUFS float64 `json:"integratedLufs"`
	PeakDBFS       float64 `json:"peakDbfs"`
	PeakKind       string  `json:"peakKind"`
}

func mediaLoudnessFromColumns(integrated, peak sql.NullFloat64, kind sql.NullString) *mediaLoudnessDetail {
	if !integrated.Valid || !peak.Valid || !kind.Valid {
		return nil
	}
	return &mediaLoudnessDetail{IntegratedLUFS: integrated.Float64, PeakDBFS: peak.Float64, PeakKind: kind.String}
}

// getMediaLoudness returns a local location's loudness, measuring it first
// when its current file version has none. Playback asks for it only when the
// listener turned loudness normalization on.
func (s *Server) getMediaLoudness(w http.ResponseWriter, r *http.Request) {
	locationID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	target, _, err := s.loadMediaStreamTarget(r.Context(), locationID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media location not found"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	kind := effectiveMediaKind(target.Kind, target.RelativePath)
	if target.LocationType != "local" || target.Availability != "available" || (kind != "audio" && kind != "video") {
		writeAPIError(w, http.StatusNotFound, "media_loudness_unavailable", "loudness is only measured for local audio and video", false)
		return
	}
	if err := s.ensureMediaLocationReadable(r.Context(), target.LocationType, target.RelativePath); err != nil {
		writeError(w, err)
		return
	}
	path, err := safeDataPath(s.cfg.DataRoot, target.RelativePath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media path"})
		return
	}
	loudness, err := s.mediaLoudness(r.Context(), locationID, path)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, loudness)
	case r.Context().Err() != nil:
		// The listener went away; nobody reads the answer.
	case errors.Is(err, errRealtimeResourceBusy):
		w.Header().Set("Retry-After", "1")
		writeAPIError(w, http.StatusServiceUnavailable, "media_loudness_busy", "loudness measurement is temporarily busy", true)
	case errors.Is(err, os.ErrNotExist):
		writeAPIError(w, http.StatusNotFound, "media_not_found", "media file was not found", false)
	default:
		slog.Warn("media loudness measurement failed", "location_id", locationID, "error", err)
		writeAPIError(w, http.StatusServiceUnavailable, "media_loudness_unavailable", "loudness could not be measured", true)
	}
}

// mediaLoudness returns the stored loudness of the location's current file
// version, or measures and stores it. Concurrent requests for one file share a
// measurement, and a failed one is answered from memory for a short time.
func (s *Server) mediaLoudness(ctx context.Context, locationID int64, path string) (mediaLoudnessDetail, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return mediaLoudnessDetail{}, os.ErrNotExist
	}
	version := localfs.FileVersion(info)
	if stored, ok, err := s.storedMediaLoudness(ctx, locationID, version); err != nil || ok {
		return stored, err
	}
	if s.cfg.IsDemo() {
		return mediaLoudnessDetail{}, fmt.Errorf("%w: demo mode measures nothing", errLoudnessUnavailable)
	}
	failureKey := mediaPreparationFailureKey("loudness", path, info)
	if s.mediaPreparationFailures.failedRecently(failureKey) {
		return mediaLoudnessDetail{}, fmt.Errorf("%w: measurement failed recently", errLoudnessUnavailable)
	}
	release, err := s.audioTranscodeLocks.acquire(ctx, "loudness:"+path)
	if err != nil {
		return mediaLoudnessDetail{}, err
	}
	defer release()
	if stored, ok, err := s.storedMediaLoudness(ctx, locationID, version); err != nil || ok {
		return stored, err
	}
	loudness, err := s.measureMediaLoudness(ctx, path)
	if err != nil {
		if errors.Is(err, errLoudnessUnavailable) && ctx.Err() == nil {
			s.mediaPreparationFailures.remember(failureKey)
		}
		return mediaLoudnessDetail{}, err
	}
	after, err := os.Stat(path)
	if err != nil || !os.SameFile(info, after) || localfs.FileVersion(after) != version {
		return mediaLoudnessDetail{}, fmt.Errorf("%w: the file changed during measurement", errLoudnessUnavailable)
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET loudness_version = ?, loudness_integrated_lufs = ?, loudness_peak_dbfs = ?, loudness_peak_kind = ?
		WHERE id = ? AND location_type = 'local' AND file_version = ?
	`, version, loudness.IntegratedLUFS, loudness.PeakDBFS, loudness.PeakKind, locationID, version); err != nil {
		return mediaLoudnessDetail{}, err
	}
	return loudness, nil
}

func (s *Server) storedMediaLoudness(ctx context.Context, locationID int64, version string) (mediaLoudnessDetail, bool, error) {
	var integrated, peak sql.NullFloat64
	var kind sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT loudness_integrated_lufs, loudness_peak_dbfs, loudness_peak_kind
		FROM media_file_location
		WHERE id = ? AND file_version = ? AND loudness_version = file_version
	`, locationID, version).Scan(&integrated, &peak, &kind)
	if errors.Is(err, sql.ErrNoRows) {
		return mediaLoudnessDetail{}, false, nil
	}
	if err != nil {
		return mediaLoudnessDetail{}, false, err
	}
	loudness := mediaLoudnessFromColumns(integrated, peak, kind)
	if loudness == nil {
		return mediaLoudnessDetail{}, false, nil
	}
	return *loudness, true, nil
}

// measureMediaLoudness runs FFmpeg's EBU R 128 filter over the first audio
// stream. It asks for the true peak and falls back to the sample peak when the
// true peak cannot be measured.
func (s *Server) measureMediaLoudness(ctx context.Context, path string) (mediaLoudnessDetail, error) {
	measureContext, cancel := context.WithTimeout(ctx, loudnessMeasureTimeout)
	defer cancel()
	release, err := s.acquireRealtimeTranscode(measureContext)
	if err != nil {
		return mediaLoudnessDetail{}, err
	}
	defer release()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return mediaLoudnessDetail{}, fmt.Errorf("%w: ffmpeg executable was not found", errLoudnessUnavailable)
	}
	var failure error
	for _, peakKind := range []string{"true", "sample"} {
		stderr := &tailBuffer{limit: loudnessStderrTailLimit}
		command := exec.CommandContext(measureContext, ffmpeg, loudnessFFmpegArgs(path, peakKind)...)
		command.Stdout = io.Discard
		command.Stderr = stderr
		runErr := command.Run()
		if err := measureContext.Err(); err != nil {
			if parentErr := ctx.Err(); parentErr != nil {
				return mediaLoudnessDetail{}, parentErr
			}
			return mediaLoudnessDetail{}, fmt.Errorf("measurement timed out: %w", err)
		}
		if runErr == nil {
			if loudness, ok := parseLoudnessSummary(stderr.String(), peakKind); ok {
				return loudness, nil
			}
		}
		failure = fmt.Errorf("%w: %s peak measurement failed: %v", errLoudnessUnavailable, peakKind, runErr)
	}
	return mediaLoudnessDetail{}, failure
}

func loudnessFFmpegArgs(input string, peakKind string) []string {
	return []string{
		"-nostdin", "-hide_banner", "-nostats", "-loglevel", "info",
		"-threads", "1", "-filter_threads", "1", "-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe", "-i", input,
		"-map", "0:a:0", "-vn", "-sn", "-dn",
		// framelog=verbose keeps the per-frame lines out of the info log; the
		// summary is still printed.
		"-af", "ebur128=peak=" + peakKind + ":framelog=verbose",
		"-f", "null", "-",
	}
}

var (
	loudnessIntegratedPattern = regexp.MustCompile(`(?m)^\s*I:\s+(-?[0-9]+(?:\.[0-9]+)?|-inf)\s+LUFS`)
	loudnessPeakPattern       = regexp.MustCompile(`(?m)^\s*Peak:\s+(-?[0-9]+(?:\.[0-9]+)?|-inf)\s+dBFS`)
)

// parseLoudnessSummary reads the integrated loudness and peak from the last
// summary FFmpeg's ebur128 filter printed. Silence measures as -inf and is
// reported at the filter's floor of -70 LUFS.
func parseLoudnessSummary(output string, peakKind string) (mediaLoudnessDetail, bool) {
	index := strings.LastIndex(output, "Summary:")
	if index < 0 {
		return mediaLoudnessDetail{}, false
	}
	summary := output[index:]
	integratedMatch := loudnessIntegratedPattern.FindStringSubmatch(summary)
	peakMatch := loudnessPeakPattern.FindStringSubmatch(summary)
	if integratedMatch == nil || peakMatch == nil {
		return mediaLoudnessDetail{}, false
	}
	integrated, ok := parseLoudnessValue(integratedMatch[1], -70)
	if !ok {
		return mediaLoudnessDetail{}, false
	}
	peak, ok := parseLoudnessValue(peakMatch[1], -144)
	if !ok {
		return mediaLoudnessDetail{}, false
	}
	return mediaLoudnessDetail{IntegratedLUFS: integrated, PeakDBFS: peak, PeakKind: peakKind}, true
}

func parseLoudnessValue(value string, floor float64) (float64, bool) {
	if value == "-inf" {
		return floor, true
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return math.Max(parsed, floor), true
}

// tailBuffer keeps the last limit bytes written to it, using at most twice
// that much memory, so stderr cannot grow without bound.
type tailBuffer struct {
	limit int
	data  []byte
}

func (buffer *tailBuffer) Write(value []byte) (int, error) {
	count := len(value)
	if len(value) > buffer.limit {
		value = value[len(value)-buffer.limit:]
	}
	buffer.data = append(buffer.data, value...)
	if len(buffer.data) > 2*buffer.limit {
		buffer.data = append(buffer.data[:0], buffer.data[len(buffer.data)-buffer.limit:]...)
	}
	return count, nil
}

func (buffer *tailBuffer) String() string {
	if len(buffer.data) > buffer.limit {
		return string(buffer.data[len(buffer.data)-buffer.limit:])
	}
	return string(buffer.data)
}
