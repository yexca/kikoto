package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestVideoSubtitleProbeListsOnlyTextStreams(t *testing.T) {
	output := []byte(`{"streams":[
		{"index":0,"codec_type":"video","codec_name":"h264"},
		{"index":2,"codec_type":"subtitle","codec_name":"subrip","tags":{"language":"jpn","title":"Dialogue"},"disposition":{"default":1,"forced":0}},
		{"index":3,"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle","disposition":{"default":1}},
		{"index":4,"codec_type":"subtitle","codec_name":"dvd_subtitle"},
		{"index":5,"codec_type":"subtitle","codec_name":"dvb_subtitle"},
		{"index":6,"codec_type":"subtitle","codec_name":"ASS","disposition":{"forced":1}},
		{"index":7,"codec_type":"subtitle","codec_name":"mov_text"},
		{"index":8,"codec_type":"subtitle","codec_name":"webvtt"},
		{"index":9,"codec_type":"subtitle","codec_name":"ssa"}
	]}`)
	// The playback probe that decides direct playback also lists subtitles.
	var probe playbackProbe
	if err := json.Unmarshal(output, &probe); err != nil {
		t.Fatal(err)
	}
	streams := videoSubtitleStreams(probe)
	indexes := []int{}
	for _, stream := range streams {
		indexes = append(indexes, stream.StreamIndex)
	}
	if !slices.Equal(indexes, []int{2, 6, 7, 8, 9}) {
		t.Fatalf("text subtitle streams = %v", indexes)
	}
	if streams[1].CodecName != "ass" || streams[1].Disposition.Forced != 1 || streams[0].Tags.Language != "jpn" ||
		streams[0].Disposition.Default != 1 {
		t.Fatalf("streams = %+v", streams)
	}
}

type videoSubtitleTestServer struct {
	server    *Server
	dataRoot  string
	cacheRoot string
	ffmpeg    string
}

