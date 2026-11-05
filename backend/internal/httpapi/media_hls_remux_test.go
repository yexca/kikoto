package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
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
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func remuxCutsOf(t *testing.T, keyframes []float64, end float64) ([]float64, error) {
	t.Helper()
	var cutter videoRemuxCutter
	for position, keyframe := range keyframes {
		cutter.add(keyframe, position*10)
	}
	index, err := cutter.finish(keyframes[0], end)
	if err != nil {
		return nil, err
	}
	return index.cuts, nil
}

func keyframesEvery(step float64, end float64) []float64 {
	var keyframes []float64
	for time := 0.0; time < end; time += step {
		keyframes = append(keyframes, math.Round(time*1000)/1000)
	}
	return keyframes
}

func TestVideoRemuxCutsAtTheKeyframeNearestEachTarget(t *testing.T) {
	for _, test := range []struct {
		name      string
		keyframes []float64
		end       float64
		want      []float64
	}{
		// 5 is nearer 6 than 7.5 is; then 10 is nearer 11 than 12.5.
		{"regular 2.5 s", keyframesEvery(2.5, 30), 30, []float64{0, 5, 10, 15, 20, 25}},
		{"regular 2 s", keyframesEvery(2, 24), 24, []float64{0, 6, 12, 18}},
		// No keyframe before 8.34, so the segment takes it.
		{"x264 default 8.34 s", keyframesEvery(8.342, 40), 40, []float64{0, 8.342, 16.684, 25.026, 33.368}},
		// 2 is nearer 6 than 9 is but would make a segment shorter than the minimum.
		{"short keyframe kept out", []float64{0, 2, 9, 15}, 20, []float64{0, 9, 15}},
		// A trailing keyframe splits a long last segment.
		{"long tail split", []float64{0, 6, 12, 16}, 22, []float64{0, 6, 12, 16}},
		// Decode order may repeat or reorder keyframe times.
		{"duplicates ignored", []float64{0, 3, 3, 6, 6, 12}, 14, []float64{0, 6, 12}},
	} {
		t.Run(test.name, func(t *testing.T) {
			cuts, err := remuxCutsOf(t, test.keyframes, test.end)
			if err != nil || !slices.Equal(cuts, test.want) {
				t.Fatalf("cuts = %v, %v; want %v", cuts, err, test.want)
			}
		})
	}

	for _, test := range []struct {
		name      string
		keyframes []float64
		end       float64
	}{
		{"one keyframe for a long video", []float64{0}, 600},
		{"a gap longer than the maximum", []float64{0, 6, 30, 36}, 40},
		{"a long tail", []float64{0, 6}, 30},
	} {
		t.Run(test.name, func(t *testing.T) {
			if cuts, err := remuxCutsOf(t, test.keyframes, test.end); !errors.Is(err, errVideoKeyframeIndexUnusable) {
				t.Fatalf("cuts = %v, %v; want an unusable index", cuts, err)
			}
		})
	}
}

func TestVideoKeyframePacketsBuildTheRemuxPlaylist(t *testing.T) {
	output := strings.Join([]string{
		"packet|pts_time=1.400000|flags=K__",
		"packet|pts_time=1.483333|flags=___",
		"packet|pts_time=N/A|flags=___",
		"packet|pts_time=4.400000|flags=K__",
		"packet|pts_time=8.400000|flags=K_D",
		"packet|pts_time=12.400000|flags=K__",
		"format|start_time=1.400000|duration=14.000000",
	}, "\n")
	index, err := parseVideoKeyframePackets(strings.NewReader(output))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(index.cuts, []float64{1.4, 8.4}) || !slices.Equal(index.packets, []int{0, 4}) || index.end != 15.4 {
		t.Fatalf("index = %+v", index)
	}
	playlist := buildHLSPlaylistOfSegments(index.durations(), "v=remux", &hlsMPEGTSSegments)
	for _, expected := range []string{
		"#EXT-X-TARGETDURATION:7\n",
		"#EXTINF:7.000,\nsegment-000000.ts?v=remux\n",
		"#EXTINF:7.000,\nsegment-000001.ts?v=remux\n#EXT-X-ENDLIST\n",
	} {
		if !strings.Contains(playlist, expected) {
			t.Fatalf("playlist does not contain %q:\n%s", expected, playlist)
		}
	}

	if _, err := parseVideoKeyframePackets(strings.NewReader("packet|pts_time=N/A|flags=K__\nformat|start_time=0|duration=10\n")); !errors.Is(err, errVideoKeyframeIndexUnusable) {
		t.Fatalf("keyframe without a time: %v", err)
	}
	if _, err := parseVideoKeyframePackets(strings.NewReader("packet|pts_time=0|flags=K__\n")); !errors.Is(err, errVideoKeyframeIndexUnusable) {
		t.Fatalf("file without a duration: %v", err)
	}
}

