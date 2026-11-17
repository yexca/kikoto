package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/record"
)

func (s recordTestServer) deleteAsset(name string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodDelete, "/api/records/assets/"+strconv.FormatInt(s.ids[name], 10), nil)
	request.AddCookie(s.cookie)
	response := httptest.NewRecorder()
	s.handler.ServeHTTP(response, request)
	return response
}

func TestRecordDeleteMovesTheFileToTheRecordTrashWithItsCaches(t *testing.T) {
	server := newRecordTestServer(t)
	id := server.ids["Day 1.mp4"]
	if err := server.server.recordStore.SaveProgress(context.Background(), 1, id, record.Progress{PositionSeconds: 30}); err != nil {
		t.Fatal(err)
	}
	server.getThumbnail(t, "Day 1.mp4")
	server.getThumbnail(t, "Day 2.mp4")
	cacheKey := recordPlaybackCacheKey(id)
	for _, dir := range recordPlaybackCacheDirs {
		segment := filepath.Join(server.server.cfg.CacheRoot, transcodeCacheRootRelative, dir, cacheKey, "rev", "segment-000000.ts")
		if err := os.MkdirAll(filepath.Dir(segment), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(segment, []byte("segment"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	response := server.deleteAsset("Day 1.mp4")
	if response.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", response.Code, response.Body.String())
	}
	var body struct {
		TrashPath string `json:"trashPath"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	// The trash keeps the file's place in the library under a folder of its own.
	if !strings.HasPrefix(body.TrashPath, record.TrashDir+"/") || path.Base(body.TrashPath) != "Day 1.mp4" ||
		!strings.HasSuffix(body.TrashPath, "/trip/Day 1.mp4") || filepath.IsAbs(body.TrashPath) {
		t.Fatalf("trash path = %q", body.TrashPath)
	}
	if content, err := os.ReadFile(filepath.Join(server.root, filepath.FromSlash(body.TrashPath))); err != nil || string(content) != "video" {
		t.Fatalf("trashed file = %q, %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(server.root, "trip", "Day 1.mp4")); !os.IsNotExist(err) {
		t.Fatalf("original file still exists: %v", err)
	}
	for _, dir := range recordPlaybackCacheDirs {
		if _, err := os.Stat(filepath.Join(server.server.cfg.CacheRoot, transcodeCacheRootRelative, dir, cacheKey)); !os.IsNotExist(err) {
			t.Fatalf("%s cache of the deleted file remains: %v", dir, err)
		}
	}
	if server.thumbnailPath(t, "Day 1.mp4") != "" || server.thumbnailPath(t, "Day 2.mp4") == "" {
		t.Fatalf("thumbnails after delete = %q, %q", server.thumbnailPath(t, "Day 1.mp4"), server.thumbnailPath(t, "Day 2.mp4"))
	}
	var progressRows int
	if err := server.server.db.QueryRow(`SELECT COUNT(*) FROM record_asset_progress WHERE asset_id=?`, id).Scan(&progressRows); err != nil || progressRows != 0 {
		t.Fatalf("progress rows = %d, %v", progressRows, err)
	}
	if response := server.get("/api/records/assets/"+strconv.FormatInt(id, 10), true); response.Code != http.StatusNotFound {
		t.Fatalf("deleted asset = %d", response.Code)
	}
	if response := server.deleteAsset("Day 1.mp4"); response.Code != http.StatusNotFound {
		t.Fatalf("second delete = %d", response.Code)
	}

	// A scan skips the trash, so the file does not come back.
	if _, err := server.server.runRecordScan(context.Background()); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err := server.server.db.QueryRow(`SELECT COUNT(*) FROM record_asset WHERE name='Day 1.mp4'`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("rows named after the trashed file = %d, %v", rows, err)
	}
}

func TestRecordDeleteRefusesAnOfflineRoot(t *testing.T) {
	server := newRecordTestServer(t)
	if err := os.Remove(filepath.Join(server.root, ".kikoto-record")); err != nil {
		t.Fatal(err)
	}
	response := server.deleteAsset("Day 2.mp4")
	if response.Code == http.StatusOK {
		t.Fatalf("delete without the marker = %d", response.Code)
	}
	if _, err := os.Stat(filepath.Join(server.root, "trip", "Day 2.mp4")); err != nil {
		t.Fatalf("file under an unmarked root moved: %v", err)
	}
}

func TestRecordDeleteRequiresDownloadsManage(t *testing.T) {
	server := newRecordTestServer(t)
	request := httptest.NewRequest(http.MethodDelete, "/api/records/assets/"+strconv.FormatInt(server.ids["Day 2.mp4"], 10), nil)
	request.SetPathValue("id", strconv.FormatInt(server.ids["Day 2.mp4"], 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"library:read", "library:write"}}))
	response := httptest.NewRecorder()
	server.server.deleteRecordAsset(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("delete without downloads:manage = %d", response.Code)
	}
	if _, err := os.Stat(filepath.Join(server.root, "trip", "Day 2.mp4")); err != nil {
		t.Fatalf("file moved without permission: %v", err)
	}
}

func (s recordTestServer) deleteFolder(t *testing.T, relativePath string) *httptest.ResponseRecorder {
	t.Helper()
	var id int64
	if err := s.server.db.QueryRow(`SELECT id FROM record_folder WHERE relative_path=?`, relativePath).Scan(&id); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/records/folders/"+strconv.FormatInt(id, 10), nil)
	request.AddCookie(s.cookie)
	response := httptest.NewRecorder()
	s.handler.ServeHTTP(response, request)
	return response
}

func TestRecordFolderDeleteMovesTheFolderWithEverythingInItToTheTrash(t *testing.T) {
	server := newRecordTestServer(t)
	video := server.ids["Day 1.mp4"]
	if err := server.server.recordStore.SaveProgress(context.Background(), 1, video, record.Progress{PositionSeconds: 30}); err != nil {
		t.Fatal(err)
	}
	server.getThumbnail(t, "Day 1.mp4")
	segment := filepath.Join(server.server.cfg.CacheRoot, transcodeCacheRootRelative, "hls", recordPlaybackCacheKey(video), "rev", "segment-000000.ts")
	if err := os.MkdirAll(filepath.Dir(segment), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(segment, []byte("segment"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A file the library does not list moves with the folder too.
	if err := os.WriteFile(filepath.Join(server.root, "trip", "Thumbs.db"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}

	response := server.deleteFolder(t, "trip")
	if response.Code != http.StatusOK {
		t.Fatalf("delete folder = %d %s", response.Code, response.Body.String())
	}
	var body struct {
		TrashPath string  `json:"trashPath"`
		AssetIDs  []int64 `json:"assetIds"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(body.TrashPath, record.TrashDir+"/") || !strings.HasSuffix(body.TrashPath, "/trip") || len(body.AssetIDs) != 4 {
		t.Fatalf("folder delete = %+v", body)
	}
	for _, name := range []string{"Day 1.mp4", "Day 2.mp4", "Day 1.srt", "notes.ass", "Thumbs.db"} {
		if _, err := os.Stat(filepath.Join(server.root, filepath.FromSlash(body.TrashPath), name)); err != nil {
			t.Fatalf("%s in the trash: %v", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(server.root, "trip")); !os.IsNotExist(err) {
		t.Fatalf("folder still exists: %v", err)
	}
	var folders, assets, progress int
	if err := server.server.db.QueryRow(`SELECT (SELECT COUNT(*) FROM record_folder WHERE relative_path='trip'), (SELECT COUNT(*) FROM record_asset), (SELECT COUNT(*) FROM record_asset_progress)`).Scan(&folders, &assets, &progress); err != nil || folders+assets+progress != 0 {
		t.Fatalf("rows left = folders %d assets %d progress %d, %v", folders, assets, progress, err)
	}
	if _, err := os.Stat(filepath.Dir(filepath.Dir(segment))); !os.IsNotExist(err) {
		t.Fatalf("playback cache of a file in the folder remains: %v", err)
	}
	if server.thumbnailPath(t, "Day 1.mp4") != "" {
		t.Fatal("thumbnail of a file in the folder remains")
	}
}

func TestRecordFolderDeleteRefusesTheRootFolder(t *testing.T) {
	server := newRecordTestServer(t)
	if response := server.deleteFolder(t, "."); response.Code != http.StatusConflict {
		t.Fatalf("delete root folder = %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(server.root, "trip", "Day 1.mp4")); err != nil {
		t.Fatalf("root contents moved: %v", err)
	}
}
