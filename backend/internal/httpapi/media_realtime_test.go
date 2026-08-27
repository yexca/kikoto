package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
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
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestDirectPlaybackContentTypeRequiresMatchingContainerCodecAndCapability(t *testing.T) {
	probe := playbackProbe{
		Format: playbackProbeFormat{FormatName: "mov,mp4,m4a"},
		Streams: []playbackProbeStream{
			{CodecType: "video", CodecName: "h264", PixelFmt: "yuv420p"},
			{CodecType: "audio", CodecName: "aac"},
		},
	}
	if contentType, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{capVideoMP4H264AAC: true}); !ok || contentType != "video/mp4" {
		t.Fatalf("compatible MP4 direct result = %q/%t", contentType, ok)
	}
	if _, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{}); ok {
		t.Fatal("direct playback should require an explicit browser capability")
	}
	probe.Format.FormatName = "avi"
	if _, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{capVideoMP4H264AAC: true}); ok {
		t.Fatal("AVI should be transcoded even when its video codec is H264")
	}
	probe.Format.FormatName = "mov,mp4,m4a"
	probe.Streams[1].CodecName = "eac3"
	if _, ok := directPlaybackContentType(probe, playbackProfileVideo, map[string]bool{capVideoMP4H264AAC: true}); ok {
		t.Fatal("unsupported audio codec should be transcoded")
	}
}

func TestDirectPlaybackContentTypeSupportsNativeFLACOggAudio(t *testing.T) {
	cases := []struct {
		name       string
		format     string
		codec      string
		capability string
		want       string
	}{
		{name: "flac", format: "flac", codec: "flac", capability: capAudioFLAC, want: "audio/flac"},
		{name: "ogg opus", format: "ogg", codec: "opus", capability: capAudioOggOpus, want: `audio/ogg; codecs="opus"`},
		{name: "ogg vorbis", format: "ogg", codec: "vorbis", capability: capAudioOggVorbis, want: `audio/ogg; codecs="vorbis"`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			probe := playbackProbe{
				Format:  playbackProbeFormat{FormatName: testCase.format},
				Streams: []playbackProbeStream{{CodecType: "audio", CodecName: testCase.codec}},
			}
			contentType, ok := directPlaybackContentType(probe, playbackProfileAudio, map[string]bool{testCase.capability: true})
			if !ok || contentType != testCase.want {
				t.Fatalf("native content type = %q/%t, want %q/true", contentType, ok, testCase.want)
			}
		})
	}
}

func TestRealtimeFFmpegArgsBoundThreadsMemoryAndOddDimensions(t *testing.T) {
	args := realtimeFFmpegArgs(playbackProfileVideo, "input.avi")
	hasPair := func(key string, value string) bool {
		for index := 0; index+1 < len(args); index++ {
			if args[index] == key && args[index+1] == value {
				return true
			}
		}
		return false
	}
	for _, expected := range [][2]string{
		{"-threads", "2"},
		{"-threads:v", "2"},
		{"-threads:a", "1"},
		{"-filter_threads", "1"},
		{"-max_alloc", "268435456"},
		{"-vf", "pad=width=ceil(iw/2)*2:height=ceil(ih/2)*2:x=0:y=0"},
	} {
		if !hasPair(expected[0], expected[1]) {
			t.Fatalf("FFmpeg args do not contain %q %q: %v", expected[0], expected[1], args)
		}
	}
}

func TestRemotePlaybackContentTypeFallsBackToKnownMediaExtensions(t *testing.T) {
	response := &http.Response{Header: http.Header{"Content-Type": []string{"application/octet-stream"}}}
	for path, want := range map[string]string{
		"track.wav": "audio/wav",
		"track.ogg": "audio/ogg",
		"clip.avi":  "video/x-msvideo",
		"clip.mkv":  "video/x-matroska",
	} {
		if got := remotePlaybackContentType(response, path); got != want {
			t.Fatalf("content type for %q = %q, want %q", path, got, want)
		}
	}
}

