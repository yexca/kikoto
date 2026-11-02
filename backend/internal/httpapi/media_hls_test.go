package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestBuildHLSPlaylistPublishesCompleteDuration(t *testing.T) {
	playlist := buildHLSPlaylist(14, "revision")
	if hlsSegmentCount(14) != 3 {
		t.Fatalf("segment count = %d, want 3", hlsSegmentCount(14))
	}
	for _, expected := range []string{
		"#EXT-X-PLAYLIST-TYPE:VOD",
		"#EXTINF:6.000,\nsegment-000000.ts?v=revision",
		"#EXTINF:6.000,\nsegment-000001.ts?v=revision",
		"#EXTINF:2.000,\nsegment-000002.ts?v=revision",
		"#EXT-X-ENDLIST",
	} {
		if !strings.Contains(playlist, expected) {
			t.Fatalf("playlist does not contain %q:\n%s", expected, playlist)
		}
	}
}

func TestVideoHLSFFmpegArgsBoundTheProfileToTheSegmentGrid(t *testing.T) {
	args := videoHLSFFmpegArgs("input.avi", filepath.Join("cache", "100%"), 2, 14)
	hasPair := func(key string, value string) bool {
		for index := 0; index+1 < len(args); index++ {
			if args[index] == key && args[index+1] == value {
				return true
			}
		}
		return false
	}
	for _, expected := range [][2]string{
		{"-ss", "12.000"},
		{"-t", "2.000"},
		{"-threads:v", "2"},
		{"-c:v", "libx264"},
		{"-pix_fmt", "yuv420p"},
		{"-maxrate", "2800k"},
		{"-sc_threshold", "0"},
		{"-force_key_frames", "expr:gte(t,n_forced*6)"},
		{"-fps_mode", "cfr"},
		{"-c:a", "aac"},
		{"-ac", "2"},
		{"-output_ts_offset", "22.000"},
		{"-max_interleave_delta", "0"},
		{"-f", "hls"},
		{"-hls_time", "6"},
		{"-hls_flags", "temp_file"},
		{"-start_number", "2"},
		{"-hls_segment_filename", filepath.Join("cache", "100%%", "segment-%06d.ts")},
	} {
		if !hasPair(expected[0], expected[1]) {
			t.Fatalf("FFmpeg args do not contain %q %q: %v", expected[0], expected[1], args)
		}
	}
	filter := "tpad=stop=-1:stop_mode=clone,scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2:x=0:y=0"
	if !hasPair("-vf", filter) {
		t.Fatalf("FFmpeg args do not contain the bounded 720p filter: %v", args)
	}
	for _, arg := range args {
		if arg == "zerolatency" {
			t.Fatalf("VOD encode disables lookahead and B-frames: %v", args)
		}
	}
	if last := args[len(args)-1]; last != filepath.Join("cache", "100%", videoHLSSessionPlaylist) {
		t.Fatalf("playlist output = %q", last)
	}
}

