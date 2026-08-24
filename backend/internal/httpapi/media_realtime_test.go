package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestDirectPlaybackContentTypeRequiresMatchingContainerCodecAndCapability(t *testing.T) {
	probe := playbackProbe{
		Format: playbackProbeFormat{FormatName: "mov,mp4,m4a"},
		Streams: []playbackProbeStream{
			{CodecType: "video", CodecName: "h264", PixelFmt: "yuv420p"},
			{CodecType: "audio", CodecName: "aac"},
		},
	}
	if contentType, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{capVideoMP4H264AAC: true}); !ok || contentType != "video/mp4" {
		t.Fatalf("compatible MP4 direct result = %q/%t", contentType, ok)
	}
	if _, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{}); ok {
		t.Fatal("direct playback should require an explicit browser capability")
	}
	probe.Format.FormatName = "avi"
	if _, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{capVideoMP4H264AAC: true}); ok {
		t.Fatal("AVI should be transcoded even when its video codec is H264")
	}
	probe.Format.FormatName = "mov,mp4,m4a"
	probe.Streams[1].CodecName = "eac3"
	if _, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{capVideoMP4H264AAC: true}); ok {
		t.Fatal("unsupported audio codec should be transcoded")
	}
}

func TestServeAutomaticLocalPlaybackTranscodesToResponseWithoutCache(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	path := filepath.Join(dataRoot, "track.wav")
	if err := os.WriteFile(path, testWAVBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{CacheRoot: cacheRoot})
	target := mediaStreamTarget{Kind: "audio", RelativePath: "track.wav"}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio", nil)
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, target, path)
	if response.Code != http.StatusOK || len(response.Body.Bytes()) < 3 || string(response.Body.Bytes()[:3]) != "ID3" {
		t.Fatalf("transcoded response = %d, %d bytes, prefix %q", response.Code, response.Body.Len(), response.Body.String())
	}
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("realtime playback created cache entries: %v", entries)
	}
}

func TestServeAutomaticLocalPlaybackTranscodesAVI(t *testing.T) {
	ffmpegPath, ffmpegErr := exec.LookPath("ffmpeg")
	if ffmpegErr != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	aviPath := filepath.Join(dataRoot, "clip.avi")
	command := exec.Command(ffmpegPath,
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=blue:s=32x32:r=2",
		"-t", "1", "-c:v", "mpeg4", "-y", aviPath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create AVI fixture: %v (%s)", err, output)
	}
	server := NewServer(nil, config.Config{CacheRoot: cacheRoot})
	target := mediaStreamTarget{Kind: "video", RelativePath: "clip.avi"}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=video", nil)
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, target, aviPath)
	if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte("ftyp")) {
		t.Fatalf("AVI transcode response = %d, %d bytes", response.Code, response.Body.Len())
	}
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("AVI realtime playback created cache entries: %v", entries)
	}
}

func TestStreamRemoteSourceMediaTranscodesThroughSourcePolicy(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/media/track.wav" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(testWAVBytes())
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	key := remoteWorkCacheKey(7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: upstream.URL + "/media/track.wav"}}
	server.remoteWorkTracksCache[key] = snapshot
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	response := httptest.NewRecorder()
	server.streamRemoteSourceMedia(response, request)
	if response.Code != http.StatusOK || len(response.Body.Bytes()) < 3 || string(response.Body.Bytes()[:3]) != "ID3" {
		t.Fatalf("remote transcode response = %d, %d bytes", response.Code, response.Body.Len())
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Accept-Ranges") != "none" {
		t.Fatalf("remote transcode headers = %#v", response.Header())
	}
}

func TestStreamRemoteSourceMediaRejectsUnconfiguredOrigin(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests++
		_, _ = w.Write(testWAVBytes())
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	key := remoteWorkCacheKey(7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: "https://media.invalid/track.wav"}}
	server.remoteWorkTracksCache[key] = snapshot
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	response := httptest.NewRecorder()
	server.streamRemoteSourceMedia(response, request)
	if response.Code != http.StatusBadGateway || upstreamRequests != 0 {
		t.Fatalf("blocked remote status/requests = %d/%d", response.Code, upstreamRequests)
	}
}

func TestStreamRemoteSourceMediaRejectsOversizedResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.FormatInt((int64(defaultRemoteDownloadLimitGB)<<30)+1, 10))
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	key := remoteWorkCacheKey(7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: upstream.URL + "/media/track.wav"}}
	server.remoteWorkTracksCache[key] = snapshot
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	response := httptest.NewRecorder()
	server.streamRemoteSourceMedia(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized remote status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestStreamFFmpegReaderHonorsCanceledRequest(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/media", nil).WithContext(ctx)
	response := httptest.NewRecorder()
	server := NewServer(nil, config.Config{})
	done := make(chan struct{})
	go func() {
		_ = server.streamFFmpegReader(response, request, bytes.NewReader(testWAVBytes()), playbackProfileAudio, 1<<20)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("canceled realtime transcode did not return")
	}
}

func TestServeAutomaticLocalPlaybackDirectSupportsRanges(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	path := filepath.Join(t.TempDir(), "track.wav")
	source := testWAVBytes()
	if err := os.WriteFile(path, source, 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{})
	target := mediaStreamTarget{Kind: "audio", RelativePath: "track.wav"}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&capabilities=audio-wav", nil)
	request.Header.Set("Range", "bytes=44-51")
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, target, path)
	if response.Code != http.StatusPartialContent || response.Body.String() != string(source[44:52]) {
		t.Fatalf("direct range response = %d/%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("direct range Accept-Ranges = %q", response.Header().Get("Accept-Ranges"))
	}
}

func testWAVBytes() []byte {
	const sampleRate = 8000
	const sampleCount = 800
	dataSize := sampleCount * 2
	result := make([]byte, 44+dataSize)
	copy(result[0:4], "RIFF")
	binary.LittleEndian.PutUint32(result[4:8], uint32(36+dataSize))
	copy(result[8:12], "WAVE")
	copy(result[12:16], "fmt ")
	binary.LittleEndian.PutUint32(result[16:20], 16)
	binary.LittleEndian.PutUint16(result[20:22], 1)
	binary.LittleEndian.PutUint16(result[22:24], 1)
	binary.LittleEndian.PutUint32(result[24:28], sampleRate)
	binary.LittleEndian.PutUint32(result[28:32], sampleRate*2)
	binary.LittleEndian.PutUint16(result[32:34], 2)
	binary.LittleEndian.PutUint16(result[34:36], 16)
	copy(result[36:40], "data")
	binary.LittleEndian.PutUint32(result[40:44], uint32(dataSize))
	return result
}