func TestVideoRemuxFFmpegArgsCutAtTheIndexedKeyframes(t *testing.T) {
	index := &videoKeyframeIndex{cuts: []float64{0, 5, 10, 15}, packets: []int{0, 120, 240, 360}, end: 18}
	args := videoRemuxHLSFFmpegArgs("input.mkv", filepath.Join("cache", "100%"), 1, index)
	hasPair := func(key string, value string) bool {
		for position := 0; position+1 < len(args); position++ {
			if args[position] == key && args[position+1] == value {
				return true
			}
		}
		return false
	}
	for _, expected := range [][2]string{
		{"-seek_timestamp", "1"},
		{"-ss", "4.999000"},
		{"-c:v", "copy"},
		{"-c:a", "aac"},
		{"-output_ts_offset", "10.000000"},
		{"-copypriorss", "0"},
		{"-f", "segment"},
		{"-segment_start_number", "1"},
		{"-segment_frames", "120,240"},
	} {
		if !hasPair(expected[0], expected[1]) {
			t.Fatalf("FFmpeg args do not contain %q %q: %v", expected[0], expected[1], args)
		}
	}
	if !slices.Contains(args, "-copyts") || args[len(args)-1] != filepath.Join("cache", "100%%", "segment-%06d.ts.tmp") {
		t.Fatalf("FFmpeg args = %v", args)
	}
	last := videoRemuxHLSFFmpegArgs("input.mkv", "cache", 3, index)
	if !slices.Contains(last, "-segment_time") || slices.Contains(last, "-segment_frames") {
		t.Fatalf("the last segment is cut: %v", last)
	}
}

