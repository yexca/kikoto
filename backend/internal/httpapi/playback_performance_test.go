package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// This isolates playback handlers and the global browser player, and separately
// measures the full authenticated local Range route. Browser app APIs are mocked.
func TestPlaybackStartupPerformance(t *testing.T) {
	if os.Getenv("KIKOTO_PLAYBACK_PERF") != "1" {
		t.Skip("opt-in playback experiment")
	}
	frontend, err := filepath.Abs("../../../frontend")
	if err != nil {
		t.Fatal(err)
	}
	if root := os.Getenv("KIKOTO_PERF_FRONTEND"); root != "" {
		frontend = root
	}
	input := createSyntheticAAC(t, "300")
	wav := filepath.Join(t.TempDir(), "track.wav")
	// Five seconds of generated PCM, long enough for Chromium's playing event.
	data := make([]byte, 44+8000*5*2)
	copy(data, testWAVBytes()[:44])
	writeLE := func(offset, value int) {
		for i := range 4 {
			data[offset+i] = byte(value >> (8 * i))
		}
	}
	writeLE(4, len(data)-8)
	writeLE(40, len(data)-44)
	if err := os.WriteFile(wav, data, 0o600); err != nil {
		t.Fatal(err)
	}
	var upstreamRequests atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests.Add(1)
		time.Sleep(200 * time.Millisecond)
		w.Header().Set("Content-Type", "audio/wav")
		http.ServeContent(w, r, "track.wav", time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), bytes.NewReader(data))
	}))
	defer upstream.Close()
	remote := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/track.wav")
	key := remote.remoteWorkCacheKey(context.Background(), 7, "RJ00000000")
	snapshot := remote.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: upstream.URL + "/track.wav"}}
	snapshot.ExpiresAt = time.Now().Add(10 * time.Minute)
	remote.remoteWorkTracksCache[key] = snapshot
	workSnapshot := remote.remoteWorkCache[key]
	workSnapshot.ExpiresAt = snapshot.ExpiresAt
	remote.remoteWorkCache[key] = workSnapshot
	db := openMigratedTestDBWithProductionPool(t)
	testfixture.SeedBrowse(t, db)
	dataRoot := t.TempDir()
	mediaRoot := filepath.Join(dataRoot, testfixture.WorkCodeAt(0))
	if err := os.MkdirAll(mediaRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	aac, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	input = filepath.Join(mediaRoot, "track.aac")
	wav = filepath.Join(mediaRoot, "track.wav")
	if err := os.WriteFile(input, aac, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(wav, data, 0o600); err != nil {
		t.Fatal(err)
	}
	for i, name := range []string{"track.wav", "track.aac"} {
		if _, err := db.Exec(`UPDATE media_file_location SET path=? WHERE id=?`, testfixture.WorkCodeAt(0)+"/"+name, i+1); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{Mode: config.ModeProduction, DataRoot: dataRoot, CacheRoot: t.TempDir(), StaticDir: filepath.Join(frontend, "dist")})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	var revision int64
	prepare := func(cold bool) error {
		if cold {
			changed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(atomic.AddInt64(&revision, 1)) * time.Second)
			return os.Chtimes(input, changed, changed)
		}
		info, err := os.Stat(input)
		if err != nil {
			return err
		}
		file, err := server.openCompatibleAudio(context.Background(), input, info)
		if err == nil {
			err = file.Close()
		}
		return err
	}
	// Include authentication and media target lookup, beyond isolated handler spans.
	authHost := httptest.NewServer(server.Routes())
	authClient := &http.Client{Timeout: 30 * time.Second}
	for _, scenario := range []struct {
		name  string
		id, n int
		cold  bool
	}{
		{"direct", 1, 60, false}, {"compatible-cold", 2, 12, true}, {"compatible-warm", 2, 60, false},
	} {
		var first, complete []time.Duration
		for i := range scenario.n + 3 {
			if scenario.cold {
				if err := prepare(true); err != nil {
					t.Fatal(err)
				}
			}
			request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/api/media/%d/stream?profile=audio&forceDirect=1", authHost.URL, scenario.id), nil)
			if err != nil {
				t.Fatal(err)
			}
			request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "synthetic-token"})
			request.Header.Set("Range", "bytes=0-4095")
			start := time.Now()
			response, err := authClient.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			headers := time.Since(start)
			count, err := io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != 206 || count != 4096 {
				t.Fatalf("authenticated range: %d %d %v", response.StatusCode, count, err)
			}
			if scenario.id == 2 && response.Header.Get("Content-Type") != "audio/mpeg" {
				t.Fatalf("compatible Range did not transcode AAC: %v", response.Header)
			}
			if i >= 3 {
				first = append(first, headers)
				complete = append(complete, time.Since(start))
			}
		}
		logBrowseTiming(t, "playback/authenticated/"+scenario.name+"/first-range-headers", first, 1, 0)
		logBrowseTiming(t, "playback/authenticated/"+scenario.name+"/complete-range-4KiB", complete, 1, 0)
	}
	authHost.Close()
	var mu sync.Mutex
	spans := map[string][]time.Duration{}
	streamHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/perf/control" {
			if err := prepare(r.URL.Query().Get("cold") == "1"); err != nil {
				http.Error(w, "preparation failed", 500)
				return
			}
			w.WriteHeader(204)
			return
		}
		kind := r.PathValue("kind")
		spanKind := kind
		if kind == "compatible" {
			info, err := os.Stat(input)
			if err != nil {
				http.Error(w, "source unavailable", 500)
				return
			}
			spanKind = "compatible-cold"
			if validCachedAudio(filepath.Join(server.cfg.CacheRoot, filepath.FromSlash(audioTranscodeCachePath(input, info)))) {
				spanKind = "compatible-warm"
			}
		}
		start := time.Now()
		writer := &playbackTimingWriter{ResponseWriter: w, onHeaders: func() { mu.Lock(); spans[spanKind] = append(spans[spanKind], time.Since(start)); mu.Unlock() }}
		if kind == "remote" {
			r.SetPathValue("id", "7")
			r.SetPathValue("code", "RJ00000000")
			q := r.URL.Query()
			q.Set("path", "track.wav")
			r.URL.RawQuery = q.Encode()
			remote.streamRemoteSourceMedia(writer, r)
			return
		}
		path := wav
		if kind == "compatible" {
			path = input
		}
		server.serveAutomaticLocalPlayback(writer, r, mediaStreamTarget{Kind: "audio", RelativePath: filepath.Base(path)}, path)
	})
	mux := http.NewServeMux()
	mux.Handle("/api/perf/control", streamHandler)
	mux.Handle("/api/perf/{kind}/stream", streamHandler)
	host := httptest.NewServer(server.staticAppHandler(mux))
	defer host.Close()
	client := &http.Client{Timeout: 30 * time.Second}
	measure := func(kind string, n int, cold bool) {
		var headers, complete []time.Duration
		for range n {
			if cold {
				if err := prepare(true); err != nil {
					t.Fatal(err)
				}
			}
			request, err := http.NewRequest(http.MethodGet, host.URL+"/api/perf/"+kind+"/stream?profile=audio&forceDirect=1", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("Range", "bytes=0-4095")
			start := time.Now()
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			headers = append(headers, time.Since(start))
			count, err := io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != 206 || count != 4096 {
				t.Fatalf("Range contract %s: %d %d %v", kind, response.StatusCode, count, err)
			}
			complete = append(complete, time.Since(start))
		}
		name := fmt.Sprintf("playback/%s/cold=%t", kind, cold)
		logBrowseTiming(t, name+"/first-range-headers", headers, 1, 0)
		logBrowseTiming(t, name+"/complete-range-4KiB", complete, 1, 0)
	}
	measure("local", 60, false)
	measure("remote", 60, false)
	measure("compatible", 12, true)
	measure("compatible", 60, false)
	var queues []time.Duration
	for range 12 {
		var releases []func()
		for range realtimeTranscodeSlotsSize {
			release, err := server.acquireRealtimeTranscode(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			releases = append(releases, release)
		}
		timer := time.AfterFunc(250*time.Millisecond, func() {
			for _, release := range releases {
				release()
			}
		})
		start := time.Now()
		release, err := server.acquireRealtimeTranscode(context.Background())
		timer.Stop()
		if err != nil {
			t.Fatal(err)
		}
		queues = append(queues, time.Since(start))
		release()
	}
	logBrowseTiming(t, "playback/isolated-transcode-queue/two-slots-held-250ms", queues, 1, 0)
	// Isolate FFmpeg execution from queueing, quota, probe and publication. These
	// samples cannot be added to the independent end-to-end Range measurements.
	var encodes []time.Duration
	var cpu time.Duration
	outputPath := filepath.Join(t.TempDir(), "prepared.mp3")
	for range 12 {
		command := exec.Command("ffmpeg", compatibleAudioFFmpegArgs(input, outputPath, audioTranscodeMaximumBytes)...)
		start := time.Now()
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("isolated preparation: %v %s", err, output)
		}
		encodes = append(encodes, time.Since(start))
		cpu += command.ProcessState.UserTime() + command.ProcessState.SystemTime()
	}
	logBrowseTiming(t, "playback/isolated-300s-aac-encoder", encodes, 1, 0)
	encodedInfo, err := os.Stat(outputPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("isolated preparation resources: CPU/sample=%.2fms output/sample=%d bytes", float64(cpu)/float64(12*time.Millisecond), encodedInfo.Size())
	command := exec.Command("node", filepath.Join(frontend, "node_modules", "@playwright", "test", "cli.js"), "test", "tests/e2e/playback-production-performance.spec.ts", "--project=desktop-chromium", "--workers=1")
	command.Dir = frontend
	command.Env = append(os.Environ(), "PLAYWRIGHT_BASE_URL="+host.URL, "KIKOTO_PLAYBACK_BROWSER_PERF=1")
	output, err := command.CombinedOutput()
	t.Log(string(output))
	if err != nil {
		t.Fatalf("production browser: %v", err)
	}
	var cacheBytes int64
	var cacheFiles int
	if err := filepath.WalkDir(server.cfg.CacheRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && strings.HasSuffix(path, ".mp3") {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			cacheBytes += info.Size()
			cacheFiles++
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	for kind, times := range spans {
		logBrowseTiming(t, "playback/server-first-headers/"+kind, times, 1, 0)
	}
	mu.Unlock()
	t.Logf("resources: upstream requests=%d cache files=%d cache bytes=%d; synthetic 300s AAC -> complete MP3, two transcode slots, no background workers, no pre-preparation except explicit warm control; no NAS/device coverage", upstreamRequests.Load(), cacheFiles, cacheBytes)
}

// This measures video HLS through the playback info and segment handlers for
// two synthetic 240-second 1080p 29.97 fps files: an MPEG-4 Part 2 AVI with MP3
// audio, which is transcoded, and an H.264 High MKV with 5.1 AC3 audio, which a
// client that decodes H.264 High cannot play directly. It reports time to the
// first segment, seek-to-play latency, sequential segment delivery, and FFmpeg
// CPU per minute of video. Each sample uses a new source revision, so nothing
// is served from the cache.
func TestVideoHLSPlaybackPerformance(t *testing.T) {
	if os.Getenv("KIKOTO_PLAYBACK_PERF") != "1" {
		t.Skip("opt-in playback experiment")
	}
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	const durationSeconds = 240
	dataRoot := t.TempDir()
	// Temporal noise keeps the encoders from coasting on the static test pattern.
	source := []string{
		"-nostdin", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30000/1001,noise=alls=6:allf=t",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", strconv.Itoa(durationSeconds),
	}
	fixtures := []struct {
		name, file string
		location   int64
		encode     []string
	}{
		{"mpeg4-avi", "movie.avi", 824, []string{"-c:v", "mpeg4", "-q:v", "4", "-c:a", "libmp3lame", "-b:a", "192k"}},
		{"h264-mkv-ac3", "movie.mkv", 828, []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-c:a", "ac3", "-ac", "6", "-b:a", "448k"}},
	}
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (821, 'RJ00000000', 'Synthetic HLS video performance');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (822, 'synthetic_local', 'Synthetic Local', 'local_folder');
	`); err != nil {
		t.Fatal(err)
	}
	for index, fixture := range fixtures {
		mediaPath := filepath.Join(dataRoot, "RJ00000000", fixture.file)
		if err := os.MkdirAll(filepath.Dir(mediaPath), 0o755); err != nil {
			t.Fatal(err)
		}
		command := exec.Command(ffmpegPath, append(append(slices.Clone(source), fixture.encode...), "-y", mediaPath)...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("create %s fixture: %v (%s)", fixture.name, err, output)
		}
		item := 823 + int64(index)*4
		if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title, fingerprint, duration_seconds, has_audio) VALUES (?, 821, 'video', ?, ?, 240, 1)`,
			item, fixture.file, "synthetic-hls-video-performance-"+fixture.name); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, duration_seconds) VALUES (?, ?, 822, 'local', ?, 'available', 240)`,
			fixture.location, item, "RJ00000000/"+fixture.file); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir()})
	defer func() { _ = server.Shutdown(context.Background()) }()
	var revisionCount int64
	for _, fixture := range fixtures {
		mediaPath := filepath.Join(dataRoot, "RJ00000000", fixture.file)
		location := strconv.FormatInt(fixture.location, 10)
		// coldPlaylist changes the file version, so every segment must be
		// prepared again, and returns the playlist the player would load.
		conversion := ""
		var infos []time.Duration
		coldPlaylist := func() (string, []string) {
			server.hlsSessions.stopAll()
			changed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(atomic.AddInt64(&revisionCount, 1)) * time.Second)
			if err := os.Chtimes(mediaPath, changed, changed); err != nil {
				t.Fatal(err)
			}
			server.realtimeProbeCacheMu.Lock()
			server.realtimeProbeCache = nil
			server.realtimeProbeCacheMu.Unlock()
			request := httptest.NewRequest(http.MethodGet, "/api/media/"+location+"/playback?capabilities=video-mp4-h264-aac,video-h264-main,video-h264-high", nil)
			request.SetPathValue("id", location)
			response := httptest.NewRecorder()
			infoStart := time.Now()
			server.getVideoPlaybackInfo(response, request)
			infos = append(infos, time.Since(infoStart))
			var info videoPlaybackInfoResponse
			if err := json.Unmarshal(response.Body.Bytes(), &info); err != nil || info.Delivery != "hls" {
				t.Fatalf("%s playback info = %d: %s", fixture.name, response.Code, response.Body.String())
			}
			playlistURL, err := url.Parse(info.URL)
			if err != nil {
				t.Fatal(err)
			}
			request = httptest.NewRequest(http.MethodGet, info.URL, nil)
			request.SetPathValue("id", location)
			request.SetPathValue("file", "index.m3u8")
			response = httptest.NewRecorder()
			server.serveMediaHLS(response, request)
			segments := regexp.MustCompile(`segment-[0-9]{6}\.ts`).FindAllString(response.Body.String(), -1)
			if response.Code != http.StatusOK || len(segments) == 0 {
				t.Fatalf("%s playlist = %d: %s", fixture.name, response.Code, response.Body.String())
			}
			conversion = info.Conversion
			return playlistURL.Query().Get("v"), segments
		}
		segment := func(revision string, file string) time.Duration {
			request := httptest.NewRequest(http.MethodGet, "/api/media/"+location+"/hls/"+file+"?v="+revision, nil)
			request.SetPathValue("id", location)
			request.SetPathValue("file", file)
			response := httptest.NewRecorder()
			start := time.Now()
			server.serveMediaHLS(response, request)
			elapsed := time.Since(start)
			if response.Code != http.StatusOK || response.Body.Len() == 0 || response.Body.Bytes()[0] != 0x47 {
				t.Fatalf("%s %s response = %d: %s", fixture.name, file, response.Code, response.Body.String())
			}
			return elapsed
		}

		coldPlaylist()
		name := "playback/video-hls/" + fixture.name + "/" + conversion
		var first, seeks, sequential []time.Duration
		for range 6 {
			revision, segments := coldPlaylist()
			first = append(first, segment(revision, segments[0]))
		}
		logBrowseTiming(t, name+"/cold-first-segment", first, 1, 0)
		logBrowseTiming(t, name+"/cold-playback-info", infos, 1, 0)
		var segmentCount int
		for range 6 {
			revision, segments := coldPlaylist()
			segmentCount = len(segments)
			segment(revision, segments[0])
			// Three quarters of the way through the file.
			seeks = append(seeks, segment(revision, segments[len(segments)*3/4]))
		}
		logBrowseTiming(t, name+"/cold-seek-to-three-quarters", seeks, 1, 0)
		// The first half of the file, in order.
		var sequentialTotal time.Duration
		var sequentialSeconds float64
		for range 2 {
			revision, segments := coldPlaylist()
			count := len(segments) / 2
			start := time.Now()
			for _, file := range segments[:count] {
				sequential = append(sequential, segment(revision, file))
			}
			sequentialTotal += time.Since(start)
			sequentialSeconds += float64(count) * durationSeconds / float64(len(segments))
		}
		logBrowseTiming(t, name+"/cold-sequential-segment", sequential, 1, 0)
		t.Logf("%s/cold-sequential first half of %d segments: %.2fs per run, %.1fx realtime",
			name, segmentCount, sequentialTotal.Seconds()/2, sequentialSeconds/sequentialTotal.Seconds())
		server.hlsSessions.stopAll()

		// Isolate FFmpeg from queueing, quota, probe and publication to measure
		// the CPU one continuous encode spends on each minute of video.
		cpu, wall := measureVideoHLSEncoderCPU(t, server, fixture.location, mediaPath, durationSeconds, conversion == "remux")
		t.Logf("%s/isolated-encoder %ds: wall=%.2fs CPU=%.2fs CPU/min-of-video=%.2fs realtime=%.1fx host-cores=%d",
			name, durationSeconds, wall.Seconds(), cpu.Seconds(), cpu.Seconds()*60/durationSeconds, durationSeconds/wall.Seconds(), runtime.NumCPU())
	}
}

// measureVideoHLSEncoderCPU runs the remux of a source that playback info
// remuxes, and the transcode of any other, over the whole file.
func measureVideoHLSEncoderCPU(t *testing.T, server *Server, location int64, mediaPath string, durationSeconds float64, remux bool) (time.Duration, time.Duration) {
	t.Helper()
	args := videoHLSFFmpegArgs(mediaPath, t.TempDir(), 0, durationSeconds)
	if remux {
		source, err := server.loadHLSPlaybackSource(context.Background(), location)
		if err != nil {
			t.Fatal(err)
		}
		index, err := server.videoKeyframeIndex(context.Background(), source, time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		// Past the listed cuts, the last segment runs to the end of the file.
		args = videoRemuxHLSFFmpegArgs(mediaPath, t.TempDir(), 0, index)
	}
	command := exec.Command("ffmpeg", args...)
	start := time.Now()
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("isolated encode: %v %s", err, output)
	}
	return command.ProcessState.UserTime() + command.ProcessState.SystemTime(), time.Since(start)
}

type playbackTimingWriter struct {
	http.ResponseWriter
	onHeaders func()
	once      sync.Once
}

func (w *playbackTimingWriter) WriteHeader(status int) {
	w.once.Do(w.onHeaders)
	w.ResponseWriter.WriteHeader(status)
}
func (w *playbackTimingWriter) Write(body []byte) (int, error) {
	w.once.Do(w.onHeaders)
	return w.ResponseWriter.Write(body)
}
func (w *playbackTimingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