func TestServeAutomaticLocalPlaybackTranscodesToResponseWithoutCache(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	path := filepath.Join(dataRoot, "track.wav")
	if err := os.WriteFile(path, testWAVBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{CacheRoot: cacheRoot})
	target := mediaStreamTarget{Kind: "audio", RelativePath: "track.wav"}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio", nil)
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, target, path)
	if response.Code != http.StatusOK || len(response.Body.Bytes()) < 3 || string(response.Body.Bytes()[:3]) != "ID3" {
		t.Fatalf("transcoded response = %d, %d bytes, prefix %q", response.Code, response.Body.Len(), response.Body.String())
	}
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("realtime playback created cache entries: %v", entries)
	}
}

func TestServeAutomaticLocalPlaybackTranscodesAVI(t *testing.T) {
	ffmpegPath, ffmpegErr := exec.LookPath("ffmpeg")
	if ffmpegErr != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	aviPath := filepath.Join(dataRoot, "clip.avi")
	command := exec.Command(ffmpegPath,
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc=size=33x33:rate=2",
		"-t", "1", "-c:v", "ffv1", "-pix_fmt", "yuv444p", "-y", aviPath,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create AVI fixture: %v (%s)", err, output)
	}
	server := NewServer(nil, config.Config{CacheRoot: cacheRoot})
	probe, err := server.probePlaybackFile(context.Background(), aviPath)
	if err != nil {
		t.Fatal(err)
	}
	video := firstPlaybackStream(probe, "video")
	if video == nil || video.Width != 33 || video.Height != 33 {
		t.Fatalf("AVI fixture dimensions = %#v, want 33x33", video)
	}
	target := mediaStreamTarget{Kind: "video", RelativePath: "clip.avi"}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=video", nil)
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, target, aviPath)
	if response.Code != http.StatusOK || !bytes.Contains(response.Body.Bytes(), []byte("ftyp")) {
		t.Fatalf("AVI transcode response = %d, %d bytes", response.Code, response.Body.Len())
	}
	entries, err := os.ReadDir(cacheRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("AVI realtime playback created cache entries: %v", entries)
	}
}

func TestStreamRemoteSourceMediaDoesNotTranscodeWhenForced(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/media/track.wav" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(testWAVBytes())
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	key := remoteWorkCacheKey(7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: upstream.URL + "/media/track.wav"}}
	server.remoteWorkTracksCache[key] = snapshot
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio&forceTranscode=1", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	response := httptest.NewRecorder()
	server.streamRemoteSourceMedia(response, request)
	if response.Code != http.StatusOK || response.Body.String() != string(testWAVBytes()) {
		t.Fatalf("remote proxy response = %d, %d bytes", response.Code, response.Body.Len())
	}
	if response.Header().Get("Cache-Control") != "private, no-cache" || response.Header().Get("Accept-Ranges") == "none" {
		t.Fatalf("remote proxy headers = %#v", response.Header())
	}
}

func TestStreamRemoteSourceMediaProxiesNativeResponseAndRange(t *testing.T) {
	sourceBytes := testWAVBytes()
	upstreamRange := ""
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRange = r.Header.Get("Range")
		w.Header().Set("Content-Type", "audio/wav")
		if r.Header.Get("Range") == "bytes=44-51" {
			w.Header().Set("Content-Range", "bytes 44-51/1644")
			w.Header().Set("Accept-Ranges", "bytes")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(sourceBytes[44:52])
			return
		}
		_, _ = w.Write(sourceBytes)
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	key := remoteWorkCacheKey(7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: upstream.URL + "/media/track.wav"}}
	server.remoteWorkTracksCache[key] = snapshot
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	request.Header.Set("Range", "bytes=44-51")
	response := httptest.NewRecorder()
	server.streamRemoteSourceMedia(response, request)
	if response.Code != http.StatusPartialContent || response.Body.String() != string(sourceBytes[44:52]) {
		t.Fatalf("remote native response = %d/%q", response.Code, response.Body.String())
	}
	if upstreamRange != "bytes=44-51" || response.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("remote native range = %q/%q", upstreamRange, response.Header().Get("Accept-Ranges"))
	}
	if response.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("remote native cache header = %q", response.Header().Get("Cache-Control"))
	}
}

