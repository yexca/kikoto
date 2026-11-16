package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/record"
)

// addRecordPlaybackFiles writes files into the record root, scans them, and
// stores a playback probe for each, as FFprobe would report it, so playback
// info decides without running FFprobe.
func (s recordTestServer) addRecordPlaybackFiles(t *testing.T, files map[string]playbackProbe) {
	t.Helper()
	for name, probe := range files {
		path := filepath.Join(s.root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("media"), 0o600); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		s.server.cachePlaybackProbe(path, info, probe)
	}
	if _, err := s.server.recordStore.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, err := s.server.db.Query(`SELECT name, id FROM record_asset`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var name string
		var id int64
		if err := rows.Scan(&name, &id); err != nil {
			t.Fatal(err)
		}
		s.ids[name] = id
	}
}

func h264AACProbe(format string) playbackProbe {
	return playbackProbe{
		Format: playbackProbeFormat{FormatName: format, Duration: "5744.7"},
		Streams: []playbackProbeStream{
			{CodecType: "video", CodecName: "h264", Profile: "Main", Level: 31, PixelFmt: "yuv420p", Width: 1280, Height: 720, StreamIndex: 0},
			{CodecType: "audio", CodecName: "aac", Channels: 2, StreamIndex: 1},
		},
	}
}

func (s recordTestServer) recordPlaybackInfo(t *testing.T, name string, query string) videoPlaybackInfoResponse {
	t.Helper()
	response := s.get("/api/records/assets/"+strconv.FormatInt(s.ids[name], 10)+"/playback"+query, true)
	if response.Code != http.StatusOK {
		t.Fatalf("%s playback%s = %d %s", name, query, response.Code, response.Body.String())
	}
	var info videoPlaybackInfoResponse
	if err := json.Unmarshal(response.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	return info
}

func TestRecordPlaybackUsesTheLibraryPlaybackPipeline(t *testing.T) {
	server := newRecordTestServer(t)
	server.addRecordPlaybackFiles(t, map[string]playbackProbe{
		"live/Stream.ts":  h264AACProbe("mpegts"),
		"live/Stream.mp4": h264AACProbe("mov,mp4,m4a,3gp,3g2,mj2"),
		"live/Talk.mp3": {
			Format:  playbackProbeFormat{FormatName: "mp3", Duration: "7167.1"},
			Streams: []playbackProbeStream{{CodecType: "audio", CodecName: "mp3", Channels: 2}},
		},
	})
	capabilities := "?capabilities=video-mp4-h264-aac,video-h264-main,video-h264-high,audio-mp3"
	ts := strconv.FormatInt(server.ids["Stream.ts"], 10)

	// A browser does not play MPEG-TS, so the video is converted into HLS.
	info := server.recordPlaybackInfo(t, "Stream.ts", capabilities)
	if info.Delivery != "hls" || !strings.HasPrefix(info.URL, "/api/records/assets/"+ts+"/hls/index.m3u8?v=") || info.DurationSeconds != 5744.7 {
		t.Fatalf("ts playback = %+v", info)
	}
	direct := server.recordPlaybackInfo(t, "Stream.mp4", capabilities)
	if direct.Delivery != "direct" || !strings.HasPrefix(direct.URL, "/api/records/assets/"+strconv.FormatInt(server.ids["Stream.mp4"], 10)+"/stream") {
		t.Fatalf("mp4 playback = %+v", direct)
	}

	// The audio of a video always plays as an audio encode.
	audioOfVideo := server.recordPlaybackInfo(t, "Stream.mp4", capabilities+"&profile=audio")
	if audioOfVideo.Delivery != "hls" || !strings.Contains(audioOfVideo.URL, "/hls/index.m3u8?") || !strings.Contains(audioOfVideo.URL, "profile=audio") {
		t.Fatalf("audio of video playback = %+v", audioOfVideo)
	}
	playlist := server.get(audioOfVideo.URL, true)
	if playlist.Code != http.StatusOK || !strings.Contains(playlist.Body.String(), "#EXT-X-ENDLIST") ||
		!strings.Contains(playlist.Body.String(), "segment-000000.ts?") || !strings.Contains(playlist.Body.String(), "profile=audio") {
		t.Fatalf("audio playlist = %d %s", playlist.Code, playlist.Body.String())
	}

	// An audio file the client decodes plays directly, and otherwise as an encode.
	mp3 := strconv.FormatInt(server.ids["Talk.mp3"], 10)
	if audio := server.recordPlaybackInfo(t, "Talk.mp3", capabilities); audio.Delivery != "direct" || audio.URL != "/api/records/assets/"+mp3+"/stream" {
		t.Fatalf("mp3 playback = %+v", audio)
	}
	if audio := server.recordPlaybackInfo(t, "Talk.mp3", ""); audio.Delivery != "hls" || !strings.HasPrefix(audio.URL, "/api/records/assets/"+mp3+"/hls/") {
		t.Fatalf("mp3 playback without capabilities = %+v", audio)
	}
	if stream := server.get("/api/records/assets/"+mp3+"/stream", true); stream.Code != http.StatusOK || stream.Header().Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("mp3 stream = %d %v", stream.Code, stream.Header())
	}

	// Record playlists never share the cache directories of library locations.
	source, err := server.server.loadRecordPlaybackSource(context.Background(), server.ids["Stream.ts"], "")
	if err != nil || source.cacheKey() != "record-"+ts || !strings.Contains(hlsSessionRelativeDir(source.Encode, source), "/record-"+ts+"/") {
		t.Fatalf("record source = %+v, %v", source, err)
	}
	if response := server.get("/api/records/assets/"+strconv.FormatInt(server.ids["Day 1.srt"], 10)+"/playback", true); response.Code != http.StatusNotFound {
		t.Fatalf("subtitle playback = %d", response.Code)
	}
}

func TestRecordTreeClassifiesAudioAndOffersDownloads(t *testing.T) {
	server := newRecordTestServer(t)
	server.addRecordPlaybackFiles(t, map[string]playbackProbe{"trip/Narration.flac": {}})
	asset := func(name string) record.Asset {
		response := server.get("/api/records/assets/"+strconv.FormatInt(server.ids[name], 10), true)
		var body struct {
			Asset record.Asset `json:"asset"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Asset
	}
	audio := asset("Narration.flac")
	if audio.Kind != "audio" || audio.MimeType != "audio/flac" || audio.StreamURL == "" || audio.ThumbnailURL != "" || audio.DownloadURL == "" {
		t.Fatalf("audio asset = %+v", audio)
	}
	other := asset("notes.ass")
	download := server.get(other.DownloadURL, true)
	if download.Code != http.StatusOK || !strings.HasPrefix(download.Header().Get("Content-Disposition"), "attachment") ||
		download.Header().Get("Content-Type") != "application/octet-stream" || download.Body.String() != "[Script Info]" {
		t.Fatalf("download = %d %v %q", download.Code, download.Header(), download.Body.String())
	}
	for _, path := range []string{other.DownloadURL, "/api/records/assets/" + strconv.FormatInt(audio.ID, 10) + "/playback"} {
		if response := server.get(path, false); response.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous %s = %d", path, response.Code)
		}
	}
}