func TestVideoHLSSessionStopsAheadIdleOrOverTheByteLimit(t *testing.T) {
	newSession := func(dir string) *hlsSession {
		return &hlsSession{
			profile: &videoHLSProfile, dir: dir, startedAt: time.Now(), requestedAt: time.Now(),
			changed: make(chan struct{}),
		}
	}
	writeSegments := func(dir string, from int, to int) {
		for index := from; index < to; index++ {
			if err := os.WriteFile(filepath.Join(dir, hlsSegmentName(index)), []byte{0x47}, 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	ahead := t.TempDir()
	session := newSession(ahead)
	writeSegments(ahead, 0, videoHLSProfile.aheadSegments+5)
	if stop, err := advanceHLSSession(session, time.Now()); !stop || err != nil || session.next != videoHLSProfile.aheadSegments {
		t.Fatalf("session ahead of the viewer: next = %d, stop %t, %v", session.next, stop, err)
	}
	session.observe(10)
	if stop, err := advanceHLSSession(session, time.Now()); stop || err != nil || session.next != videoHLSProfile.aheadSegments+5 {
		t.Fatalf("viewer moved on: next = %d, stop %t, %v", session.next, stop, err)
	}

	idle := t.TempDir()
	session = newSession(idle)
	later := time.Now().Add(videoHLSProfile.idleTimeout)
	session.waiting = 1
	if stop, _ := advanceHLSSession(session, later); stop {
		t.Fatal("a session with a waiting request stopped as idle")
	}
	session.waiting = 0
	if stop, err := advanceHLSSession(session, later); !stop || err != nil {
		t.Fatalf("idle session: stop %t, %v", stop, err)
	}
	if stop, _ := advanceHLSSession(&hlsSession{
		profile: &audioHLSProfile, dir: idle, startedAt: time.Now(), changed: make(chan struct{}),
	}, later); stop {
		t.Fatal("audio sessions have no idle limit")
	}

	for _, name := range []string{hlsSegmentName(0), hlsSegmentName(0) + ".tmp"} {
		oversized := t.TempDir()
		path := filepath.Join(oversized, name)
		if err := os.WriteFile(path, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Truncate(path, hlsSegmentMaximumBytes+1); err != nil {
			t.Fatal(err)
		}
		session = newSession(oversized)
		if stop, err := advanceHLSSession(session, time.Now()); !stop || !errors.Is(err, errHLSTranscodeUnavailable) || session.next != 0 {
			t.Fatalf("%s over the byte limit: next = %d, stop %t, %v", name, session.next, stop, err)
		}
	}
}

func TestVideoHLSCanGenerateLaterSegmentFirstAndReuseIt(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	relativePath := filepath.ToSlash(filepath.Join("RJ00000000", "clip.avi"))
	mediaPath := filepath.Join(dataRoot, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(ffmpegPath,
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", "14", "-c:v", "mpeg4", "-q:v", "8", "-c:a", "pcm_s16le", "-y", mediaPath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create video fixture: %v (%s)", err, output)
	}

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (801, 'RJ00000000', 'Synthetic HLS video');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (802, 'synthetic_local', 'Synthetic Local', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint, duration_seconds, has_audio)
		VALUES (803, 801, 'video', 'clip.avi', 'synthetic-hls-video', 14, 1);
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, duration_seconds)
		VALUES (804, 803, 802, 'local', ?, 'available', 14);
	`, relativePath); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })

	infoRequest := httptest.NewRequest(http.MethodGet, "/api/media/804/playback?forceTranscode=1", nil)
	infoRequest.SetPathValue("id", "804")
	infoResponse := httptest.NewRecorder()
	server.getVideoPlaybackInfo(infoResponse, infoRequest)
	if infoResponse.Code != http.StatusOK {
		t.Fatalf("playback info status = %d, body = %s", infoResponse.Code, infoResponse.Body.String())
	}
	var info videoPlaybackInfoResponse
	if err := json.Unmarshal(infoResponse.Body.Bytes(), &info); err != nil {
		t.Fatal(err)
	}
	if info.Delivery != "hls" || !info.Seekable || info.DurationSeconds < 13.9 || info.DurationSeconds > 14.1 {
		t.Fatalf("playback info = %+v", info)
	}
	playlistURL, err := url.Parse(info.URL)
	if err != nil {
		t.Fatal(err)
	}
	revision := playlistURL.Query().Get("v")
	if revision == "" {
		t.Fatalf("playback URL has no source revision: %q", info.URL)
	}

	segmentURL := "/api/media/804/hls/segment-000002.ts?v=" + url.QueryEscape(revision)
	firstRequest := httptest.NewRequest(http.MethodGet, segmentURL, nil)
	firstRequest.SetPathValue("id", "804")
	firstRequest.SetPathValue("file", "segment-000002.ts")
	firstResponse := httptest.NewRecorder()
	server.serveMediaHLS(firstResponse, firstRequest)
	if firstResponse.Code != http.StatusOK || firstResponse.Body.Len() == 0 || firstResponse.Body.Bytes()[0] != 0x47 {
		t.Fatalf("later segment response = %d, %d bytes", firstResponse.Code, firstResponse.Body.Len())
	}
	segmentRoot := filepath.Join(cacheRoot, "transcodes", "hls", "804", revision)
	segmentPath := filepath.Join(segmentRoot, "segment-000002.ts")
	firstStat, err := os.Stat(segmentPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"segment-000000.ts", "segment-000001.ts"} {
		if _, err := os.Stat(filepath.Join(segmentRoot, name)); !os.IsNotExist(err) {
			t.Fatalf("requesting segment 2 unexpectedly created %s", name)
		}
	}

	secondRequest := httptest.NewRequest(http.MethodGet, segmentURL, nil)
	secondRequest.SetPathValue("id", "804")
	secondRequest.SetPathValue("file", "segment-000002.ts")
	secondResponse := httptest.NewRecorder()
	server.serveMediaHLS(secondResponse, secondRequest)
	secondStat, err := os.Stat(segmentPath)
	if err != nil {
		t.Fatal(err)
	}
	if secondResponse.Code != http.StatusOK || !bytes.Equal(secondResponse.Body.Bytes(), firstResponse.Body.Bytes()) || !secondStat.ModTime().Equal(firstStat.ModTime()) {
		t.Fatalf("cached segment was not reused: status %d, first %v, second %v", secondResponse.Code, firstStat.ModTime(), secondStat.ModTime())
	}

	changedTime := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(mediaPath, changedTime, changedTime); err != nil {
		t.Fatal(err)
	}
	server.realtimeProbeCacheMu.Lock()
	server.realtimeProbeCache = nil
	server.realtimeProbeCacheMu.Unlock()
	staleRequest := httptest.NewRequest(http.MethodGet, segmentURL, nil)
	staleRequest.SetPathValue("id", "804")
	staleRequest.SetPathValue("file", "segment-000002.ts")
	staleResponse := httptest.NewRecorder()
	server.serveMediaHLS(staleResponse, staleRequest)
	if staleResponse.Code != http.StatusConflict || !strings.Contains(staleResponse.Body.String(), `"code":"playback_source_changed"`) {
		t.Fatalf("stale segment response = %d, %s", staleResponse.Code, staleResponse.Body.String())
	}
}

type videoHLSTestServer struct {
	server     *Server
	cacheRoot  string
	mediaPath  string
	ffprobe    string
	revisionAt int
}

// newVideoHLSTestServer serves a synthetic 23.976 fps video of the given
// length as location 834.
func newVideoHLSTestServer(t *testing.T, seconds int) *videoHLSTestServer {
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
	relativePath := "RJ00000000/movie.avi"
	mediaPath := filepath.Join(dataRoot, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(ffmpegPath,
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24000/1001",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
		"-t", strconv.Itoa(seconds), "-c:v", "mpeg4", "-q:v", "8", "-c:a", "pcm_s16le", "-y", mediaPath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create video fixture: %v (%s)", err, output)
	}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (831, 'RJ00000000', 'Synthetic HLS video sessions');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (832, 'synthetic_local', 'Synthetic Local', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint, has_audio)
		VALUES (833, 831, 'video', 'movie.avi', 'synthetic-hls-video-sessions', 1);
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (834, 833, 832, 'local', ?, 'available');
	`, relativePath); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	return &videoHLSTestServer{server: server, cacheRoot: cacheRoot, mediaPath: mediaPath, ffprobe: ffprobePath}
}

// coldRevision changes the file version, so no segment is cached for it.
func (fixture *videoHLSTestServer) coldRevision(t *testing.T) string {
	t.Helper()
	fixture.revisionAt++
	changed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(fixture.revisionAt) * time.Second)
	if err := os.Chtimes(fixture.mediaPath, changed, changed); err != nil {
		t.Fatal(err)
	}
	fixture.server.realtimeProbeCacheMu.Lock()
	fixture.server.realtimeProbeCache = nil
	fixture.server.realtimeProbeCacheMu.Unlock()
	source, err := fixture.server.loadHLSPlaybackSource(context.Background(), 834)
	if err != nil {
		t.Fatal(err)
	}
	return source.Revision
}

func (fixture *videoHLSTestServer) serve(ctx context.Context, revision string, index int) *httptest.ResponseRecorder {
	file := hlsSegmentName(index)
	request := httptest.NewRequestWithContext(ctx, http.MethodGet, "/api/media/834/hls/"+file+"?v="+revision, nil)
	request.SetPathValue("id", "834")
	request.SetPathValue("file", file)
	response := httptest.NewRecorder()
	fixture.server.serveMediaHLS(response, request)
	return response
}

func (fixture *videoHLSTestServer) sessionKey(revision string) string {
	return "transcodes/hls/834/" + revision
}

func (fixture *videoHLSTestServer) segmentPath(revision string, index int) string {
	return filepath.Join(fixture.cacheRoot, "transcodes", "hls", "834", revision, hlsSegmentName(index))
}

func (fixture *videoHLSTestServer) waitForSessionExit(t *testing.T, session *hlsSession) {
	t.Helper()
	select {
	case <-session.exited:
	case <-time.After(time.Minute):
		t.Fatalf("video HLS session from segment %d did not exit", session.start)
	}
}

// firstPacketTime returns the first timestamp of a segment's video or audio
// stream and whether that packet is a keyframe.
func (fixture *videoHLSTestServer) firstPacketTime(t *testing.T, path string, stream string) (float64, bool) {
	t.Helper()
	output, err := exec.Command(fixture.ffprobe, "-v", "error", "-select_streams", stream,
		"-show_entries", "packet=pts_time,flags", "-read_intervals", "%+#1", "-of", "csv=p=0", path).Output()
	if err != nil {
		t.Fatalf("probe %s: %v", path, err)
	}
	fields := strings.Split(strings.TrimSpace(strings.SplitN(string(output), "\n", 2)[0]), ",")
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		t.Fatalf("probe %s returned %q", path, output)
	}
	return value, len(fields) > 1 && strings.HasPrefix(fields[1], "K")
}

