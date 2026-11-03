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
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// multiAudioProbe is FFprobe output of a video with a Japanese stereo track,
// an untagged track, and a titled default 5.1 track.
const multiAudioProbe = `{
	"streams": [
		{"index": 0, "codec_type": "video", "codec_name": "h264", "disposition": {"default": 1}},
		{"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2, "disposition": {"default": 0}, "tags": {"language": "jpn"}},
		{"index": 2, "codec_type": "subtitle", "codec_name": "ass"},
		{"index": 3, "codec_type": "audio", "codec_name": "opus", "channels": 2, "disposition": {"default": 0}, "tags": {"language": "und"}},
		{"index": 4, "codec_type": "audio", "codec_name": "ac3", "channels": 6, "disposition": {"default": 1}, "tags": {"language": "eng", "title": "Commentary"}}
	],
	"format": {"format_name": "matroska,webm", "duration": "60.000000"}
}`

func decodePlaybackProbe(t *testing.T, value string) playbackProbe {
	t.Helper()
	var probe playbackProbe
	if err := json.Unmarshal([]byte(value), &probe); err != nil {
		t.Fatal(err)
	}
	return probe
}

func TestVideoAudioTracksListEveryAudioStreamAndTheDefault(t *testing.T) {
	probe := decodePlaybackProbe(t, multiAudioProbe)
	tracks := videoAudioTracks(probe)
	want := []videoAudioTrack{
		{StreamIndex: 1, Codec: "aac", Channels: 2, Language: "jpn"},
		{StreamIndex: 3, Codec: "opus", Channels: 2},
		{StreamIndex: 4, Codec: "ac3", Channels: 6, Language: "eng", Title: "Commentary", Default: true},
	}
	if !slices.Equal(tracks, want) {
		t.Fatalf("tracks = %+v, want %+v", tracks, want)
	}
	if track := defaultVideoAudioTrack(tracks); track != 2 {
		t.Fatalf("default track = %d, want the flagged third track", track)
	}
	tracks[2].Default = false
	if track := defaultVideoAudioTrack(tracks); track != 0 {
		t.Fatalf("default track without a flag = %d, want the first", track)
	}
	if track := defaultVideoAudioTrack(nil); track != 0 {
		t.Fatalf("default track of a video without audio = %d", track)
	}
}

func TestRequestedVideoAudioTrackAcceptsOnlyAnAudioStreamOfTheFile(t *testing.T) {
	tracks := videoAudioTracks(decodePlaybackProbe(t, multiAudioProbe))
	for _, test := range []struct {
		query string
		track int
		valid bool
	}{
		{"", 2, true},
		{"audioStream=1", 0, true},
		{"audioStream=3", 1, true},
		{"audioStream=4", 2, true},
		{"audioStream=0", 0, false},  // the video stream
		{"audioStream=2", 0, false},  // a subtitle stream
		{"audioStream=5", 0, false},  // past the last stream
		{"audioStream=-1", 0, false}, // negative
		{"audioStream=", 0, false},
		{"audioStream=a", 0, false},
		{"audioStream=1&audioStream=3", 0, false},
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/media/1/playback?"+test.query, nil)
		track, err := requestedVideoAudioTrack(request, tracks)
		if (err == nil) != test.valid || (test.valid && track != test.track) {
			t.Errorf("%q = track %d, error %v; want track %d, valid %t", test.query, track, err, test.track, test.valid)
		}
	}
}

func TestEveryVideoAudioTrackHasItsOwnRevisions(t *testing.T) {
	base := hlsPlaybackSource{LocationID: 7, Profile: playbackProfileVideo, Revision: "0123456789abcdef01234567"}
	seen := map[string]int{}
	for track := range 3 {
		source := base
		source.useAudioTrack(track)
		if track == 0 && source.Revision != base.Revision {
			t.Fatalf("the first track changed the file revision to %s", source.Revision)
		}
		if videoKeyframeIndexKey(source) != base.Revision {
			t.Fatalf("track %d keys its keyframe index by %s", track, videoKeyframeIndexKey(source))
		}
		for _, revision := range []string{
			source.Revision,
			videoH264Remux.revision(source),
			videoHEVCRemux.revision(source),
			videoHardwareRevision(source, videoHardwareQSV),
			hlsSessionRelativeDir(&videoHLSProfile, source),
		} {
			if previous, ok := seen[revision]; ok {
				t.Fatalf("track %d shares %s with track %d", track, revision, previous)
			}
			seen[revision] = track
		}
		// Choosing another track again returns to that track's revision.
		again := source
		again.useAudioTrack(track)
		if again.Revision != source.Revision {
			t.Fatalf("track %d revision changed from %s to %s", track, source.Revision, again.Revision)
		}
	}
}

