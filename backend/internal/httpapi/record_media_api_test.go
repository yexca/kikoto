package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/record"
)

type recordTestServer struct {
	server      *Server
	root        string
	handler     http.Handler
	cookie      *http.Cookie
	ids         map[string]int64
	ffmpegCalls *atomic.Int32
}

func newRecordTestServer(t *testing.T) recordTestServer {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"trip/Day 1.mp4": "video",
		"trip/Day 2.mp4": "video",
		"trip/Day 1.srt": "1\n00:00:01,000 --> 00:00:02,000\nHello\n",
		"trip/notes.ass": "[Script Info]",
	}
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, RootUsername: "root", RecordRoot: root, CacheRoot: t.TempDir()})
	// The fixture files are not real media, so the scan here does not probe them.
	server.recordStore = record.NewStore(db, root)
	ffmpegCalls := &atomic.Int32{}
	server.recordThumbnails = server.newRecordThumbnailer(func(_ context.Context, args []string) error {
		ffmpegCalls.Add(1)
		return os.WriteFile(strings.TrimPrefix(args[len(args)-1], "file:"), []byte{0xff, 0xd8, 0xff, 0xd9}, 0o644)
	})
	if _, err := server.recordStore.InitializeRoot(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := server.recordStore.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, 'true')`, recordLibraryEnabledSetting); err != nil {
		t.Fatal(err)
	}
	createTestAdministrator(t, server, "root", "synthetic-password")
	handler := server.Routes()
	ids := map[string]int64{}
	rows, err := db.Query(`SELECT name, id FROM record_asset`)
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
		ids[name] = id
	}
	return recordTestServer{
		server: server, root: root, handler: handler, cookie: loginTestSession(t, handler, "root", "synthetic-password"),
		ids: ids, ffmpegCalls: ffmpegCalls,
	}
}

func (s recordTestServer) get(path string, authenticated bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	if authenticated {
		request.AddCookie(s.cookie)
	}
	response := httptest.NewRecorder()
	s.handler.ServeHTTP(response, request)
	return response
}

func TestRecordMediaRoutesRequireSignIn(t *testing.T) {
	server := newRecordTestServer(t)
	video := strconv.FormatInt(server.ids["Day 1.mp4"], 10)
	subtitle := strconv.FormatInt(server.ids["Day 1.srt"], 10)
	for _, path := range []string{
		"/api/records/continue",
		"/api/records/assets/" + video + "/thumbnail",
		"/api/records/assets/" + subtitle + "/subtitle",
	} {
		if response := server.get(path, false); response.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous %s = %d", path, response.Code)
		}
	}
}

func TestRecordRoutesAreNotFoundWhileTheRecordLibraryIsOff(t *testing.T) {
	server := newRecordTestServer(t)
	video := strconv.FormatInt(server.ids["Day 1.mp4"], 10)
	if response := server.get("/api/records/assets/"+video+"/stream", true); response.Code != http.StatusOK {
		t.Fatalf("stream while on = %d", response.Code)
	}

	server.setRecordLibraryEnabled(t, false)
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/records", nil),
		httptest.NewRequest(http.MethodGet, "/api/records/tree", nil),
		httptest.NewRequest(http.MethodGet, "/api/records/assets/"+video+"/stream", nil),
		httptest.NewRequest(http.MethodPost, "/api/records/root/initialize", nil),
		httptest.NewRequest(http.MethodPost, "/api/records/scans", nil),
		httptest.NewRequest(http.MethodPut, "/api/records/assets/"+video+"/progress", strings.NewReader(`{"positionSeconds":12}`)),
	} {
		request.AddCookie(server.cookie)
		response := httptest.NewRecorder()
		server.handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "record_library_disabled") {
			t.Fatalf("%s %s while off = %d %s", request.Method, request.URL.Path, response.Code, response.Body.String())
		}
	}

	// Turning it on again finds the library as it was left.
	server.setRecordLibraryEnabled(t, true)
	if response := server.get("/api/records/assets/"+video+"/stream", true); response.Code != http.StatusOK {
		t.Fatalf("stream after turning on again = %d", response.Code)
	}
}

func TestRecordLibrarySettingIsReportedAndSaved(t *testing.T) {
	server := newRecordTestServer(t)
	server.setRecordLibraryEnabled(t, false)
	runtime := func() bool {
		var payload struct {
			RecordLibraryEnabled bool `json:"recordLibraryEnabled"`
		}
		response := server.get("/api/runtime-settings", true)
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatalf("runtime settings = %d %s", response.Code, response.Body.String())
		}
		return payload.RecordLibraryEnabled
	}
	if runtime() {
		t.Fatal("runtime settings report Record on while it is off")
	}
	server.setRecordLibraryEnabled(t, true)
	if !runtime() {
		t.Fatal("runtime settings report Record off after it was turned on")
	}
	if response := server.get("/api/records", true); response.Code != http.StatusOK {
		t.Fatalf("root after turning on = %d", response.Code)
	}
}

func (s recordTestServer) setRecordLibraryEnabled(t *testing.T, enabled bool) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(`{"recordLibraryEnabled":`+strconv.FormatBool(enabled)+`}`))
	request.AddCookie(s.cookie)
	response := httptest.NewRecorder()
	s.handler.ServeHTTP(response, request)
	var payload struct {
		RecordLibraryEnabled bool `json:"recordLibraryEnabled"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.RecordLibraryEnabled != enabled {
		t.Fatalf("save recordLibraryEnabled=%t = %d %s", enabled, response.Code, response.Body.String())
	}
}