func TestStreamRemoteSourceMediaUsesRemoteDemoAdmissionForRemoteOnlyWork(t *testing.T) {
	tests := []struct {
		name              string
		code              string
		admitted          bool
		wantStatus        int
		wantBody          []byte
		wantTrackRequests int
		wantMediaRequests int
	}{
		{
			name:              "admitted remote-only work",
			code:              "RJ00000042",
			admitted:          true,
			wantStatus:        http.StatusOK,
			wantBody:          testWAVBytes(),
			wantTrackRequests: 1,
			wantMediaRequests: 1,
		},
		{
			name:              "work absent from filtered search",
			code:              "RJ00000043",
			admitted:          false,
			wantStatus:        http.StatusNotFound,
			wantTrackRequests: 0,
			wantMediaRequests: 0,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			var trackRequests, mediaRequests int
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasPrefix(r.URL.Path, "/api/search/"):
					keyword, err := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/api/search/"))
					if err != nil {
						t.Errorf("decode search keyword: %v", err)
					}
					wantKeyword := demoRemoteSourceFilterQuery + " " + testCase.code
					if keyword != wantKeyword {
						t.Errorf("search keyword = %q, want %q", keyword, wantKeyword)
					}
					works := []kikoeru.Work{}
					if testCase.admitted {
						paid := int64(900)
						works = append(works, kikoeru.Work{
							ID: 420, SourceID: testCase.code, Title: "Remote-only fixture",
							// Demo admission comes from the filtered search membership.
							AgeCategoryString: "adult", Price: &paid,
						})
					}
					_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: works})
				case r.URL.Path == "/api/tracks/420":
					trackRequests++
					_ = json.NewEncoder(w).Encode([]kikoeru.Track{{
						Type: "audio", Title: "track.wav", MediaStreamURL: "/media/track.wav",
					}})
				case r.URL.Path == "/media/track.wav":
					mediaRequests++
					w.Header().Set("Content-Type", "audio/wav")
					_, _ = w.Write(testWAVBytes())
				default:
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()

			db := openMigratedTestDB(t)
			if _, err := db.Exec(`
				INSERT INTO file_source (id, code, display_name, source_type, enabled)
				VALUES (7, 'remote_fixture', 'Remote fixture', 'kikoeru_compatible', 1)
			`); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`
				INSERT INTO file_source_endpoint (file_source_id, api_url, base_url, restrict_outbound_hosts)
				VALUES (7, ?, ?, 1)
			`, upstream.URL, upstream.URL); err != nil {
				t.Fatal(err)
			}
			server := NewServer(db, config.Config{Mode: config.ModeDemo})
			request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/"+testCase.code+"/media?path=track.wav&profile=audio", nil)
			request.SetPathValue("id", "7")
			request.SetPathValue("code", testCase.code)
			response := httptest.NewRecorder()
			server.streamRemoteSourceMedia(response, request)

			if response.Code != testCase.wantStatus {
				t.Fatalf("remote Demo status = %d, want %d; body = %s", response.Code, testCase.wantStatus, response.Body.String())
			}
			if testCase.wantBody != nil && !bytes.Equal(response.Body.Bytes(), testCase.wantBody) {
				t.Fatalf("remote Demo body = %d bytes, want %d", response.Body.Len(), len(testCase.wantBody))
			}
			if trackRequests != testCase.wantTrackRequests || mediaRequests != testCase.wantMediaRequests {
				t.Fatalf("upstream track/media requests = %d/%d, want %d/%d", trackRequests, mediaRequests, testCase.wantTrackRequests, testCase.wantMediaRequests)
			}
			var localWorks int
			if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&localWorks); err != nil {
				t.Fatal(err)
			}
			if localWorks != 0 {
				t.Fatalf("remote preview materialized %d local works", localWorks)
			}
		})
	}
}

