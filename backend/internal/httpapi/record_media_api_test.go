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
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/record"
)

type recordTestServer struct {
	handler http.Handler
	cookie  *http.Cookie
	ids     map[string]int64
}

func newRecordTestServer(t *testing.T) recordTestServer {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"trip/Day 1.mp4": "video",
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
	server.recordThumbnails = record.NewThumbnailer(t.TempDir(), func(_ context.Context, args []string) error {
		return os.WriteFile(strings.TrimPrefix(args[len(args)-1], "file:"), []byte{0xff, 0xd8, 0xff, 0xd9}, 0o644)
	}, 1)
	if _, err := server.recordStore.InitializeRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := server.recordStore.Scan(context.Background()); err != nil {
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
	return recordTestServer{handler: handler, cookie: loginTestSession(t, handler, "root", "synthetic-password"), ids: ids}
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
