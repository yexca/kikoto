package httpapi

import (
	"bytes"
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

func TestHLSSegmentFFmpegArgsBoundOldDeviceProfile(t *testing.T) {
	args := hlsSegmentFFmpegArgs("input.avi", 12, 2)
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
		{"-c:a", "aac"},
		{"-ac", "2"},
		{"-output_ts_offset", "12.000"},
	} {
		if !hasPair(expected[0], expected[1]) {
			t.Fatalf("FFmpeg args do not contain %q %q: %v", expected[0], expected[1], args)
		}
	}
	filter := "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2:x=0:y=0"
	if !hasPair("-vf", filter) {
		t.Fatalf("FFmpeg args do not contain the bounded 720p filter: %v", args)
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
	server.serveVideoHLS(firstResponse, firstRequest)
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
	server.serveVideoHLS(secondResponse, secondRequest)
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
	server.serveVideoHLS(staleResponse, staleRequest)
	if staleResponse.Code != http.StatusConflict || !strings.Contains(staleResponse.Body.String(), `"code":"playback_source_changed"`) {
		t.Fatalf("stale segment response = %d, %s", staleResponse.Code, staleResponse.Body.String())
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

func TestTranscodeCacheScanIncludesOnlyStalePartialSegments(t *testing.T) {
	cacheRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{CacheRoot: cacheRoot})
	readyPath := writeCacheTestFile(t, cacheRoot, "transcodes/hls/1/revision/segment-000000.ts", "ready", time.Hour)
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
	if overview.Files != 2 || overview.Bytes != int64(len("ready")+len("stale")) {
		t.Fatalf("transcode cache overview = %+v, want ready and stale partial files", overview)
	}
	paths := map[string]bool{}
	for _, entry := range entries {
		paths[filepath.ToSlash(entry.relPath)] = true
	}
	for _, expected := range []string{readyPath, stalePartialPath} {
		relPath, err := filepath.Rel(cacheRoot, expected)
		if err != nil {
			t.Fatal(err)
		}
		if !paths[filepath.ToSlash(relPath)] {
			t.Fatalf("transcode cache entries do not contain %q: %#v", relPath, paths)
		}
	}
}
