package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestAudioPlaybackInfoDecidesFromTheProbedCodecNotTheExtension(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	dataRoot := t.TempDir()
	// FLAC named like an MP3, and MP3 named like a format no browser plays.
	files := []struct {
		id        int64
		name      string
		container string
		codec     string
	}{
		{id: 911, name: "flac-as.mp3", container: "flac", codec: "flac"},
		{id: 912, name: "mp3-as.wma", container: "mp3", codec: "libmp3lame"},
	}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (901, 'RJ00000000', 'Synthetic audio delivery');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (902, 'synthetic_local', 'Synthetic Local', 'local_folder');
	`); err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		relativePath := filepath.ToSlash(filepath.Join("RJ00000000", file.name))
		mediaPath := filepath.Join(dataRoot, filepath.FromSlash(relativePath))
		if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
			t.Fatal(err)
		}
		command := exec.Command(ffmpegPath, "-nostdin", "-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3",
			"-c:a", file.codec, "-f", file.container, "-y", mediaPath)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("create %s: %v (%s)", file.name, err, output)
		}
		if _, err := db.Exec(`
			INSERT INTO media_item (id, work_id, kind, title, fingerprint, duration_seconds, has_audio) VALUES (?, 901, 'audio', ?, ?, 3, 1)`,
			file.id+100, file.name, "synthetic-"+file.name); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`
			INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, duration_seconds)
			VALUES (?, ?, 902, 'local', ?, 'available', 3)`, file.id, file.id+100, relativePath); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir()})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })

	info := func(id string, query string) (int, videoPlaybackInfoResponse) {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/media/"+id+"/playback?profile=audio&"+query, nil)
		request.SetPathValue("id", id)
		response := httptest.NewRecorder()
		server.getMediaPlaybackInfo(response, request)
		var body videoPlaybackInfoResponse
		if response.Code == http.StatusOK {
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
		}
		return response.Code, body
	}
	const mp3Only = "capabilities=audio-mp3,audio-hls"
	const flacAndMP3 = "capabilities=audio-mp3,audio-flac,audio-hls"

	// The extension says MP3, the codec says FLAC: a client that only decodes
	// MP3 gets the HLS conversion, one that decodes FLAC the file itself.
	code, converted := info("911", mp3Only)
	if code != http.StatusOK || converted.Delivery != "hls" || converted.Conversion != "transcode" ||
		!strings.Contains(converted.URL, "/api/media/911/hls/index.m3u8?") || !strings.Contains(converted.URL, "profile=audio") ||
		!strings.Contains(converted.URL, "v=") || converted.DurationSeconds < 2.5 {
		t.Fatalf("FLAC named .mp3 for an MP3-only client = %d %+v", code, converted)
	}
	code, direct := info("911", flacAndMP3)
	if code != http.StatusOK || direct.Delivery != "direct" || direct.Conversion != "none" {
		t.Fatalf("FLAC named .mp3 for a FLAC client = %d %+v", code, direct)
	}
	directURL, err := url.Parse(direct.URL)
	if err != nil || directURL.Path != "/api/media/911/stream" || directURL.Query().Get("profile") != "audio" ||
		directURL.Query().Get("capabilities") != "audio-flac,audio-mp3" {
		t.Fatalf("direct URL = %q, %v", direct.URL, err)
	}

	// The extension no browser plays, over a file the browser decodes.
	if code, direct := info("912", mp3Only); code != http.StatusOK || direct.Delivery != "direct" {
		t.Fatalf("MP3 named .wma = %d %+v", code, direct)
	}

	// Compatibility mode converts a file the client could play directly.
	if code, forced := info("912", mp3Only+"&forceTranscode=1"); code != http.StatusOK || forced.Delivery != "hls" {
		t.Fatalf("compatibility with HLS = %d %+v", code, forced)
	}
	// A client without HLS gets one complete conversion, and the stream route
	// serves the same decision.
	code, prepared := info("912", "capabilities=audio-mp3&forceTranscode=1")
	if code != http.StatusOK || prepared.Delivery != "prepared" || prepared.Conversion != "transcode" ||
		!strings.Contains(prepared.URL, "forceTranscode=1") || !strings.Contains(prepared.URL, "profile=audio") {
		t.Fatalf("compatibility without HLS = %d %+v", code, prepared)
	}
	code, noCapabilities := info("911", "")
	if code != http.StatusOK || noCapabilities.Delivery != "prepared" {
		t.Fatalf("a client that declares nothing = %d %+v", code, noCapabilities)
	}

	for _, probe := range []struct {
		id     string
		query  string
		status int
	}{
		{"913", mp3Only, http.StatusNotFound},
		{"911", "profile=nonsense", http.StatusBadRequest},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/media/"+probe.id+"/playback?"+probe.query, nil)
		request.SetPathValue("id", probe.id)
		response := httptest.NewRecorder()
		server.getMediaPlaybackInfo(response, request)
		if response.Code != probe.status {
			t.Fatalf("%s?%s status = %d, want %d, body = %s", probe.id, probe.query, response.Code, probe.status, response.Body.String())
		}
	}
}