func TestVideoHLSSessionRestartsOnSeekOnTheSharedSegmentGrid(t *testing.T) {
	fixture := newVideoHLSTestServer(t, 420)
	revision := fixture.coldRevision(t)
	if count := hlsSegmentCount(420); count != 70 {
		t.Fatalf("segment count = %d", count)
	}
	if response := fixture.serve(context.Background(), revision, 0); response.Code != http.StatusOK {
		t.Fatalf("first segment response = %d: %s", response.Code, response.Body.String())
	}
	first := fixture.server.hlsSessions.get(fixture.sessionKey(revision))
	if first == nil || first.start != 0 {
		t.Fatal("the first segment did not start a session at segment 0")
	}
	if err := first.waitFor(context.Background(), 10, fixture.segmentPath(revision, 10)); err != nil {
		t.Fatalf("the first encode did not continue: %v", err)
	}

	// Segment 66 is beyond what the running encode produces before it stops.
	if response := fixture.serve(context.Background(), revision, 66); response.Code != http.StatusOK {
		t.Fatalf("seek response = %d: %s", response.Code, response.Body.String())
	}
	fixture.waitForSessionExit(t, first)
	if first.state != hlsSessionStopped || first.next >= videoHLSProfile.aheadSegments {
		t.Fatalf("the first encode ended at %d in state %d instead of being replaced", first.next, first.state)
	}
	second := fixture.server.hlsSessions.get(fixture.sessionKey(revision))
	if second == nil || second.start != 66 {
		t.Fatal("the seek did not restart the encode at segment 66")
	}
	fixture.waitForSessionExit(t, second)
	if second.state != hlsSessionFinished || second.next != 70 {
		t.Fatalf("the restarted encode ended at %d in state %d", second.next, second.state)
	}

	// Both encodes cut their segments on one timeline: every segment starts with
	// a keyframe within one frame of its playlist position, and its audio within
	// the encoder delay and one audio frame.
	checked := 0
	for index := range 70 {
		path := fixture.segmentPath(revision, index)
		if _, err := os.Stat(path); err != nil {
			if index < first.next || index >= 66 {
				t.Fatalf("segment %d was not produced: %v", index, err)
			}
			continue
		}
		want := videoHLSTimelineOffsetSeconds + float64(index)*hlsSegmentDurationSeconds
		videoStart, keyframe := fixture.firstPacketTime(t, path, "v:0")
		if !keyframe || videoStart < want-0.001 || videoStart > want+1001.0/24000+0.001 {
			t.Fatalf("segment %d video starts at %.4f (keyframe %t), want %.4f", index, videoStart, keyframe, want)
		}
		audioStart, _ := fixture.firstPacketTime(t, path, "a:0")
		if audioStart < want-0.11 || audioStart > want+0.03 {
			t.Fatalf("segment %d audio starts at %.4f, want about %.4f", index, audioStart, want)
		}
		checked++
	}
	if checked < 15 {
		t.Fatalf("checked only %d segments", checked)
	}
}

