package httpapi

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func createSyntheticAAC(t *testing.T, duration string) string {
	t.Helper()
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	input := filepath.Join(t.TempDir(), "track.aac")
	command := exec.Command(ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", duration, "-c:a", "aac", "-f", "adts", input)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create synthetic AAC: %v (%s)", err, output)
	}
	return input
}

// Raw AAC used to return an open-ended MP3 pipe with no duration or Range
// contract. HEAD must now prepare the same complete, seekable file as GET.
func TestCompatibleAACHasDurationRangesAndReusableCompleteCache(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	input := createSyntheticAAC(t, "2")
	original, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	inputInfo, err := os.Stat(input)
	if err != nil {
		t.Fatal(err)
	}
	cacheRoot := t.TempDir()
	server := NewServer(nil, config.Config{CacheRoot: cacheRoot})
	target := mediaStreamTarget{Kind: "audio", RelativePath: "track.aac"}
	head := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(head, httptest.NewRequest(http.MethodHead, "/api/media/1/stream?profile=audio&forceDirect=1", nil), target, input)
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Type") != "audio/mpeg" || head.Header().Get("Accept-Ranges") != "bytes" || head.Header().Get("X-Kikoto-Playback-Delivery") != "transcoded" {
		t.Fatalf("compatible HEAD = %d / %#v / %d bytes", head.Code, head.Header(), head.Body.Len())
	}
	outputPath := filepath.Join(cacheRoot, filepath.FromSlash(audioTranscodeCachePath(input, inputInfo)))
	encoded, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	if head.Header().Get("Content-Length") != strconv.Itoa(len(encoded)) || (!bytes.Contains(encoded, []byte("Xing")) && !bytes.Contains(encoded, []byte("Info"))) {
		t.Fatalf("compatible MP3 has no complete length/Xing index: %#v", head.Header())
	}
	probe, err := server.probePlaybackFile(context.Background(), outputPath)
	if err != nil {
		t.Fatal(err)
	}
	duration, err := strconv.ParseFloat(probe.Format.Duration, 64)
	if err != nil || duration < 2 || duration > 2.2 {
		t.Fatalf("complete AAC conversion duration = %q (%v)", probe.Format.Duration, err)
	}
	before, err := os.Stat(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	// Once prepared, even a deployment whose encoder disappears can serve the
	// entire cached file, including its final bytes, without starting FFmpeg.
	t.Setenv("PATH", t.TempDir())
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&forceDirect=1", nil)
	request.Header.Set("Range", "bytes=100-199")
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, target, input)
	if response.Code != http.StatusPartialContent || !bytes.Equal(response.Body.Bytes(), encoded[100:200]) {
		t.Fatalf("compatible range response = %d / %d bytes", response.Code, response.Body.Len())
	}
	endRequest := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&forceDirect=1", nil)
	endRequest.Header.Set("Range", "bytes=-100")
	endResponse := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(endResponse, endRequest, target, input)
	if endResponse.Code != http.StatusPartialContent || !bytes.Equal(endResponse.Body.Bytes(), encoded[len(encoded)-100:]) {
		t.Fatalf("compatible end range = %d / %d bytes", endResponse.Code, endResponse.Body.Len())
	}
	after, err := os.Stat(outputPath)
	if err != nil || !before.ModTime().Equal(after.ModTime()) {
		t.Fatalf("range request did not reuse completed cache: %v", err)
	}
	unchanged, err := os.ReadFile(input)
	if err != nil || !bytes.Equal(unchanged, original) {
		t.Fatalf("compatible playback changed original media: %v", err)
	}
	changed := inputInfo.ModTime().Add(time.Second)
	if err := os.Chtimes(input, changed, changed); err != nil {
		t.Fatal(err)
	}
	changedInfo, err := os.Stat(input)
	if err != nil {
		t.Fatal(err)
	}
	if audioTranscodeCachePath(input, changedInfo) == audioTranscodeCachePath(input, inputInfo) {
		t.Fatal("changed source reuses stale audio cache")
	}
}

func TestConcurrentCompatibleAudioRequestsShareOneCompleteFile(t *testing.T) {
	input := createSyntheticAAC(t, "2")
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, '1')`, transcodeCacheLimitSetting); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	// Leave room for just one encoder. Duplicate requests must join it rather
	// than consume another full-file quota reservation and fail with 507.
	releaseOther, err := server.reserveTranscodeCache(context.Background(), audioTranscodeMaximumBytes)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseOther()
	var group sync.WaitGroup
	responses := make([]*httptest.ResponseRecorder, 4)
	for index := range responses {
		group.Add(1)
		go func() {
			defer group.Done()
			responses[index] = httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&forceDirect=1", nil)
			server.serveAutomaticLocalPlayback(responses[index], request, mediaStreamTarget{Kind: "audio"}, input)
		}()
	}
	group.Wait()
	for _, response := range responses {
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), responses[0].Body.Bytes()) {
			t.Fatalf("concurrent preparation = %d / %s", response.Code, response.Body.String())
		}
	}
	entries, err := os.ReadDir(filepath.Join(cacheRoot, "transcodes", "audio"))
	if err != nil || len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".mp3") {
		t.Fatalf("concurrent playback left duplicate or partial cache: %v, %v", entries, err)
	}
	if server.transcodeCacheReservedBytes != audioTranscodeMaximumBytes {
		t.Fatalf("audio reservation leaked: %d", server.transcodeCacheReservedBytes)
	}
}

func TestTranscodeDiagnosticsRemainBoundedWhileDrainingOutput(t *testing.T) {
	diagnostics := &transcodeDiagnosticOutput{}
	value := bytes.Repeat([]byte("synthetic decoder failure\n"), transcodeDiagnosticLimit)
	for range 3 {
		if count, err := diagnostics.Write(value); err != nil || count != len(value) {
			t.Fatalf("stderr was not drained: %d / %v", count, err)
		}
	}
	if diagnostics.buffer.Len() != transcodeDiagnosticLimit {
		t.Fatalf("retained stderr size = %d", diagnostics.buffer.Len())
	}
}

func TestCompatibleAudioNeverPublishesTruncatedOrCancelledOutput(t *testing.T) {
	input := createSyntheticAAC(t, "30")
	info, err := os.Stat(input)
	if err != nil {
		t.Fatal(err)
	}
	outputRoot := t.TempDir()
	output := filepath.Join(outputRoot, "track.mp3")
	server := NewServer(nil, config.Config{})
	if err := server.generateCompatibleAudio(context.Background(), input, info, output, 96<<10); !errors.Is(err, errAudioTranscodeUnavailable) {
		t.Fatalf("oversized conversion error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := server.generateCompatibleAudio(ctx, input, info, output, audioTranscodeMaximumBytes); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled conversion error = %v", err)
	}
	entries, err := os.ReadDir(outputRoot)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed conversion published a partial file: %v, %v", entries, err)
	}
}

func TestCompatibleAudioFailureIdentifiesAlreadyTranscodedDelivery(t *testing.T) {
	input := filepath.Join(t.TempDir(), "track.aac")
	if err := os.WriteFile(input, []byte("synthetic invalid audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{CacheRoot: t.TempDir()})
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodHead, "/api/media/1/stream?profile=audio&forceDirect=1", nil)
	server.serveAutomaticLocalPlayback(response, request, mediaStreamTarget{Kind: "audio"}, input)
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("X-Kikoto-Playback-Delivery") != "transcoded" || !strings.Contains(response.Body.String(), "media_transcode_unavailable") {
		t.Fatalf("failed preparation does not identify conversion: %d / %#v / %s", response.Code, response.Header(), response.Body.String())
	}
}
