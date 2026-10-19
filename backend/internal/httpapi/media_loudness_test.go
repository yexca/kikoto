package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

const syntheticLoudnessSummary = `[Parsed_ebur128_0 @ 0000000000000000] t: 2.9 TARGET:-23 LUFS M: -33.9 S: -33.8 I: -33.8 LUFS LRA: 0.0 LU
[Parsed_ebur128_0 @ 0000000000000000] Summary:

  Integrated loudness:
    I:         -19.4 LUFS
    Threshold: -29.6 LUFS

  Loudness range:
    LRA:         6.1 LU

  True peak:
    Peak:       -0.6 dBFS
`

func TestLoudnessSummaryParsing(t *testing.T) {
	got, ok := parseLoudnessSummary(syntheticLoudnessSummary, "true")
	if !ok || got != (mediaLoudnessDetail{IntegratedLUFS: -19.4, PeakDBFS: -0.6, PeakKind: "true"}) {
		t.Fatalf("summary = %+v, %v", got, ok)
	}
	silent := strings.NewReplacer("-19.4 LUFS", "-inf LUFS", "-0.6 dBFS", "-inf dBFS", "True peak", "Sample peak").Replace(syntheticLoudnessSummary)
	got, ok = parseLoudnessSummary(silent, "sample")
	if !ok || got.IntegratedLUFS != -70 || got.PeakKind != "sample" {
		t.Fatalf("silent summary = %+v, %v", got, ok)
	}
	for _, output := range []string{"", "Summary:\n  Integrated loudness:\n", "I: -19 LUFS\nPeak: -1 dBFS\n"} {
		if _, ok := parseLoudnessSummary(output, "true"); ok {
			t.Fatalf("parsed loudness from %q", output)
		}
	}
}

func TestLoudnessStderrBufferKeepsOnlyTheTail(t *testing.T) {
	buffer := &tailBuffer{limit: 16}
	for range 100 {
		if _, err := buffer.Write([]byte("frame line......\n")); err != nil {
			t.Fatal(err)
		}
	}
	_, _ = buffer.Write([]byte("Summary: end"))
	if got := buffer.String(); len(got) != 16 || !strings.HasSuffix(got, "Summary: end") {
		t.Fatalf("tail = %q", got)
	}
	if cap(buffer.data) > 64 {
		t.Fatalf("buffer grew to %d bytes", cap(buffer.data))
	}
}