func TestVideoRemuxRequiresADecodableStreamWithinTheBitrateLimit(t *testing.T) {
	source := func(codec string, profile string, level int, pixelFormat string) hlsPlaybackSource {
		return hlsPlaybackSource{Duration: 100, Probe: playbackProbe{
			Format: playbackProbeFormat{FormatName: "matroska,webm"},
			Streams: []playbackProbeStream{
				{CodecType: "video", CodecName: codec, Profile: profile, Level: level, PixelFmt: pixelFormat, Width: 1920, Height: 1080},
				{CodecType: "audio", CodecName: "ac3"},
			},
		}}
	}
	high := map[string]bool{capVideoH264Main: true, capVideoH264High: true}
	// Direct HEVC decoding says nothing about HEVC in HLS segments.
	fileHEVC := map[string]bool{capVideoHEVCMain: true, capVideoHEVCMain10: true, capVideoHEVCMainL51: true}
	hlsHEVC := map[string]bool{capVideoHLSHEVCMain: true}
	hlsHEVC10 := map[string]bool{capVideoHLSHEVCMain: true, capVideoHLSHEVCMain10: true}
	underLimit := int64(videoRemuxMaximumBitsPerSecond / 8 * 100)
	for _, test := range []struct {
		name         string
		source       hlsPlaybackSource
		capabilities map[string]bool
		size         int64
		want         *videoRemux
	}{
		{"decodable High 4.1", source("h264", "High", 41, "yuv420p"), high, underLimit, &videoH264Remux},
		{"High without the High decoder", source("h264", "High", 41, "yuv420p"), map[string]bool{capVideoH264Main: true}, underLimit, nil},
		{"level above the decoder", source("h264", "High", 51, "yuv420p"), high, underLimit, nil},
		{"High 10", source("h264", "High 10", 41, "yuv420p10le"), high, underLimit, nil},
		{"4:2:2", source("h264", "High 4:2:2", 41, "yuv422p"), high, underLimit, nil},
		{"HEVC without an HLS HEVC decoder", source("hevc", "Main", 120, "yuv420p"), mergeCapabilities(high, fileHEVC), underLimit, nil},
		{"HEVC Main 4.0", source("hevc", "Main", 120, "yuv420p"), hlsHEVC, underLimit, &videoHEVCRemux},
		{"HEVC above the HLS decoder level", source("hevc", "Main", 150, "yuv420p"), hlsHEVC, underLimit, nil},
		{"HEVC Main 10 without its decoder", source("hevc", "Main 10", 120, "yuv420p10le"), hlsHEVC, underLimit, nil},
		{"HEVC Main 10", source("hevc", "Main 10", 120, "yuv420p10le"), hlsHEVC10, underLimit, &videoHEVCRemux},
		{"HEVC 4:2:2", source("hevc", "Rext", 120, "yuv422p10le"), hlsHEVC10, underLimit, nil},
		{"HEVC above the bitrate limit", source("hevc", "Main", 120, "yuv420p"), hlsHEVC, underLimit + 1000, nil},
		{"above the bitrate limit", source("h264", "High", 41, "yuv420p"), high, underLimit + 1000, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := remuxForVideo(test.source, test.capabilities, test.size); got != test.want {
				t.Fatalf("remux = %+v, want %+v", got, test.want)
			}
		})
	}
}

func mergeCapabilities(sets ...map[string]bool) map[string]bool {
	merged := map[string]bool{}
	for _, set := range sets {
		for key, value := range set {
			merged[key] = value
		}
	}
	return merged
}

func TestVideoRemuxRevisionsAreSeparateForEachCodec(t *testing.T) {
	source := hlsPlaybackSource{Revision: "source"}
	h264, hevc := videoH264Remux.revision(source), videoHEVCRemux.revision(source)
	if h264 == hevc || h264 == source.Revision || hevc == source.Revision {
		t.Fatalf("revisions: source %s, H.264 %s, HEVC %s", source.Revision, h264, hevc)
	}
	if videoRemuxOfRevision(source, h264) != &videoH264Remux || videoRemuxOfRevision(source, hevc) != &videoHEVCRemux ||
		videoRemuxOfRevision(source, source.Revision) != nil {
		t.Fatal("a revision does not name its remux")
	}
	if videoHEVCRemuxHLSProfile.cacheDir == videoRemuxHLSProfile.cacheDir || videoHEVCRemuxHLSProfile.name == videoRemuxHLSProfile.name ||
		videoHEVCRemuxHLSProfile.maximumSegments != videoRemuxHLSProfile.maximumSegments ||
		videoHEVCRemuxHLSProfile.segmentMaximumBytes != videoRemuxHLSProfile.segmentMaximumBytes {
		t.Fatalf("HEVC remux profile = %+v", videoHEVCRemuxHLSProfile)
	}
}