func TestRecordProgressIsSavedByAViewerWhoCannotManageTheLibrary(t *testing.T) {
	server := newRecordTestServer(t)
	id := server.ids["Day 1.mp4"]
	save := func(permissions ...string) int {
		request := httptest.NewRequest(http.MethodPut, "/api/records/assets/"+strconv.FormatInt(id, 10)+"/progress", strings.NewReader(`{"positionSeconds":42}`))
		request.SetPathValue("id", strconv.FormatInt(id, 10))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: permissions}))
		response := httptest.NewRecorder()
		server.server.updateRecordProgress(response, request)
		return response.Code
	}
	if code := save("library:read"); code != http.StatusForbidden {
		t.Fatalf("save without playback:use = %d", code)
	}
	if code := save("library:read", "playback:use"); code != http.StatusOK {
		t.Fatalf("save with playback:use = %d", code)
	}
	if progress, err := server.server.recordStore.Progress(context.Background(), 1, id); err != nil || progress.PositionSeconds != 42 {
		t.Fatalf("saved progress = %+v, %v", progress, err)
	}
}

func TestRecordContinueBoundsItsLimit(t *testing.T) {
	server := newRecordTestServer(t)
	for value, want := range map[string]int{"0": http.StatusBadRequest, "51": http.StatusBadRequest, "x": http.StatusBadRequest, "50": http.StatusOK, "": http.StatusOK} {
		if response := server.get("/api/records/continue?limit="+value, true); response.Code != want {
			t.Fatalf("limit %q = %d, want %d", value, response.Code, want)
		}
	}
}

