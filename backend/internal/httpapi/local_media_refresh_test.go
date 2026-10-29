package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func TestRefreshWorkLocalFolderIndexesOnlyThatFolder(t *testing.T) {
	root := t.TempDir()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
	const (
		primary = "disk1/RJ00000042"
		second  = "disk1/extra/RJ00000042"
		deep    = "disk1/one/two/RJ00000042"
		offline = "disk2/RJ00000042"
	)
	for _, dir := range []string{primary, second, deep, offline} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(dir)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile := func(rel string) string {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.WriteFile(path, []byte("synthetic audio"), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	primaryTrack := writeFile(primary + "/a.mp3")
	secondTrack := writeFile(second + "/b.mp3")
	if err := storagepool.WriteMarker(filepath.Join(root, "disk1"), "pool-disk1"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE app_setting SET value_json='"pools"' WHERE key='library_mode'; INSERT INTO app_setting(key,value_json) VALUES('storage_pools','[{"path":"disk1","id":"pool-disk1"},{"path":"disk2","id":"pool-disk2"}]')`); err != nil {
		t.Fatal(err)
	}
	// The deep and offline folders hold one indexed file each that is not on disk.
	seeded := seedIndexedLocalScanWork(t, db, server, "RJ00000042", primary, deep+"/c.mp3")
	if _, err := db.Exec(`
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, size_bytes, availability, last_checked_at)
		VALUES (?, ?, 'local', ?, 5, 'available', CURRENT_TIMESTAMP)
	`, seeded.mediaItemID, seeded.sourceID, offline+"/c.mp3"); err != nil {
		t.Fatal(err)
	}
	folderIDs := map[string]int64{}
	for index, folder := range []string{primary, second, deep, offline} {
		result, err := db.Exec("INSERT INTO work_folder_location(work_id,file_source_id,root_path,role,state,is_primary) VALUES(?,?,?,'external','active',?)",
			seeded.workID, seeded.sourceID, folder, index == 0)
		if err != nil {
			t.Fatal(err)
		}
		if folderIDs[folder], err = result.LastInsertId(); err != nil {
			t.Fatal(err)
		}
	}
	otherWork, err := db.Exec("INSERT INTO work (primary_code, work_type, title) VALUES ('RJ00000043', 'audio', 'Other synthetic work')")
	if err != nil {
		t.Fatal(err)
	}
	otherWorkID, _ := otherWork.LastInsertId()
	otherFolder, err := db.Exec("INSERT INTO work_folder_location(work_id,file_source_id,root_path,role,state,is_primary) VALUES(?,?,'disk1/RJ00000043','external','active',1)",
		otherWorkID, seeded.sourceID)
	if err != nil {
		t.Fatal(err)
	}
	otherFolderID, _ := otherFolder.LastInsertId()

	refresh := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		request.SetPathValue("id", jsonNumber(seeded.workID))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{Permissions: []string{"downloads:manage"}}))
		response := httptest.NewRecorder()
		server.refreshWorkLocalFiles(response, request)
		return response
	}
	folderBody := func(folderID int64, fileSourceID int64) string {
		encoded, _ := json.Marshal(map[string]int64{"folderId": folderID, "fileSourceId": fileSourceID})
		return string(encoded)
	}
	availability := func(path string) string {
		t.Helper()
		var value string
		if err := db.QueryRow("SELECT availability FROM media_file_location WHERE path = ?", path).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}

	// Without a folder, the presence folder and every reachable folder are indexed.
	if response := refresh("{}"); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	if availability(primary+"/a.mp3") != "available" || availability(second+"/b.mp3") != "available" {
		t.Fatal("whole refresh did not index the reachable folders")
	}

	for _, path := range []string{primaryTrack, secondTrack} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	response := refresh(folderBody(folderIDs[second], seeded.sourceID))
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	var result localMediaRefreshResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.WorkID != seeded.workID || result.FolderID != folderIDs[second] || result.IndexedFiles != 0 {
		t.Fatalf("folder refresh result = %+v", result)
	}
	if got := availability(second + "/b.mp3"); got != "missing" {
		t.Fatalf("refreshed folder's removed file = %q, want missing", got)
	}
	// The work's other folders keep what is indexed until they are refreshed.
	if got := availability(primary + "/a.mp3"); got != "available" {
		t.Fatalf("other folder's file = %q, want available", got)
	}

	for name, test := range map[string]struct {
		body string
		code int
	}{
		"another work's folder": {folderBody(otherFolderID, 0), http.StatusNotFound},
		"another source":        {folderBody(folderIDs[second], seeded.sourceID+1000), http.StatusNotFound},
		"deeper than the scan":  {folderBody(folderIDs[deep], 0), http.StatusConflict},
		"offline pool":          {folderBody(folderIDs[offline], 0), http.StatusConflict},
	} {
		response := refresh(test.body)
		if response.Code != test.code {
			t.Fatalf("%s: status = %d, body = %s", name, response.Code, response.Body.String())
		}
	}
	assertAPIErrorCode(t, "deep", refresh(folderBody(folderIDs[deep], 0)), http.StatusConflict, "folder_outside_scan_scope")
	assertAPIErrorCode(t, "offline", refresh(folderBody(folderIDs[offline], 0)), http.StatusConflict, "storage_pool_offline")
	// A folder the scan cannot see is never recorded as missing.
	if availability(deep+"/c.mp3") != "available" || availability(offline+"/c.mp3") != "available" {
		t.Fatal("a refused folder refresh changed stored availability")
	}
}