func TestVideoHEVCRemuxWritesFMP4SegmentsWithAnInitializationSection(t *testing.T) {
	index := &videoKeyframeIndex{cuts: []float64{0, 5, 10, 15}, packets: []int{0, 120, 240, 360}, end: 18.5}
	args := videoHEVCRemuxHLSFFmpegArgs("input.mkv", filepath.Join("cache", "100%"), 1, index)
	for _, expected := range [][2]string{
		{"-c:v", "copy"},
		{"-tag:v", "hvc1"},
		{"-segment_format", "mp4"},
		{"-segment_header_filename", os.DevNull},
		{"-individual_header_trailer", "0"},
		{"-segment_frames", "120,240"},
		{"-ss", "4.999000"},
	} {
		if !hasArgPair(args, expected[0], expected[1]) {
			t.Fatalf("FFmpeg args do not contain %q %q: %v", expected[0], expected[1], args)
		}
	}
	if args[len(args)-1] != filepath.Join("cache", "100%%", "segment-%06d.m4s.tmp") {
		t.Fatalf("FFmpeg args = %v", args)
	}
	// The init run writes the section to standard output and nothing a
	// session would publish.
	init := videoHEVCRemuxInitArgs("input.mkv", "cache", index)
	if !hasArgPair(init, "-segment_header_filename", "pipe:1") || !hasArgPair(init, "-t", "0") || !hasArgPair(init, "-ss", "-0.001000") ||
		!strings.HasPrefix(filepath.Base(init[len(init)-1]), videoRemuxHLSSessionPlaylist) {
		t.Fatalf("init args = %v", init)
	}

	playlist := buildHLSPlaylistOfSegments(index.durations(), "v=hevc", videoHEVCRemuxHLSProfile.segmentFormat())
	for _, expected := range []string{
		"#EXT-X-VERSION:7\n",
		"#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MAP:URI=\"init.m4s?v=hevc\"\n#EXTINF:5.000,\nsegment-000000.m4s?v=hevc\n",
		"#EXTINF:3.500,\nsegment-000003.m4s?v=hevc\n#EXT-X-ENDLIST\n",
	} {
		if !strings.Contains(playlist, expected) {
			t.Fatalf("playlist does not contain %q:\n%s", expected, playlist)
		}
	}
	if mpegts := buildHLSPlaylistOfSegments(index.durations(), "v=h264", videoRemuxHLSProfile.segmentFormat()); strings.Contains(mpegts, "EXT-X-MAP") ||
		!strings.Contains(mpegts, "#EXT-X-VERSION:3\n") || !strings.Contains(mpegts, "segment-000000.ts?v=h264") {
		t.Fatalf("MPEG-TS playlist:\n%s", mpegts)
	}

	box := func(kind string, payload int) []byte {
		data := make([]byte, 8+payload)
		data[3] = byte(len(data))
		copy(data[4:], kind)
		return data
	}
	section := append(box("ftyp", 4), box("moov", 16)...)
	if !validHLSInitSection(section) || validHLSInitSection(append(section, box("moof", 8)...)) ||
		validHLSInitSection(section[:len(section)-1]) || validHLSInitSection(box("moov", 16)) {
		t.Fatal("initialization section check is wrong")
	}
	for _, name := range []string{"segment-000001.m4s.tmp", hlsInitSectionPartial + ".part", hlsInitSectionPartial + "-000000"} {
		if !isHLSSessionPartial(name) {
			t.Fatalf("%s is not a partial", name)
		}
	}
}

func hasArgPair(args []string, key string, value string) bool {
	for position := 0; position+1 < len(args); position++ {
		if args[position] == key && args[position+1] == value {
			return true
		}
	}
	return false
}

type videoRemuxTestServer struct {
	server    *Server
	db        *sqlutil.DB
	dataRoot  string
	cacheRoot string
	ffmpeg    string
	ffprobe   string
}

