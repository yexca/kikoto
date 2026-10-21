package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestAudioHLSFFmpegArgsContinueOneTimeline(t *testing.T) {
	args := audioHLSFFmpegArgs("input.wav", filepath.Join("cache", "100%"), 2)
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
		{"-output_ts_offset", "12.000"},
		{"-start_number", "2"},
		{"-map", "0:a:0"},
		{"-c:a", "aac"},
		{"-ac", "2"},
		{"-f", "hls"},
		{"-hls_time", "6"},
		{"-hls_flags", "temp_file"},
		{"-hls_segment_filename", filepath.Join("cache", "100%%", "segment-%06d.ts")},
	} {
		if !hasPair(expected[0], expected[1]) {
			t.Fatalf("FFmpeg args do not contain %q %q: %v", expected[0], expected[1], args)
		}
	}
	if last := args[len(args)-1]; last != filepath.Join("cache", "100%", audioHLSSessionPlaylist) {
		t.Fatalf("playlist output = %q", last)
	}
}

func TestAudioHLSSessionStopsAheadOfTheListenerOrAtEarlierOutput(t *testing.T) {
	newSession := func(dir string, start int) *audioHLSSession {
		return &audioHLSSession{
			dir: dir, start: start, startedAt: time.Now(), next: start, requested: start,
			changed: make(chan struct{}),
		}
	}
	writeSegments := func(dir string, from int, to int, modified time.Time) {
		for index := from; index < to; index++ {
			path := filepath.Join(dir, hlsSegmentName(index))
			if err := os.WriteFile(path, []byte{0x47}, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(path, modified, modified); err != nil {
				t.Fatal(err)
			}
		}
	}

	ahead := t.TempDir()
	session := newSession(ahead, 4)
	writeSegments(ahead, 4, 4+audioHLSAheadSegments+5, time.Now().Add(time.Second))
	if !advanceAudioHLSSession(session) || session.next != 4+audioHLSAheadSegments {
		t.Fatalf("session ahead of the listener: next = %d, want %d and a stop", session.next, 4+audioHLSAheadSegments)
	}
	session.observe(10)
	if advanceAudioHLSSession(session) || session.next != 4+audioHLSAheadSegments+5 {
		t.Fatalf("listener moved on: next = %d, want %d and no stop", session.next, 4+audioHLSAheadSegments+5)
	}

	earlier := t.TempDir()
	session = newSession(earlier, 0)
	writeSegments(earlier, 0, 2, time.Now().Add(time.Second))
	writeSegments(earlier, 2, 3, time.Now().Add(-time.Hour))
	if !advanceAudioHLSSession(session) || session.next != 2 {
		t.Fatalf("session reaching earlier output: next = %d, want 2 and a stop", session.next)
	}
}

func TestTranscodeCacheCountsStaleAudioHLSPartials(t *testing.T) {
	cacheRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{CacheRoot: cacheRoot})
	writeCacheTestFile(t, cacheRoot, "transcodes/hls-audio/1/revision/segment-000003.ts.tmp", "stale", time.Hour)
	writeCacheTestFile(t, cacheRoot, "transcodes/hls-audio/1/revision/"+audioHLSSessionPlaylist, "stale", time.Hour)
	writeCacheTestFile(t, cacheRoot, "transcodes/hls-audio/2/revision/segment-000004.ts.tmp", "active", 0)
	writeCacheTestFile(t, cacheRoot, "transcodes/hls-audio/2/revision/segment-000003.ts", "done", 0)
	overview, err := server.scanTranscodeCache(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if overview.Files != 3 {
		t.Fatalf("scanned %d files, want two stale partials and one segment", overview.Files)
	}
}

func TestAudioHLSStartsAtALaterSegmentAndContinuesOneEncode(t *testing.T) {
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
	relativePath := filepath.ToSlash(filepath.Join("RJ00000000", "long.wav"))
	mediaPath := filepath.Join(dataRoot, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(ffmpegPath,
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100",
		"-t", "40", "-ac", "2", "-c:a", "pcm_s16le", "-y", mediaPath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create audio fixture: %v (%s)", err, output)
	}

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (811, 'RJ00000000', 'Synthetic HLS audio');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (812, 'synthetic_local', 'Synthetic Local', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint, duration_seconds, has_audio)
		VALUES (813, 811, 'audio', 'long.wav', 'synthetic-hls-audio', 40, 1);
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, duration_seconds)
		VALUES (814, 813, 812, 'local', ?, 'available', 40);
	`, relativePath); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	serve := func(file string, query string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/media/814/hls/"+file+query, nil)
		request.SetPathValue("id", "814")
		request.SetPathValue("file", file)
		response := httptest.NewRecorder()
		server.serveMediaHLS(response, request)
		return response
	}

	playlist := serve("index.m3u8", "")
	if playlist.Code != http.StatusOK || playlist.Header().Get("X-Kikoto-Playback-Delivery") != "transcoded" {
		t.Fatalf("playlist response = %d, headers %v", playlist.Code, playlist.Header())
	}
	match := regexp.MustCompile(`segment-000006\.ts\?v=([0-9a-f]+)`).FindStringSubmatch(playlist.Body.String())
	if match == nil || strings.Contains(playlist.Body.String(), "segment-000007") {
		t.Fatalf("playlist does not end at segment 6:\n%s", playlist.Body.String())
	}
	revision := match[1]

	later := serve("segment-000003.ts", "?v="+revision)
	if later.Code != http.StatusOK || later.Body.Len() == 0 || later.Body.Bytes()[0] != 0x47 {
		t.Fatalf("later segment response = %d, %d bytes: %s", later.Code, later.Body.Len(), later.Body.String())
	}
	segmentRoot := filepath.Join(cacheRoot, "transcodes", "hls-audio", "814", revision)
	for index := 0; index < 3; index++ {
		if _, err := os.Stat(filepath.Join(segmentRoot, hlsSegmentName(index))); !os.IsNotExist(err) {
			t.Fatalf("requesting segment 3 unexpectedly created segment %d", index)
		}
	}

	// The same encode continues to the end of the file and then exits.
	deadline := time.Now().Add(20 * time.Second)
	for server.audioHLS.get("814/"+revision) != nil {
		if time.Now().After(deadline) {
			t.Fatal("audio HLS session did not finish")
		}
		time.Sleep(20 * time.Millisecond)
	}
	entries, err := os.ReadDir(segmentRoot)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if strings.Join(names, ",") != "segment-000003.ts,segment-000004.ts,segment-000005.ts,segment-000006.ts" {
		t.Fatalf("session left %v", names)
	}
	output, err := exec.Command(ffprobePath, "-v", "error", "-show_entries", "format=start_time",
		"-of", "csv=p=0", filepath.Join(segmentRoot, hlsSegmentName(5))).Output()
	if err != nil {
		t.Fatal(err)
	}
	if start, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64); err != nil || start < 29.9 || start > 30.1 {
		t.Fatalf("segment 5 starts at %q, want the shared timeline's 30 seconds", output)
	}

	next := serve("segment-000004.ts", "?v="+revision)
	if next.Code != http.StatusOK || next.Body.Len() == 0 || next.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
		t.Fatalf("produced segment response = %d, %d bytes", next.Code, next.Body.Len())
	}
	if server.audioHLS.get("814/"+revision) != nil {
		t.Fatal("serving a produced segment started another session")
	}
}