func TestVideoEncodesMapTheChosenAudioTrack(t *testing.T) {
	keyframes := &videoKeyframeIndex{cuts: []float64{0, 6}, packets: []int{0, 144}, end: 12}
	source := hlsPlaybackSource{Path: "/media/video.mkv", Profile: playbackProfileVideo, Duration: 12, Keyframes: keyframes}
	encoder := videoHardwareEncoder{mode: videoHardwareVAAPI, device: "/dev/dri/renderD128"}
	profiles := map[string]*hlsEncodeProfile{
		"transcode":  &videoHLSProfile,
		"remux":      &videoRemuxHLSProfile,
		"hevc-remux": &videoHEVCRemuxHLSProfile,
		"hardware":   videoHardwareHLSProfile(encoder),
	}
	for track, want := range []string{"0:a:0?", "0:a:1?", "0:a:2?"} {
		source.AudioTrack = track
		for name, profile := range profiles {
			args := profile.args(source, "/cache/out", 0)
			var maps []string
			for index := 1; index < len(args); index++ {
				if args[index-1] == "-map" {
					maps = append(maps, args[index])
				}
			}
			if !slices.Equal(maps, []string{"0:v:0", want}) {
				t.Errorf("%s of track %d maps %v, want 0:v:0 and %s", name, track, maps, want)
			}
		}
	}
	// The HEVC initialization section describes the same audio stream as its segments.
	for track, want := range []string{"0:a:0?", "0:a:1?"} {
		if args := withVideoAudioTrack(videoHEVCRemuxInitArgs(source.Path, "/cache/out", keyframes), track); !slices.Contains(args, want) {
			t.Errorf("HEVC init section of track %d maps %v, want %s", track, args, want)
		}
	}
	// The audio player keeps the first audio stream of a video.
	if args := videoAudioHLSProfile.args(source, "/cache/out", 0); !slices.Contains(args, "0:a:0") {
		t.Fatalf("audio of a video maps %v", args)
	}
}