// newVideoRemuxTestServer serves synthetic 24 fps videos: 841 is H.264 High
// with a keyframe every 2.5 s and FLAC audio in Matroska, 842 the same with
// a keyframe every 25 s, 843 H.264 with AAC in MP4, and 844 MPEG-4 Part 2.
func newVideoRemuxTestServer(t *testing.T) *videoRemuxTestServer {
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
		INSERT INTO work (id, primary_code, title) VALUES (840, 'RJ00000000', 'Synthetic remux video');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (840, 'synthetic_local', 'Synthetic Local', 'local_folder');
	`); err != nil {
		t.Fatal(err)
	}
	h264 := func(keyframeInterval int) []string {
		return []string{"-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p",
			"-x264-params", "keyint=" + strconv.Itoa(keyframeInterval) + ":min-keyint=" + strconv.Itoa(keyframeInterval) + ":scenecut=0"}
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	fixture := &videoRemuxTestServer{server: server, db: db, dataRoot: dataRoot, cacheRoot: cacheRoot, ffmpeg: ffmpegPath, ffprobe: ffprobePath}
	fixture.addVideo(t, 841, "remux.mkv", append(h264(60), "-c:a", "flac"))
	fixture.addVideo(t, 842, "sparse-keyframes.mkv", append(h264(600), "-c:a", "flac"))
	fixture.addVideo(t, 843, "direct.mp4", append(h264(60), "-c:a", "aac"))
	fixture.addVideo(t, 844, "legacy.avi", []string{"-c:v", "mpeg4", "-c:a", "pcm_s16le"})
	return fixture
}

// addVideo encodes a two-minute 24 fps test pattern with a sine tone and
// serves it at location.
func (fixture *videoRemuxTestServer) addVideo(t *testing.T, location int64, file string, encode []string) {
	t.Helper()
	mediaPath := filepath.Join(fixture.dataRoot, "RJ00000000", file)
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
		t.Fatal(err)
	}
	args := append([]string{"-nostdin", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", "120"}, encode...)
	if output, err := exec.Command(fixture.ffmpeg, append(args, "-y", mediaPath)...).CombinedOutput(); err != nil {
		t.Fatalf("create %s: %v (%s)", file, err, output)
	}
	if _, err := fixture.db.Exec(`INSERT INTO media_item (id, work_id, kind, title, fingerprint, has_audio) VALUES (?, 840, 'video', ?, ?, 1)`,
		location, file, "synthetic-remux-"+file); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (?, ?, 840, 'local', ?, 'available')`,
		location, location, "RJ00000000/"+file); err != nil {
		t.Fatal(err)
	}
}

func (fixture *videoRemuxTestServer) playbackInfo(t *testing.T, location int64, query string) videoPlaybackInfoResponse {
	t.Helper()
	id := strconv.FormatInt(location, 10)
	request := httptest.NewRequest(http.MethodGet, "/api/media/"+id+"/playback?"+query, nil)
	request.SetPathValue("id", id)
	response := httptest.NewRecorder()
	fixture.server.getVideoPlaybackInfo(response, request)
	var info videoPlaybackInfoResponse
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &info) != nil {
		t.Fatalf("playback info %d = %d: %s", location, response.Code, response.Body.String())
	}
	return info
}

func (fixture *videoRemuxTestServer) serve(location int64, file string, revision string) *httptest.ResponseRecorder {
	id := strconv.FormatInt(location, 10)
	request := httptest.NewRequest(http.MethodGet, "/api/media/"+id+"/hls/"+file+"?v="+revision, nil)
	request.SetPathValue("id", id)
	request.SetPathValue("file", file)
	response := httptest.NewRecorder()
	fixture.server.serveMediaHLS(response, request)
	return response
}

// packetTimes returns the first and last presentation times of a segment's
// video or audio stream, whether the first packet is a keyframe, and where
// the stream ends.
func (fixture *videoRemuxTestServer) packetTimes(t *testing.T, path string, stream string) (float64, bool, float64) {
	t.Helper()
	output, err := exec.Command(fixture.ffprobe, "-v", "error", "-select_streams", stream,
		"-show_entries", "packet=pts_time,duration_time,flags", "-of", "csv=p=0", path).Output()
	if err != nil {
		t.Fatalf("probe %s: %v", path, err)
	}
	first, end, keyframe := math.Inf(1), math.Inf(-1), false
	for line := range strings.Lines(string(output)) {
		fields := strings.Split(strings.TrimSpace(line), ",")
		if len(fields) < 3 {
			continue
		}
		pts, err := strconv.ParseFloat(fields[0], 64)
		if err != nil {
			continue
		}
		duration, _ := strconv.ParseFloat(fields[1], 64)
		if pts < first {
			first, keyframe = pts, strings.HasPrefix(fields[2], "K")
		}
		end = max(end, pts+duration)
	}
	return first, keyframe, end
}