func TestVideoHLSSessionStopsAheadOfTheViewer(t *testing.T) {
	fixture := newVideoHLSTestServer(t, 420)
	revision := fixture.coldRevision(t)
	if response := fixture.serve(context.Background(), revision, 0); response.Code != http.StatusOK {
		t.Fatalf("first segment response = %d: %s", response.Code, response.Body.String())
	}
	session := fixture.server.hlsSessions.get(fixture.sessionKey(revision))
	if session == nil {
		t.Fatal("the first segment did not start a session")
	}
	fixture.waitForSessionExit(t, session)
	if session.state != hlsSessionStopped || session.next != videoHLSProfile.aheadSegments {
		t.Fatalf("session ended at %d in state %d, want a stop at %d", session.next, session.state, videoHLSProfile.aheadSegments)
	}
	if _, err := os.Stat(fixture.segmentPath(revision, 69)); !os.IsNotExist(err) {
		t.Fatalf("the encode continued to the end of the file: %v", err)
	}

	// Playback within the refill lead of the gap starts the next encode there.
	if response := fixture.serve(context.Background(), revision, 45); response.Code != http.StatusOK {
		t.Fatalf("cached segment response = %d", response.Code)
	}
	deadline := time.Now().Add(time.Minute)
	for !validCachedHLSSegment(fixture.segmentPath(revision, 69)) {
		if time.Now().After(deadline) {
			t.Fatal("serving near the gap did not refill it")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestVideoHLSRequestCancellationLeavesTheSharedEncodeRunning(t *testing.T) {
	fixture := newVideoHLSTestServer(t, 120)
	revision := fixture.coldRevision(t)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for fixture.server.hlsSessions.get(fixture.sessionKey(revision)) == nil {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()
	response := fixture.serve(ctx, revision, 4)
	if response.Body.Len() != 0 {
		t.Fatalf("a cancelled request wrote %d bytes", response.Body.Len())
	}
	session := fixture.server.hlsSessions.get(fixture.sessionKey(revision))
	if session == nil {
		t.Fatal("cancelling a request stopped the shared encode")
	}
	if err := session.waitFor(context.Background(), 5, fixture.segmentPath(revision, 5)); err != nil {
		t.Fatalf("the encode did not continue after the cancelled request: %v", err)
	}

	if err := fixture.server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	fixture.waitForSessionExit(t, session)
	if fixture.server.hlsSessions.get(fixture.sessionKey(revision)) != nil {
		t.Fatal("shutdown left the session registered")
	}
	entries, err := os.ReadDir(filepath.Dir(fixture.segmentPath(revision, 0)))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if isHLSSessionPartial(entry.Name()) {
			t.Fatalf("shutdown left %s", entry.Name())
		}
	}
}

func TestTranscodeCacheDefaultLimitAndLRUEviction(t *testing.T) {
	cacheRoot := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	if got := server.transcodeCacheLimitBytes(context.Background()); got != int64(5)<<30 {
		t.Fatalf("default transcode cache limit = %d, want %d", got, int64(5)<<30)
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, '1')`, transcodeCacheLimitSetting); err != nil {
		t.Fatal(err)
	}
	oldPath := writeCacheTestFile(t, cacheRoot, "transcodes/hls/1/revision/segment-000000.ts", "old", 2*time.Hour)
	newPath := writeCacheTestFile(t, cacheRoot, "transcodes/hls/2/revision/segment-000000.ts", "new", time.Hour)
	overview, err := server.enforceTranscodeCacheLimit(context.Background(), (int64(1)<<30)-4)
	if err != nil {
		t.Fatal(err)
	}
	if overview.Files != 1 || overview.Bytes != 3 {
		t.Fatalf("trimmed overview = %+v, want one 3-byte segment", overview)
	}
	if _, err := os.Stat(oldPath); !os.IsNotExist(err) {
		t.Fatalf("oldest segment still exists or stat failed: %v", err)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("newest segment was removed: %v", err)
	}
}

func TestTranscodeCacheScanIncludesCompleteAudioAndOnlyStalePartialFiles(t *testing.T) {
	cacheRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{CacheRoot: cacheRoot})
	readyPath := writeCacheTestFile(t, cacheRoot, "transcodes/hls/1/revision/segment-000000.ts", "ready", time.Hour)
	audioPath := writeCacheTestFile(t, cacheRoot, "transcodes/audio/revision.mp3", "audio", time.Hour)
	staleAudioPath := writeCacheTestFile(t, cacheRoot, "transcodes/audio/.audio-transcode-stale.part", "stale audio", transcodeCachePartialMaxAge+time.Minute)
	writeCacheTestFile(t, cacheRoot, "transcodes/audio/.audio-transcode-active.part", "active audio", transcodeCachePartialMaxAge-time.Minute)
	stalePartialPath := writeCacheTestFile(
		t,
		cacheRoot,
		"transcodes/hls/1/revision/.hls-segment-stale.part",
		"stale",
		transcodeCachePartialMaxAge+time.Minute,
	)
	writeCacheTestFile(
		t,
		cacheRoot,
		"transcodes/hls/1/revision/.hls-segment-active.part",
		"active",
		transcodeCachePartialMaxAge-time.Minute,
	)

	overview, entries, err := server.scanTranscodeCacheUnlocked(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if overview.Files != 4 || overview.Bytes != int64(len("ready")+len("stale")+len("audio")+len("stale audio")) {
		t.Fatalf("transcode cache overview = %+v, want ready and stale partial files", overview)
	}
	paths := map[string]bool{}
	for _, entry := range entries {
		paths[filepath.ToSlash(entry.relPath)] = true
	}
	for _, expected := range []string{readyPath, stalePartialPath, audioPath, staleAudioPath} {
		relPath, err := filepath.Rel(cacheRoot, expected)
		if err != nil {
			t.Fatal(err)
		}
		if !paths[filepath.ToSlash(relPath)] {
			t.Fatalf("transcode cache entries do not contain %q: %#v", relPath, paths)
		}
	}
}