// newMultiAudioVideoTestServer serves synthetic 30-second H.264 videos with
// AAC audio in MP4: 861 has a 440 Hz first track and a silent second track
// flagged default, and 862 the same without a default flag on either track.
func newMultiAudioVideoTestServer(t *testing.T) *videoRemuxTestServer {
	t.Helper()
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not installed")
	}
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (860, 'RJ00000000', 'Example Work');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (860, 'synthetic_local', 'Synthetic Local', 'local_folder');
	`); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		location    int64
		file        string
		disposition []string
	}{
		{861, "default-second.mp4", []string{"-disposition:a:0", "0", "-disposition:a:1", "default"}},
		{862, "no-default.mp4", []string{"-disposition:a:0", "0", "-disposition:a:1", "0"}},
	} {
		mediaPath := filepath.Join(dataRoot, "RJ00000000", fixture.file)
		if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
			t.Fatal(err)
		}
		args := []string{"-nostdin", "-hide_banner", "-loglevel", "error",
			"-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
			"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
			"-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
			"-map", "0", "-map", "1", "-map", "2", "-t", "30",
			"-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
			"-x264-params", "keyint=48:min-keyint=48:scenecut=0",
			"-c:a", "aac", "-metadata:s:a:0", "language=jpn", "-metadata:s:a:1", "language=eng"}
		args = append(args, fixture.disposition...)
		if output, err := exec.Command(ffmpegPath, append(args, "-y", mediaPath)...).CombinedOutput(); err != nil {
			t.Fatalf("create %s: %v (%s)", fixture.file, err, output)
		}
		if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title, fingerprint, has_audio) VALUES (?, 860, 'video', ?, ?, 1)`,
			fixture.location, fixture.file, "synthetic-audio-tracks-"+fixture.file); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (?, ?, 860, 'local', ?, 'available')`,
			fixture.location, fixture.location, "RJ00000000/"+fixture.file); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	return &videoRemuxTestServer{server: server, cacheRoot: cacheRoot, ffprobe: ffprobePath}
}

func (fixture *videoRemuxTestServer) request(handler http.HandlerFunc, location int64, file string, query string) *httptest.ResponseRecorder {
	id := strconv.FormatInt(location, 10)
	target := "/api/media/" + id + "/playback?" + query
	if file != "" {
		target = "/api/media/" + id + "/hls/" + file + "?" + query
	}
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.SetPathValue("id", id)
	request.SetPathValue("file", file)
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

// maximumVolume returns the peak level in dB of a media file's audio.
func maximumVolume(t *testing.T, path string) float64 {
	t.Helper()
	output, err := exec.Command("ffmpeg", "-nostdin", "-hide_banner", "-i", path, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-").CombinedOutput()
	if err != nil {
		t.Fatalf("measure %s: %v (%s)", path, err, output)
	}
	match := regexp.MustCompile(`max_volume: (-?[0-9.]+|-inf) dB`).FindStringSubmatch(string(output))
	if match == nil {
		t.Fatalf("no volume in %s", output)
	}
	if match[1] == "-inf" {
		return -1000
	}
	value, _ := strconv.ParseFloat(match[1], 64)
	return value
}

func TestVideoPlaybackOffersEveryAudioTrack(t *testing.T) {
	fixture := newMultiAudioVideoTestServer(t)
	capabilities := "capabilities=video-mp4-h264-aac,video-h264-main,video-h264-high"

	// The default flag selects the second track, which the browser would not
	// choose from the file, so the default playback is remuxed.
	info := fixture.playbackInfo(t, 861, capabilities)
	if info.Conversion != "remux" || info.AudioStream == nil || *info.AudioStream != 2 || strings.Contains(info.URL, "audioStream") {
		t.Fatalf("default playback = %+v", info)
	}
	want := []videoAudioTrack{
		{StreamIndex: 1, Codec: "aac", Channels: 1, Language: "jpn"},
		{StreamIndex: 2, Codec: "aac", Channels: 2, Language: "eng", Default: true},
	}
	if !slices.Equal(info.AudioTracks, want) {
		t.Fatalf("audio tracks = %+v, want %+v", info.AudioTracks, want)
	}
	// The first track plays directly, and as a transcode after that fails.
	if first := fixture.playbackInfo(t, 861, capabilities+"&audioStream=1"); first.Conversion != "none" || *first.AudioStream != 1 {
		t.Fatalf("first track playback = %+v", first)
	}
	transcode := fixture.playbackInfo(t, 861, capabilities+"&audioStream=1&forceTranscode=1")
	if transcode.Conversion != "transcode" || !strings.HasSuffix(transcode.URL, "&audioStream=1") {
		t.Fatalf("first track transcode = %+v", transcode)
	}
	// Without a flag the first track is the default and plays directly.
	if plain := fixture.playbackInfo(t, 862, capabilities); plain.Conversion != "none" || *plain.AudioStream != 1 {
		t.Fatalf("playback without a default flag = %+v", plain)
	}

	for _, query := range []string{"audioStream=0", "audioStream=3", "audioStream=x"} {
		if response := fixture.request(fixture.server.getVideoPlaybackInfo, 861, "", capabilities+"&"+query); response.Code != http.StatusBadRequest ||
			!strings.Contains(response.Body.String(), "invalid_audio_stream") {
			t.Errorf("playback info with %s = %d: %s", query, response.Code, response.Body.String())
		}
	}
	defaultURL, err := url.Parse(info.URL)
	if err != nil {
		t.Fatal(err)
	}
	defaultRevision := defaultURL.Query().Get("v")
	if response := fixture.request(fixture.server.serveMediaHLS, 861, "index.m3u8", "profile=audio&audioStream=1"); response.Code != http.StatusBadRequest {
		t.Fatalf("audio player playlist with an audio stream = %d: %s", response.Code, response.Body.String())
	}
	// A revision belongs to its track.
	if response := fixture.request(fixture.server.serveMediaHLS, 861, "index.m3u8", "v="+defaultRevision+"&audioStream=1"); response.Code != http.StatusConflict {
		t.Fatalf("default revision with the first track = %d: %s", response.Code, response.Body.String())
	}

	// Remuxes of each track write their own segments of their own audio.
	source, err := fixture.server.loadHLSPlaybackSource(context.Background(), 861)
	if err != nil {
		t.Fatal(err)
	}
	source.useAudioTrack(0)
	firstRevision := videoH264Remux.revision(source)
	for _, test := range []struct {
		query   string
		dir     string
		audible bool
	}{
		{"v=" + defaultRevision, "transcodes/hls-remux/861/" + defaultRevision, false},
		{"v=" + firstRevision + "&audioStream=1", "transcodes/hls-remux/861/" + firstRevision, true},
	} {
		playlist := fixture.request(fixture.server.serveMediaHLS, 861, "index.m3u8", test.query)
		want, _ := url.ParseQuery(test.query)
		segmentQuery := regexp.MustCompile(`segment-000000\.ts\?(.*)\n`).FindStringSubmatch(playlist.Body.String())
		if playlist.Code != http.StatusOK || segmentQuery == nil || segmentQuery[1] != want.Encode() {
			t.Fatalf("playlist of %s = %d:\n%s", test.query, playlist.Code, playlist.Body.String())
		}
		if response := fixture.request(fixture.server.serveMediaHLS, 861, hlsSegmentName(0), test.query); response.Code != http.StatusOK {
			t.Fatalf("first segment of %s = %d: %s", test.query, response.Code, response.Body.String())
		}
		volume := maximumVolume(t, filepath.Join(fixture.cacheRoot, filepath.FromSlash(test.dir), hlsSegmentName(0)))
		if (volume > -40) != test.audible {
			t.Fatalf("segment of %s peaks at %.1f dB, want audible %t", test.query, volume, test.audible)
		}
	}
}