func TestRecordSubtitleRouteServesSubRipAsWebVTT(t *testing.T) {
	server := newRecordTestServer(t)
	response := server.get("/api/records/assets/"+strconv.FormatInt(server.ids["Day 1.srt"], 10)+"/subtitle", true)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/vtt; charset=utf-8" ||
		response.Body.String() != "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n" {
		t.Fatalf("srt = %d %q %q", response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	for _, name := range []string{"notes.ass", "Day 1.mp4"} {
		if response := server.get("/api/records/assets/"+strconv.FormatInt(server.ids[name], 10)+"/subtitle", true); response.Code != http.StatusNotFound {
			t.Fatalf("%s subtitle = %d", name, response.Code)
		}
	}
}

func TestRecordTreeLinksThumbnailsAndSubtitles(t *testing.T) {
	server := newRecordTestServer(t)
	root := server.get("/api/records/tree", true)
	var rootTree struct {
		Folders []record.Folder `json:"folders"`
	}
	if err := json.Unmarshal(root.Body.Bytes(), &rootTree); err != nil || len(rootTree.Folders) != 1 {
		t.Fatalf("root tree = %s, %v", root.Body.String(), err)
	}
	response := server.get("/api/records/tree?folderId="+strconv.FormatInt(rootTree.Folders[0].ID, 10), true)
	var tree struct {
		Assets []record.Asset `json:"assets"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &tree); err != nil {
		t.Fatal(err)
	}
	links := map[string]record.Asset{}
	for _, asset := range tree.Assets {
		links[asset.Name] = asset
	}
	video := links["Day 1.mp4"]
	if !strings.HasPrefix(video.ThumbnailURL, "/api/records/assets/") || !strings.Contains(video.ThumbnailURL, "/thumbnail?v=") {
		t.Fatalf("video links = %+v", video)
	}
	if links["Day 1.srt"].StreamURL == "" || links["notes.ass"].StreamURL != "" || links["Day 1.srt"].ThumbnailURL != "" {
		t.Fatalf("subtitle links = %+v / %+v", links["Day 1.srt"], links["notes.ass"])
	}

	thumbnail := server.get(video.ThumbnailURL, true)
	if thumbnail.Code != http.StatusOK || thumbnail.Header().Get("Content-Type") != "image/jpeg" ||
		thumbnail.Header().Get("Cache-Control") != recordThumbnailImmutableControl {
		t.Fatalf("thumbnail = %d %v", thumbnail.Code, thumbnail.Header())
	}
	if stale := server.get(strings.Split(video.ThumbnailURL, "?")[0]+"?v=old", true); stale.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("stale revision cache control = %q", stale.Header().Get("Cache-Control"))
	}
	if notMedia := server.get("/api/records/assets/"+strconv.FormatInt(server.ids["Day 1.srt"], 10)+"/thumbnail", true); notMedia.Code != http.StatusNotFound {
		t.Fatalf("subtitle thumbnail = %d", notMedia.Code)
	}
}

// thumbnailPath returns the cached thumbnail of a fixture asset, or "" when
// none is cached.
func (s recordTestServer) thumbnailPath(t *testing.T, name string) string {
	t.Helper()
	pattern := filepath.Join(s.server.cfg.CacheRoot, transcodeCacheRootRelative, recordThumbnailCacheDir, "*",
		"a"+strconv.FormatInt(s.ids[name], 10)+"-*.jpg")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) > 1 {
		t.Fatalf("thumbnails of %s = %v, %v", name, matches, err)
	}
	if len(matches) == 0 {
		return ""
	}
	return matches[0]
}

func (s recordTestServer) getThumbnail(t *testing.T, name string) {
	t.Helper()
	path := "/api/records/assets/" + strconv.FormatInt(s.ids[name], 10) + "/thumbnail"
	if response := s.get(path, true); response.Code != http.StatusOK || response.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("%s thumbnail = %d %s", name, response.Code, response.Body.String())
	}
}

func TestRecordThumbnailsAreEvictedLeastRecentlyUsedUnderTheTranscodeQuota(t *testing.T) {
	server := newRecordTestServer(t)
	ctx := context.Background()
	server.getThumbnail(t, "Day 1.mp4")
	server.getThumbnail(t, "Day 2.mp4")
	first, second := server.thumbnailPath(t, "Day 1.mp4"), server.thumbnailPath(t, "Day 2.mp4")
	if first == "" || second == "" {
		t.Fatalf("thumbnails = %q, %q", first, second)
	}
	overview, err := server.server.scanTranscodeCache(ctx)
	if err != nil || overview.Files != 2 {
		t.Fatalf("transcode cache overview = %+v, %v", overview, err)
	}
	// The first thumbnail is older, but viewing it again makes the second the
	// least recently used.
	now := time.Now()
	for path, age := range map[string]time.Duration{first: 2 * time.Hour, second: time.Hour} {
		if err := os.Chtimes(path, now.Add(-age), now.Add(-age)); err != nil {
			t.Fatal(err)
		}
	}
	server.getThumbnail(t, "Day 1.mp4")
	info, err := os.Stat(first)
	if err != nil {
		t.Fatal(err)
	}

	// Reserving all but one thumbnail of the quota evicts the other.
	if _, err := server.server.enforceTranscodeCacheLimit(ctx, server.server.transcodeCacheLimitBytes(ctx)-info.Size()); err != nil {
		t.Fatal(err)
	}
	if server.thumbnailPath(t, "Day 1.mp4") != first || server.thumbnailPath(t, "Day 2.mp4") != "" {
		t.Fatalf("after eviction = %q, %q", server.thumbnailPath(t, "Day 1.mp4"), server.thumbnailPath(t, "Day 2.mp4"))
	}

	calls := server.ffmpegCalls.Load()
	server.getThumbnail(t, "Day 2.mp4")
	if server.thumbnailPath(t, "Day 2.mp4") == "" || server.ffmpegCalls.Load() != calls+1 {
		t.Fatalf("evicted thumbnail was not made again: calls %d -> %d", calls, server.ffmpegCalls.Load())
	}
}

func TestRecordCompleteScanRemovesThumbnailsOfMissingAssets(t *testing.T) {
	server := newRecordTestServer(t)
	server.getThumbnail(t, "Day 1.mp4")
	server.getThumbnail(t, "Day 2.mp4")
	if err := os.Remove(filepath.Join(server.root, "trip", "Day 2.mp4")); err != nil {
		t.Fatal(err)
	}
	result, err := server.server.runRecordScan(context.Background())
	if err != nil || !result.MissingMarked || result.ThumbnailsRemoved != 1 {
		t.Fatalf("scan = %+v, %v", result, err)
	}
	if server.thumbnailPath(t, "Day 1.mp4") == "" || server.thumbnailPath(t, "Day 2.mp4") != "" {
		t.Fatalf("after scan = %q, %q", server.thumbnailPath(t, "Day 1.mp4"), server.thumbnailPath(t, "Day 2.mp4"))
	}
}

func TestRecordAudioLinksAThumbnailOnlyForEmbeddedCoverArt(t *testing.T) {
	size, mtime := int64(10), int64(20)
	withCover := record.Asset{ID: 7, Kind: "audio", Availability: "available", SizeBytes: &size, MtimeNs: &mtime, HasCover: true}
	decorateRecordAsset(&withCover)
	if withCover.StreamURL != "/api/records/assets/7/stream" || !strings.HasPrefix(withCover.ThumbnailURL, "/api/records/assets/7/thumbnail?v=") {
		t.Fatalf("audio with cover = %+v", withCover)
	}
	plain := record.Asset{ID: 8, Kind: "audio", Availability: "available"}
	decorateRecordAsset(&plain)
	if plain.StreamURL == "" || plain.ThumbnailURL != "" || hasRecordThumbnail(plain) {
		t.Fatalf("audio without cover = %+v", plain)
	}
}