func TestStreamRemoteSourceMediaPreservesConditionalAndRangeStatuses(t *testing.T) {
	tests := []struct {
		name           string
		requestHeader  string
		requestValue   string
		responseStatus int
		responseHeader string
		responseValue  string
	}{
		{
			name: "not modified", requestHeader: "If-None-Match", requestValue: `"fixture"`,
			responseStatus: http.StatusNotModified, responseHeader: "ETag", responseValue: `"fixture"`,
		},
		{
			name: "range not satisfiable", requestHeader: "Range", requestValue: "bytes=9999-",
			responseStatus: http.StatusRequestedRangeNotSatisfiable, responseHeader: "Content-Range", responseValue: "bytes */1644",
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if value := r.Header.Get(testCase.requestHeader); value != testCase.requestValue {
					t.Errorf("forwarded %s = %q, want %q", testCase.requestHeader, value, testCase.requestValue)
				}
				w.Header().Set(testCase.responseHeader, testCase.responseValue)
				w.WriteHeader(testCase.responseStatus)
			}))
			defer upstream.Close()
			server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
			key := remoteWorkCacheKey(7, "RJ00000000")
			snapshot := server.remoteWorkTracksCache[key]
			snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: upstream.URL + "/media/track.wav"}}
			server.remoteWorkTracksCache[key] = snapshot
			request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio", nil)
			request.SetPathValue("id", "7")
			request.SetPathValue("code", "RJ00000000")
			request.Header.Set(testCase.requestHeader, testCase.requestValue)
			response := httptest.NewRecorder()
			server.streamRemoteSourceMedia(response, request)
			if response.Code != testCase.responseStatus || response.Body.Len() != 0 {
				t.Fatalf("proxy status/body = %d/%d", response.Code, response.Body.Len())
			}
			if value := response.Header().Get(testCase.responseHeader); value != testCase.responseValue {
				t.Fatalf("proxy %s = %q, want %q", testCase.responseHeader, value, testCase.responseValue)
			}
		})
	}
}

func TestStreamRemoteSourceMediaRejectsUnconfiguredOrigin(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests++
		_, _ = w.Write(testWAVBytes())
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	key := remoteWorkCacheKey(7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: "https://media.invalid/track.wav"}}
	server.remoteWorkTracksCache[key] = snapshot
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	response := httptest.NewRecorder()
	server.streamRemoteSourceMedia(response, request)
	if response.Code != http.StatusBadGateway || upstreamRequests != 0 {
		t.Fatalf("blocked remote status/requests = %d/%d", response.Code, upstreamRequests)
	}
}

func TestStreamRemoteSourceMediaRejectsOversizedResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.FormatInt((int64(defaultRemoteDownloadLimitGB)<<30)+1, 10))
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	key := remoteWorkCacheKey(7, "RJ00000000")
	snapshot := server.remoteWorkTracksCache[key]
	snapshot.Tracks = []kikoeru.Track{{Type: "audio", Title: "track.wav", MediaStreamURL: upstream.URL + "/media/track.wav"}}
	server.remoteWorkTracksCache[key] = snapshot
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/media?path=track.wav&profile=audio", nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	response := httptest.NewRecorder()
	server.streamRemoteSourceMedia(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized remote status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestServeRemotePlaybackResponseDoesNotWritePastStreamLimit(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		body    string
		wantErr bool
	}{
		{name: "at limit", body: "1234", wantErr: false},
		{name: "over limit", body: "12345", wantErr: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			upstream := &http.Response{
				StatusCode:    http.StatusOK,
				Header:        http.Header{"Content-Type": []string{"audio/wav"}},
				Body:          io.NopCloser(bytes.NewBufferString(testCase.body)),
				ContentLength: -1,
			}
			request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio", nil)
			response := httptest.NewRecorder()
			err := new(Server).serveRemotePlaybackResponse(response, request, upstream, "track.wav", 4)
			if (err != nil) != testCase.wantErr {
				t.Fatalf("stream limit error = %v, want error %t", err, testCase.wantErr)
			}
			if response.Body.String() != "1234" {
				t.Fatalf("streamed body = %q, want 4 bytes", response.Body.String())
			}
		})
	}
}

func TestStreamMediaUsesTrackedDownloadURLWhenStreamURLIsEmpty(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "audio/wav")
		_, _ = w.Write(testWAVBytes())
	}))
	defer upstream.Close()
	db := openMigratedTestDB(t)
	insertTrackedRemotePlaybackFixture(t, db, upstream.URL, true)
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/media/804/stream?profile=audio", nil)
	request.SetPathValue("id", "804")
	response := httptest.NewRecorder()
	server.streamMedia(response, request)
	if response.Code != http.StatusOK || response.Body.String() != string(testWAVBytes()) {
		t.Fatalf("tracked download fallback response = %d/%d", response.Code, response.Body.Len())
	}
}