// newVideoSubtitleTestServer serves location 861, a synthetic Matroska video
// with a default Japanese SubRip stream titled "Dialogue" (stream 1) and a
// forced English ASS stream (stream 2), and 862, the same video without
// subtitles.
func newVideoSubtitleTestServer(t *testing.T) *videoSubtitleTestServer {
	t.Helper()
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	fixture := &videoSubtitleTestServer{dataRoot: t.TempDir(), cacheRoot: t.TempDir(), ffmpeg: ffmpegPath}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (860, 'RJ00000000', 'Example Work');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (860, 'synthetic_local', 'Synthetic Local', 'local_folder');
	`); err != nil {
		t.Fatal(err)
	}
	for location, file := range map[int64]string{861: "subtitled.mkv", 862: "plain.mkv"} {
		fixture.writeVideo(t, file, location == 861, "Hello <b>there</b>")
		if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title, fingerprint, has_audio) VALUES (?, 860, 'video', ?, ?, 0)`,
			location, file, "synthetic-subtitle-"+file); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (?, ?, 860, 'local', ?, 'available')`,
			location, location, "RJ00000000/"+file); err != nil {
			t.Fatal(err)
		}
	}
	fixture.server = NewServer(db, config.Config{DataRoot: fixture.dataRoot, CacheRoot: fixture.cacheRoot})
	t.Cleanup(func() { _ = fixture.server.Shutdown(context.Background()) })
	return fixture
}

func (fixture *videoSubtitleTestServer) writeVideo(t *testing.T, file string, subtitled bool, firstCue string) {
	t.Helper()
	directory := filepath.Join(fixture.dataRoot, "RJ00000000")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-f", "lavfi", "-t", "5", "-i", "testsrc2=size=160x90:rate=10"}
	if subtitled {
		srt := filepath.Join(t.TempDir(), "cues.srt")
		cues := "1\n00:00:01,000 --> 00:00:02,500\n" + firstCue + "\n\n2\n00:00:03,000 --> 00:00:04,000\nLine one\nLine two\n"
		if err := os.WriteFile(srt, []byte(cues), 0o644); err != nil {
			t.Fatal(err)
		}
		args = append(args, "-i", srt, "-i", srt, "-map", "0", "-map", "1", "-map", "2",
			"-c:s:0", "srt", "-metadata:s:s:0", "language=jpn", "-metadata:s:s:0", "title=Dialogue", "-disposition:s:0", "default",
			"-c:s:1", "ass", "-metadata:s:s:1", "language=eng", "-disposition:s:1", "forced")
	}
	args = append(args, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", filepath.Join(directory, file))
	if output, err := exec.Command(fixture.ffmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("create %s: %v (%s)", file, err, output)
	}
}

func (fixture *videoSubtitleTestServer) playbackInfo(t *testing.T, location int64) videoPlaybackInfoResponse {
	t.Helper()
	id := strconv.FormatInt(location, 10)
	request := httptest.NewRequest(http.MethodGet, "/api/media/"+id+"/playback", nil)
	request.SetPathValue("id", id)
	response := httptest.NewRecorder()
	fixture.server.getVideoPlaybackInfo(response, request)
	var info videoPlaybackInfoResponse
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &info) != nil {
		t.Fatalf("playback info %d = %d: %s", location, response.Code, response.Body.String())
	}
	return info
}

func (fixture *videoSubtitleTestServer) subtitle(location int64, file string, query string) *httptest.ResponseRecorder {
	id := strconv.FormatInt(location, 10)
	request := httptest.NewRequest(http.MethodGet, "/api/media/"+id+"/subtitles/"+file+query, nil)
	request.SetPathValue("id", id)
	request.SetPathValue("file", file)
	response := httptest.NewRecorder()
	fixture.server.serveVideoSubtitle(response, request)
	return response
}

func (fixture *videoSubtitleTestServer) cachedSubtitles(t *testing.T) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(fixture.cacheRoot, transcodeCacheRootRelative, "subtitles", "*.vtt"))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func subtitleQuery(t *testing.T, track videoSubtitleTrack) (string, string) {
	t.Helper()
	file, query, ok := strings.Cut(strings.TrimPrefix(track.URL, "/api/media/861/subtitles/"), "?")
	if !ok || file != strconv.Itoa(track.Stream)+".vtt" {
		t.Fatalf("subtitle URL = %q", track.URL)
	}
	return file, "?" + query
}

func TestVideoPlaybackInfoListsEmbeddedTextSubtitles(t *testing.T) {
	fixture := newVideoSubtitleTestServer(t)
	info := fixture.playbackInfo(t, 861)
	if len(info.Subtitles) != 2 {
		t.Fatalf("subtitles = %+v", info.Subtitles)
	}
	dialogue, signs := info.Subtitles[0], info.Subtitles[1]
	if dialogue.Stream != 1 || dialogue.Codec != "subrip" || dialogue.Language != "jpn" || dialogue.Title != "Dialogue" ||
		!dialogue.Default || dialogue.Forced {
		t.Fatalf("first subtitle = %+v", dialogue)
	}
	if signs.Stream != 2 || signs.Codec != "ass" || signs.Language != "eng" || signs.Title != "" || signs.Default || !signs.Forced {
		t.Fatalf("second subtitle = %+v", signs)
	}
	if plain := fixture.playbackInfo(t, 862); plain.Subtitles != nil {
		t.Fatalf("a video without subtitle streams listed %+v", plain.Subtitles)
	}
}

func TestVideoSubtitleRouteServesCachedWebVTT(t *testing.T) {
	fixture := newVideoSubtitleTestServer(t)
	info := fixture.playbackInfo(t, 861)
	file, query := subtitleQuery(t, info.Subtitles[0])
	response := fixture.subtitle(861, file, query)
	if response.Code != http.StatusOK {
		t.Fatalf("subtitle = %d: %s", response.Code, response.Body.String())
	}
	want := "WEBVTT\n\n00:01.000 --> 00:02.500\nHello <b>there</b>\n\n00:03.000 --> 00:04.000\nLine one\nLine two\n"
	if body := response.Body.String(); body != want {
		t.Fatalf("subtitle body = %q", body)
	}
	header := response.Header()
	if header.Get("Content-Type") != "text/vtt; charset=utf-8" || header.Get("X-Content-Type-Options") != "nosniff" ||
		header.Get("Content-Security-Policy") != "default-src 'none'; sandbox" ||
		header.Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("subtitle headers = %v", header)
	}
	cached := fixture.cachedSubtitles(t)
	if len(cached) != 1 {
		t.Fatalf("cached subtitles = %v", cached)
	}
	overview, err := fixture.server.scanTranscodeCache(context.Background())
	if err != nil || overview.Files != 1 {
		t.Fatalf("transcode cache = %+v, %v", overview, err)
	}

	// A cached file is served without running FFmpeg again.
	t.Setenv("PATH", t.TempDir())
	if again := fixture.subtitle(861, file, query); again.Code != http.StatusOK || again.Body.String() != want {
		t.Fatalf("cached subtitle = %d: %q", again.Code, again.Body.String())
	}
	// A URL without the current revision is not cached as immutable.
	if stale := fixture.subtitle(861, file, ""); stale.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("unversioned subtitle headers = %v", stale.Header())
	}
}

func TestVideoSubtitleRouteRejectsOtherStreams(t *testing.T) {
	fixture := newVideoSubtitleTestServer(t)
	for _, test := range []struct {
		location int64
		file     string
		status   int
	}{
		{861, "0.vtt", http.StatusNotFound},
		{861, "9.vtt", http.StatusNotFound},
		{861, "1.srt", http.StatusNotFound},
		{861, "..%2F1.vtt", http.StatusNotFound},
		{862, "1.vtt", http.StatusNotFound},
		{863, "1.vtt", http.StatusNotFound},
	} {
		response := fixture.subtitle(test.location, test.file, "")
		if response.Code != test.status {
			t.Fatalf("subtitle %d/%s = %d: %s", test.location, test.file, response.Code, response.Body.String())
		}
	}
	if cached := fixture.cachedSubtitles(t); len(cached) != 0 {
		t.Fatalf("rejected requests cached %v", cached)
	}
}

func TestVideoSubtitleCacheFollowsTheSourceRevision(t *testing.T) {
	fixture := newVideoSubtitleTestServer(t)
	before := fixture.playbackInfo(t, 861).Subtitles[0]
	file, query := subtitleQuery(t, before)
	if response := fixture.subtitle(861, file, query); response.Code != http.StatusOK {
		t.Fatalf("subtitle = %d: %s", response.Code, response.Body.String())
	}

	fixture.writeVideo(t, "subtitled.mkv", true, "Changed")
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(filepath.Join(fixture.dataRoot, "RJ00000000", "subtitled.mkv"), later, later); err != nil {
		t.Fatal(err)
	}
	after := fixture.playbackInfo(t, 861).Subtitles[0]
	if after.URL == before.URL {
		t.Fatalf("subtitle URL %q did not change with the source", after.URL)
	}
	// The old revision serves the current file and is not cached as immutable.
	stale := fixture.subtitle(861, file, query)
	if stale.Code != http.StatusOK || !strings.Contains(stale.Body.String(), "Changed") ||
		stale.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("stale subtitle = %d %v: %q", stale.Code, stale.Header(), stale.Body.String())
	}
	if cached := fixture.cachedSubtitles(t); len(cached) != 2 {
		t.Fatalf("cached subtitles = %v", cached)
	}
}

func TestVideoSubtitleExtractionIsBounded(t *testing.T) {
	fixture := newVideoSubtitleTestServer(t)
	file, query := subtitleQuery(t, fixture.playbackInfo(t, 861).Subtitles[0])

	// Extraction has a slot of its own, so it runs while every transcode slot
	// is taken.
	occupyRealtimeResource(fixture.server, realtimeResourceTranscode, true)
	if response := fixture.subtitle(861, file, query); response.Code != http.StatusOK {
		t.Fatalf("subtitle while transcodes are busy = %d: %s", response.Code, response.Body.String())
	}

	// With its slot and queue taken, a request is refused at once.
	fixture = newVideoSubtitleTestServer(t)
	file, query = subtitleQuery(t, fixture.playbackInfo(t, 861).Subtitles[0])
	occupyRealtimeResource(fixture.server, realtimeResourceSubtitle, true)
	started := time.Now()
	busy := fixture.subtitle(861, file, query)
	if busy.Code != http.StatusServiceUnavailable || !strings.Contains(busy.Body.String(), "media_transcode_busy") ||
		busy.Header().Get("Retry-After") != "1" || time.Since(started) > 2*time.Second {
		t.Fatalf("busy subtitle = %d after %v: %s", busy.Code, time.Since(started), busy.Body.String())
	}

	fixture = newVideoSubtitleTestServer(t)
	file, query = subtitleQuery(t, fixture.playbackInfo(t, 861).Subtitles[0])
	limit := videoSubtitleMaximumBytes
	videoSubtitleMaximumBytes = 16
	t.Cleanup(func() { videoSubtitleMaximumBytes = limit })
	large := fixture.subtitle(861, file, query)
	if large.Code != http.StatusServiceUnavailable || !strings.Contains(large.Body.String(), "subtitle_unavailable") {
		t.Fatalf("oversized subtitle = %d: %s", large.Code, large.Body.String())
	}
	if strings.Contains(large.Body.String(), fixture.dataRoot) || strings.Contains(large.Body.String(), "subtitled.mkv") {
		t.Fatalf("subtitle error names a local path: %s", large.Body.String())
	}
	if cached := fixture.cachedSubtitles(t); len(cached) != 0 {
		t.Fatalf("an oversized subtitle was cached: %v", cached)
	}
	// The failure is remembered for the revision instead of extracting again.
	videoSubtitleMaximumBytes = limit
	if again := fixture.subtitle(861, file, query); again.Code != http.StatusServiceUnavailable {
		t.Fatalf("subtitle after a failure = %d: %s", again.Code, again.Body.String())
	}
}
