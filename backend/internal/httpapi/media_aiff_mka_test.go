package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLocalAndRemoteMediaKindsRecognizeAIFFAndMatroskaAudio(t *testing.T) {
	for _, path := range []string{"track.aiff", "track.AIF", "track.mka"} {
		if got := localFileKind(path); got != "audio" {
			t.Fatalf("localFileKind(%q) = %q, want audio", path, got)
		}
		if got := remoteTrackKindForPath("file", "disc/"+path); got != "audio" {
			t.Fatalf("remote kind of %q = %q, want audio", path, got)
		}
	}
	if got := localFileKind("clip.mkv"); got != "video" {
		t.Fatalf("localFileKind(clip.mkv) = %q, want video", got)
	}
	response := &http.Response{Header: http.Header{"Content-Type": []string{"application/octet-stream"}}}
	for path, want := range map[string]string{"track.aiff": "audio/aiff", "track.aif": "audio/aiff", "track.mka": "audio/x-matroska"} {
		if got := remotePlaybackContentType(response, path); got != want {
			t.Fatalf("content type for %q = %q, want %q", path, got, want)
		}
	}
	if !newLyricsCandidateName("work/01_abc.aiff.lrc").matches(newLyricsTrackName("work/01_abc.aiff")) {
		t.Fatal("a sidecar that keeps the AIFF extension did not match its track")
	}
	if !newLyricsCandidateName("work/subs/01_abc.mka.vtt").matches(newLyricsTrackName("work/01_abc.mka")) {
		t.Fatal("a Matroska audio sidecar in another folder did not match its track")
	}
}

// Browsers do not play AIFF or Matroska audio by extension, so these files
// get their duration from FFprobe and play through compatibility conversion.
func TestAIFFAndMatroskaAudioProbeAndPlayThroughConversion(t *testing.T) {
	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not installed", tool)
		}
	}
	dataRoot := t.TempDir()
	server := NewServer(nil, config.Config{CacheRoot: t.TempDir()})
	for _, name := range []string{"RJ00000043.aiff", "RJ00000044.mka"} {
		path := filepath.Join(dataRoot, name)
		command := exec.Command("ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
			"-f", "lavfi", "-i", "sine=frequency=440:duration=2", path)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("synthesize %s: %v %s", name, err, output)
		}
		duration, hasAudio, err := server.probeMediaMetadata(context.Background(), path)
		if err != nil || duration != 2 || !hasAudio {
			t.Fatalf("probe %s = %d, %v, %v", name, duration, hasAudio, err)
		}
		if _, direct := fallbackDirectPlaybackContentType(path, playbackProfileAudio); direct {
			t.Fatalf("%s is served directly by extension", name)
		}
		request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&forceDirect=1", nil)
		response := httptest.NewRecorder()
		server.serveAutomaticLocalPlayback(response, request, mediaStreamTarget{Kind: localFileKind(name), RelativePath: name}, path)
		if response.Code != http.StatusOK || response.Header().Get("X-Kikoto-Playback-Delivery") != "transcoded" ||
			response.Header().Get("Content-Type") != "audio/mpeg" {
			t.Fatalf("%s playback = %d %#v", name, response.Code, response.Header())
		}
	}
}