func TestStreamMediaRejectsDisabledTrackedRemoteSource(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests++
		_, _ = w.Write(testWAVBytes())
	}))
	defer upstream.Close()
	db := openMigratedTestDB(t)
	insertTrackedRemotePlaybackFixture(t, db, upstream.URL, false)
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/media/804/stream?profile=audio", nil)
	request.SetPathValue("id", "804")
	response := httptest.NewRecorder()
	server.streamMedia(response, request)
	if response.Code != http.StatusNotFound || upstreamRequests != 0 {
		t.Fatalf("disabled remote status/requests = %d/%d", response.Code, upstreamRequests)
	}
}

func TestStreamMediaRejectsTrackedNonRemoteSource(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests++
		_, _ = w.Write(testWAVBytes())
	}))
	defer upstream.Close()
	db := openMigratedTestDB(t)
	insertTrackedRemotePlaybackFixture(t, db, upstream.URL, true)
	if _, err := db.Exec(`UPDATE file_source SET source_type = 'local_folder' WHERE id = 802`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/media/804/stream?profile=audio", nil)
	request.SetPathValue("id", "804")
	response := httptest.NewRecorder()
	server.streamMedia(response, request)
	if response.Code != http.StatusNotFound || upstreamRequests != 0 {
		t.Fatalf("non-remote source status/requests = %d/%d", response.Code, upstreamRequests)
	}
}