func TestVideoPlaybackChoosesDirectRemuxOrTranscode(t *testing.T) {
	fixture := newVideoRemuxTestServer(t)
	high := "capabilities=video-mp4-h264-aac,video-h264-main,video-h264-high"
	for _, test := range []struct {
		name       string
		location   int64
		query      string
		conversion string
	}{
		{"direct MP4", 843, high, "none"},
		{"remux Matroska with FLAC", 841, high, "remux"},
		{"transcode after direct playback failed", 841, high + "&forceTranscode=1", "transcode"},
		{"transcode without a High decoder", 841, "capabilities=video-mp4-h264-aac", "transcode"},
		{"transcode keyframes 25 s apart", 842, high, "transcode"},
		{"transcode MPEG-4 Part 2", 844, high, "transcode"},
	} {
		t.Run(test.name, func(t *testing.T) {
			info := fixture.playbackInfo(t, test.location, test.query)
			if info.Conversion != test.conversion {
				t.Fatalf("conversion = %q, want %q", info.Conversion, test.conversion)
			}
			if test.conversion == "none" {
				return
			}
			playlistURL, err := url.Parse(info.URL)
			if err != nil {
				t.Fatal(err)
			}
			revision := playlistURL.Query().Get("v")
			source, err := fixture.server.loadHLSPlaybackSource(context.Background(), test.location)
			if err != nil {
				t.Fatal(err)
			}
			if info.Delivery != "hls" || (revision == source.Revision) != (test.conversion == "transcode") {
				t.Fatalf("playback info = %+v, transcode revision %s", info, source.Revision)
			}
		})
	}
	// A remux revision of a stream that cannot be copied is refused.
	source, err := fixture.server.loadHLSPlaybackSource(context.Background(), 844)
	if err != nil {
		t.Fatal(err)
	}
	if response := fixture.serve(844, "index.m3u8", videoH264Remux.revision(source)); response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("remux of MPEG-4 Part 2 = %d: %s", response.Code, response.Body.String())
	}
}