func TestMediaPreparationFailuresExpireAndFollowTheFileRevision(t *testing.T) {
	path := filepath.Join(t.TempDir(), "RJ00000041.wav")
	if err := os.WriteFile(path, []byte("not audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	var failures mediaPreparationFailures
	key := mediaPreparationFailureKey("audio-transcode", path, info)
	failures.remember(key)
	if !failures.failedRecently(key) {
		t.Fatal("a failure was not remembered")
	}
	changed := info.ModTime().Add(time.Second)
	if err := os.Chtimes(path, changed, changed); err != nil {
		t.Fatal(err)
	}
	changedInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if failures.failedRecently(mediaPreparationFailureKey("audio-transcode", path, changedInfo)) {
		t.Fatal("a changed file inherited the failure of its earlier revision")
	}
	failures.expires[key] = time.Now().Add(-time.Millisecond)
	if failures.failedRecently(key) {
		t.Fatal("an expired failure was still answered from memory")
	}
	for index := range mediaPreparationFailureLimit + 10 {
		failures.remember(key + string(rune('a'+index%26)) + string(rune(index)))
	}
	if len(failures.expires) > mediaPreparationFailureLimit {
		t.Fatalf("remembered %d failures", len(failures.expires))
	}
}

func TestCompatibleAudioRemembersAFailedTranscode(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	input := filepath.Join(server.cfg.DataRoot, "RJ00000042.wma")
	if err := os.WriteFile(input, []byte("synthetic bytes that are not audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.openCompatibleAudio(context.Background(), input, info); !errors.Is(err, errAudioTranscodeUnavailable) {
		t.Fatalf("first transcode = %v", err)
	}
	// The second request is answered from memory without taking an encode slot.
	slots, _ := server.realtimeResourceChannels(realtimeResourceTranscode)
	for range cap(slots) {
		slots <- struct{}{}
	}
	if _, err := server.openCompatibleAudio(context.Background(), input, info); !errors.Is(err, errAudioTranscodeUnavailable) || !strings.Contains(err.Error(), "recently") {
		t.Fatalf("repeated transcode = %v, want the remembered failure", err)
	}
}

func TestMediaLoudnessIsMeasuredOncePerFileVersion(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	s := newLocalProbeTestServer(t, 1)
	path := filepath.Join(s.cfg.DataRoot, "RJ00000000", "track-1.mp3")
	if err := os.WriteFile(path, testWAVBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// The index still records the earlier file version, and playback
	// conversion holds every transcode slot.
	slots, _ := s.realtimeResourceChannels(realtimeResourceTranscode)
	for range cap(slots) {
		slots <- struct{}{}
	}
	get := func() (int, mediaLoudnessDetail) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/media/1/loudness", nil)
		request.SetPathValue("id", "1")
		response := httptest.NewRecorder()
		s.getMediaLoudness(response, request)
		var loudness mediaLoudnessDetail
		if response.Code == http.StatusOK {
			if err := json.Unmarshal(response.Body.Bytes(), &loudness); err != nil {
				t.Fatal(err)
			}
		}
		return response.Code, loudness
	}
	status, measured := get()
	if status != http.StatusOK || measured.PeakKind != "true" || measured.IntegratedLUFS >= 0 || measured.IntegratedLUFS < -70 {
		t.Fatalf("measurement = %d %+v", status, measured)
	}
	// A stored value is returned without FFmpeg.
	searchPath := os.Getenv("PATH")
	t.Setenv("PATH", "")
	if status, stored := get(); status != http.StatusOK || stored != measured {
		t.Fatalf("stored measurement = %d %+v, want %+v", status, stored, measured)
	}

	scan := func(info os.FileInfo) {
		t.Helper()
		tx, err := s.db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := upsertDetectedLocation(context.Background(), tx, 1, 1, localfs.LocalFile{
			RelPath: "RJ00000000/track-1.mp3", SizeBytes: info.Size(), FileVersion: localfs.FileVersion(info),
		}); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	// A scan that records the measured version keeps the measurement.
	scan(info)
	if status, stored := get(); status != http.StatusOK || stored != measured {
		t.Fatalf("measurement after the scan = %d %+v, want %+v", status, stored, measured)
	}

	// A scan that records a new file version drops the measurement.
	changed := info.ModTime().Add(time.Second)
	if err := os.Chtimes(path, changed, changed); err != nil {
		t.Fatal(err)
	}
	changedInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	scan(changedInfo)
	var version *string
	if err := s.db.QueryRow("SELECT loudness_version FROM media_file_location WHERE id = 1").Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != nil {
		t.Fatalf("loudness_version = %q after the file changed", *version)
	}
	if status, _ := get(); status != http.StatusServiceUnavailable {
		t.Fatalf("measurement without FFmpeg = %d, want 503", status)
	}
	// The failure is remembered for this version, so the next play does not
	// measure again even once FFmpeg could run.
	t.Setenv("PATH", searchPath)
	if status, _ := get(); status != http.StatusServiceUnavailable {
		t.Fatalf("measurement after a failure = %d, want the remembered 503", status)
	}
	key := mediaPreparationFailureKey("loudness", path, changedInfo)
	if expires := s.mediaPreparationFailures.expires[key]; time.Until(expires) <= mediaPreparationFailureTTL {
		t.Fatalf("loudness failure expires in %s, want longer than a transcode failure", time.Until(expires))
	}
}