func insertTrackedRemotePlaybackFixture(t *testing.T, db *sql.DB, mediaURL string, enabled bool) {
	t.Helper()
	statements := []struct {
		query string
		args  []any
	}{
		{query: `INSERT INTO work (id, primary_code, title) VALUES (801, 'RJ00000001', 'Tracked playback fixture')`},
		{query: `INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (802, 'tracked_remote', 'Tracked remote', 'kikoeru_compatible', ?)`, args: []any{enabled}},
		{query: `INSERT INTO file_source_endpoint (file_source_id, api_url, base_url, restrict_outbound_hosts) VALUES (802, ?, ?, 1)`, args: []any{mediaURL, mediaURL}},
		{query: `INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (803, 801, 'audio', 'Track', 'tracked-playback-fixture')`},
		{query: `INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, stream_url, download_url, availability) VALUES (804, 803, 802, 'remote_stream', 'track.wav', '', ?, 'available')`, args: []any{mediaURL}},
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRealtimeTranscodeQueueRejectsPromptlyWhenSlotsAreFull(t *testing.T) {
	server := NewServer(nil, config.Config{})
	leases := make([]func(), 0, realtimeTranscodeSlotsSize)
	for range realtimeTranscodeSlotsSize {
		release, err := server.acquireRealtimeTranscode(context.Background())
		if err != nil {
			t.Fatalf("acquire transcode slot: %v", err)
		}
		leases = append(leases, release)
	}
	defer func() {
		for _, release := range leases {
			release()
		}
	}()

	started := time.Now()
	_, err := server.acquireRealtimeTranscode(context.Background())
	if !errors.Is(err, errRealtimeResourceBusy) {
		t.Fatalf("full transcode queue error = %v, want resource busy", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("full transcode queue waited %v", elapsed)
	}
}

func TestRealtimeProbeQueueRejectsPromptlyWhenSlotsAreFull(t *testing.T) {
	server := NewServer(nil, config.Config{})
	leases := make([]func(), 0, realtimeProbeSlotsSize)
	for range realtimeProbeSlotsSize {
		release, err := server.acquireRealtimeProbe(context.Background())
		if err != nil {
			t.Fatalf("acquire probe slot: %v", err)
		}
		leases = append(leases, release)
	}
	defer func() {
		for _, release := range leases {
			release()
		}
	}()

	started := time.Now()
	_, err := server.acquireRealtimeProbe(context.Background())
	if !errors.Is(err, errRealtimeResourceBusy) {
		t.Fatalf("full probe queue error = %v, want resource busy", err)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("full probe queue waited %v", elapsed)
	}
}

func TestStreamFFmpegFileRejectsImmediatelyWhenQueueIsFull(t *testing.T) {
	server := NewServer(nil, config.Config{})
	server.realtimeTranscodeSlots = make(chan struct{}, realtimeTranscodeSlotsSize)
	server.realtimeTranscodeQueue = make(chan struct{}, realtimeTranscodeQueueSize)
	for range realtimeTranscodeSlotsSize {
		server.realtimeTranscodeSlots <- struct{}{}
	}
	for range realtimeTranscodeQueueSize {
		server.realtimeTranscodeQueue <- struct{}{}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio", nil)
	response := httptest.NewRecorder()
	started := time.Now()
	err := server.streamFFmpegFile(response, request, "unused", playbackProfileAudio)
	if !errors.Is(err, errRealtimeResourceBusy) || response.Code != http.StatusServiceUnavailable {
		t.Fatalf("full transcode queue result = %v/%d", err, response.Code)
	}
	if response.Header().Get("Retry-After") != "1" || !bytes.Contains(response.Body.Bytes(), []byte(`"code":"media_transcode_busy"`)) {
		t.Fatalf("full transcode queue response = %#v/%s", response.Header(), response.Body.String())
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("full transcode queue waited %v", elapsed)
	}
}

func TestAutomaticLocalPlaybackRejectsImmediatelyWhenProbeQueueIsFull(t *testing.T) {
	path := filepath.Join(t.TempDir(), "track.wav")
	if err := os.WriteFile(path, testWAVBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{})
	server.realtimeProbeSlots = make(chan struct{}, realtimeProbeSlotsSize)
	server.realtimeProbeQueue = make(chan struct{}, realtimeProbeQueueSize)
	for range realtimeProbeSlotsSize {
		server.realtimeProbeSlots <- struct{}{}
	}
	for range realtimeProbeQueueSize {
		server.realtimeProbeQueue <- struct{}{}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&capabilities=audio-wav", nil)
	response := httptest.NewRecorder()
	started := time.Now()
	server.serveAutomaticLocalPlayback(response, request, mediaStreamTarget{Kind: "audio", RelativePath: "track.wav"}, path)
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Retry-After") != "1" {
		t.Fatalf("full probe queue response = %d/%#v", response.Code, response.Header())
	}
	if !bytes.Contains(response.Body.Bytes(), []byte(`"code":"media_probe_busy"`)) {
		t.Fatalf("full probe queue body = %s", response.Body.String())
	}
	if elapsed := time.Since(started); elapsed > 250*time.Millisecond {
		t.Fatalf("full probe queue waited %v", elapsed)
	}
}

func TestServeAutomaticLocalPlaybackDirectSupportsRanges(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	path := filepath.Join(t.TempDir(), "track.wav")
	source := testWAVBytes()
	if err := os.WriteFile(path, source, 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{})
	target := mediaStreamTarget{Kind: "audio", RelativePath: "track.wav"}
	request := httptest.NewRequest(http.MethodGet, "/api/media/1/stream?profile=audio&capabilities=audio-wav", nil)
	request.Header.Set("Range", "bytes=44-51")
	response := httptest.NewRecorder()
	server.serveAutomaticLocalPlayback(response, request, target, path)
	if response.Code != http.StatusPartialContent || response.Body.String() != string(source[44:52]) {
		t.Fatalf("direct range response = %d/%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Accept-Ranges") != "bytes" {
		t.Fatalf("direct range Accept-Ranges = %q", response.Header().Get("Accept-Ranges"))
	}
}

func testWAVBytes() []byte {
	const sampleRate = 8000
	const sampleCount = 800
	dataSize := sampleCount * 2
	result := make([]byte, 44+dataSize)
	copy(result[0:4], "RIFF")
	binary.LittleEndian.PutUint32(result[4:8], uint32(36+dataSize))
	copy(result[8:12], "WAVE")
	copy(result[12:16], "fmt ")
	binary.LittleEndian.PutUint32(result[16:20], 16)
	binary.LittleEndian.PutUint16(result[20:22], 1)
	binary.LittleEndian.PutUint16(result[22:24], 1)
	binary.LittleEndian.PutUint32(result[24:28], sampleRate)
	binary.LittleEndian.PutUint32(result[28:32], sampleRate*2)
	binary.LittleEndian.PutUint16(result[32:34], 2)
	binary.LittleEndian.PutUint16(result[34:36], 16)
	copy(result[36:40], "data")
	binary.LittleEndian.PutUint32(result[40:44], uint32(dataSize))
	return result
}