func TestVideoRemuxSegmentsStartAtTheirKeyframesAcrossEncodes(t *testing.T) {
	fixture := newVideoRemuxTestServer(t)
	info := fixture.playbackInfo(t, 841, "capabilities=video-mp4-h264-aac,video-h264-main,video-h264-high")
	playlistURL, err := url.Parse(info.URL)
	if err != nil || info.Conversion != "remux" {
		t.Fatalf("playback info = %+v, %v", info, err)
	}
	revision := playlistURL.Query().Get("v")
	playlist := fixture.serve(841, "index.m3u8", revision)
	// Keyframes every 2.5 s make five-second segments.
	if playlist.Code != http.StatusOK || !strings.Contains(playlist.Body.String(), "#EXT-X-TARGETDURATION:5\n") ||
		len(regexp.MustCompile(`#EXTINF:5\.000,`).FindAllString(playlist.Body.String(), -1)) != 24 {
		t.Fatalf("playlist = %d:\n%s", playlist.Code, playlist.Body.String())
	}
	key := "transcodes/hls-remux/841/" + revision
	if response := fixture.serve(841, hlsSegmentName(0), revision); response.Code != http.StatusOK || response.Body.Bytes()[0] != 0x47 {
		t.Fatalf("first segment = %d: %s", response.Code, response.Body.String())
	}
	first := fixture.server.hlsSessions.get(key)
	if first == nil {
		t.Fatal("the first segment did not start a remux")
	}
	select {
	case <-first.exited:
	case <-time.After(time.Minute):
		t.Fatal("the first remux did not stop")
	}
	if first.state != hlsSessionStopped || first.next != videoRemuxAheadSegments {
		t.Fatalf("first remux ended at %d in state %d, want a stop %d segments ahead", first.next, first.state, videoRemuxAheadSegments)
	}

	// A seek past what the first encode produced starts another there, which
	// runs to the end of the file.
	if response := fixture.serve(841, hlsSegmentName(22), revision); response.Code != http.StatusOK {
		t.Fatalf("seek segment = %d: %s", response.Code, response.Body.String())
	}
	second := fixture.server.hlsSessions.get(key)
	if second != nil {
		<-second.exited
		if second.start != 22 || second.state != hlsSessionFinished || second.next != 24 {
			t.Fatalf("seek remux started at %d and ended at %d in state %d", second.start, second.next, second.state)
		}
	}

	dir := filepath.Join(fixture.cacheRoot, filepath.FromSlash(key))
	for index := range 24 {
		path := filepath.Join(dir, hlsSegmentName(index))
		if _, err := os.Stat(path); err != nil {
			if index < videoRemuxAheadSegments || index >= 22 {
				t.Fatalf("segment %d was not produced: %v", index, err)
			}
			continue
		}
		want := videoHLSTimelineOffsetSeconds + float64(index)*5
		videoStart, keyframe, videoEnd := fixture.packetTimes(t, path, "v:0")
		if !keyframe || math.Abs(videoStart-want) > 0.001 || math.Abs(videoEnd-(want+5)) > 1.0/24+0.001 {
			t.Fatalf("segment %d video covers %.4f to %.4f (keyframe %t), want %.1f to %.1f", index, videoStart, videoEnd, keyframe, want, want+5)
		}
		audioStart, _, _ := fixture.packetTimes(t, path, "a:0")
		if audioStart < want-0.15 || audioStart > want+0.03 {
			t.Fatalf("segment %d audio starts at %.4f, want about %.1f", index, audioStart, want)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if isHLSSessionPartial(entry.Name()) {
			t.Fatalf("a finished remux left %s", entry.Name())
		}
	}
}

func TestVideoHEVCRemuxSegmentsShareOneInitializationSection(t *testing.T) {
	fixture := newVideoRemuxTestServer(t)
	if encoders, err := exec.Command(fixture.ffmpeg, "-hide_banner", "-encoders").Output(); err != nil || !bytes.Contains(encoders, []byte(" libx265 ")) {
		t.Skip("ffmpeg has no libx265 encoder")
	}
	// HEVC Main with a closed GOP keyframe every 2.5 s, in Matroska with FLAC.
	fixture.addVideo(t, 845, "hevc.mkv", []string{"-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
		"-x265-params", "keyint=60:min-keyint=60:scenecut=0:open-gop=0:log-level=error", "-c:a", "flac"})
	source, err := fixture.server.loadHLSPlaybackSource(context.Background(), 845)
	if err != nil {
		t.Fatal(err)
	}
	if info := fixture.playbackInfo(t, 845, "capabilities=video-mp4-hvc1-aac,video-hevc-main"); info.Conversion != "transcode" {
		t.Fatalf("playback info without an HLS HEVC decoder = %+v", info)
	}
	info := fixture.playbackInfo(t, 845, "capabilities=video-hls-hevc-main")
	revision := videoHEVCRemux.revision(source)
	if info.Conversion != "remux" || !strings.HasSuffix(info.URL, "?v="+revision) {
		t.Fatalf("playback info = %+v, want the HEVC remux %s", info, revision)
	}

	playlist := fixture.serve(845, "index.m3u8", revision)
	if playlist.Code != http.StatusOK || !strings.Contains(playlist.Body.String(), "#EXT-X-MAP:URI=\"init.m4s?v="+revision+"\"\n") ||
		len(regexp.MustCompile(`#EXTINF:5\.000,\nsegment-[0-9]{6}\.m4s\?`).FindAllString(playlist.Body.String(), -1)) != 24 {
		t.Fatalf("playlist = %d:\n%s", playlist.Code, playlist.Body.String())
	}
	if response := fixture.serve(845, hlsSegmentName(0), revision); response.Code != http.StatusNotFound {
		t.Fatalf("MPEG-TS segment of an fMP4 remux = %d", response.Code)
	}
	h264Source, err := fixture.server.loadHLSPlaybackSource(context.Background(), 841)
	if err != nil {
		t.Fatal(err)
	}
	if response := fixture.serve(841, "init.m4s", videoH264Remux.revision(h264Source)); response.Code != http.StatusNotFound {
		t.Fatalf("initialization section of an MPEG-TS remux = %d", response.Code)
	}
	initResponse := fixture.serve(845, "init.m4s", revision)
	section := initResponse.Body.Bytes()
	if initResponse.Code != http.StatusOK || initResponse.Header().Get("Content-Type") != "video/iso.segment" || !validHLSInitSection(section) {
		t.Fatalf("initialization section = %d %q", initResponse.Code, initResponse.Header().Get("Content-Type"))
	}

	segmentName := func(index int) string { return videoHEVCRemuxHLSProfile.segmentName(index) }
	if response := fixture.serve(845, segmentName(0), revision); response.Code != http.StatusOK || response.Header().Get("Content-Type") != "video/iso.segment" || string(response.Body.Bytes()[4:8]) != "moof" {
		t.Fatalf("first segment = %d", response.Code)
	}
	key := "transcodes/hls-remux-hevc/845/" + revision
	if first := fixture.server.hlsSessions.get(key); first != nil {
		<-first.exited
	}
	if response := fixture.serve(845, segmentName(22), revision); response.Code != http.StatusOK {
		t.Fatalf("seek segment = %d: %s", response.Code, response.Body.String())
	}
	if second := fixture.server.hlsSessions.get(key); second != nil {
		<-second.exited
	}

	// Segments from both encodes follow the one section on one timeline.
	dir := filepath.Join(fixture.cacheRoot, filepath.FromSlash(key))
	probeDir := t.TempDir()
	for _, index := range []int{0, 1, videoRemuxAheadSegments - 1, 22, 23} {
		segment, err := os.ReadFile(filepath.Join(dir, segmentName(index)))
		if err != nil {
			t.Fatalf("segment %d was not produced: %v", index, err)
		}
		path := filepath.Join(probeDir, fmt.Sprintf("segment-%d.mp4", index))
		if err := os.WriteFile(path, append(slices.Clone(section), segment...), 0o644); err != nil {
			t.Fatal(err)
		}
		want := videoHLSTimelineOffsetSeconds + float64(index)*5
		videoStart, keyframe, videoEnd := fixture.packetTimes(t, path, "v:0")
		if !keyframe || math.Abs(videoStart-want) > 0.001 || math.Abs(videoEnd-(want+5)) > 1.0/24+0.001 {
			t.Fatalf("segment %d video covers %.4f to %.4f (keyframe %t), want %.1f to %.1f", index, videoStart, videoEnd, keyframe, want, want+5)
		}
		audioStart, _, _ := fixture.packetTimes(t, path, "a:0")
		if audioStart < want-0.15 || audioStart > want+0.03 {
			t.Fatalf("segment %d audio starts at %.4f, want about %.1f", index, audioStart, want)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if isHLSSessionPartial(entry.Name()) {
			t.Fatalf("a finished remux left %s", entry.Name())
		}
	}

	// An encode starting anywhere writes the same section.
	header := filepath.Join(t.TempDir(), "header.mp4")
	args := videoHEVCRemuxHLSFFmpegArgs(source.Path, t.TempDir(), 10, fixture.server.mustVideoKeyframeIndex(t, source))
	for position := range args {
		if args[position] == os.DevNull {
			args[position] = header
		}
	}
	if output, err := exec.Command(fixture.ffmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("remux from segment 10: %v (%s)", err, output)
	}
	if written, err := os.ReadFile(header); err != nil || !bytes.Equal(written, section) {
		t.Fatalf("an encode from segment 10 wrote another section: %v", err)
	}
}

func (s *Server) mustVideoKeyframeIndex(t *testing.T, source hlsPlaybackSource) *videoKeyframeIndex {
	t.Helper()
	index, err := s.videoKeyframeIndex(context.Background(), source, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	return index
}
