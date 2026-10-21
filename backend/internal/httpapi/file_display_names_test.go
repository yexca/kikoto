package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// seedDisplayNameWork stores one work whose folder holds an audio track and a
// text file in a subfolder, and a second work with a file of its own.
func seedDisplayNameWork(t *testing.T) *sql.DB {
	t.Helper()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, role) VALUES (7, 'synthetic-editor', 'user'), (8, 'synthetic-viewer', 'user');
		INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_local', 'Example Local', 'local_folder', 1);
		INSERT INTO work (id, primary_code, title) VALUES (11, 'RJ00000001', 'Example Work 1'), (12, 'RJ00000002', 'Example Work 2');
		INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary) VALUES
			(31, 11, 1, 'library/RJ00000001', 'external', 'active', 1),
			(32, 12, 1, 'library/RJ00000002', 'external', 'active', 1);
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(21, 11, 'audio', '01 track', 'local:RJ00000001:mp3/01 track.mp3'),
			(22, 11, 'text', 'notes', 'local:RJ00000001:mp3/notes.txt'),
			(23, 12, 'audio', 'other', 'local:RJ00000002:other.mp3');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(41, 21, 1, 'local', 'library/RJ00000001/mp3/01 track.mp3', 'available'),
			(42, 22, 1, 'local', 'library/RJ00000001/mp3/notes.txt', 'available'),
			(43, 23, 1, 'local', 'library/RJ00000002/other.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	return db
}

func putFileDisplayNames(server *Server, workID, body string, permissions ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, "/api/works/"+workID+"/file-display-names", strings.NewReader(body))
	request.SetPathValue("id", workID)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 7, Permissions: permissions}))
	response := httptest.NewRecorder()
	server.setWorkFileDisplayNames(response, request)
	return response
}

func displayPaths(t *testing.T, server *Server, ctx context.Context) map[int64]string {
	t.Helper()
	items, err := server.loadWorkMediaItems(ctx, optionalUserID(ctx), 11)
	if err != nil {
		t.Fatal(err)
	}
	paths := map[int64]string{}
	for _, item := range items {
		for _, location := range item.Locations {
			paths[location.ID] = location.DisplayPath
		}
	}
	return paths
}

func TestFileDisplayNamesShowOnlyInTheViewersLanguages(t *testing.T) {
	db := seedDisplayNameWork(t)
	server := NewServer(db, config.Config{})
	response := putFileDisplayNames(server, "11", `{"language":"zh-cn",
		"files":[{"mediaItemId":21,"name":" 第一首 "}],
		"folders":[{"path":"mp3","name":"音频"}]}`, "library:write")
	if response.Code != http.StatusOK {
		t.Fatalf("save status = %d, body = %s", response.Code, response.Body.String())
	}
	var saved fileDisplayNamesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if len(saved.Folders) != 1 || saved.Folders[0].Path != "mp3" || saved.Folders[0].Names["zh-cn"] != "音频" {
		t.Fatalf("folders = %+v", saved.Folders)
	}
	if len(saved.Files) != 2 || saved.Files[0].Path != "mp3/01 track.mp3" || saved.Files[0].Names["zh-cn"] != "第一首" {
		t.Fatalf("files = %+v", saved.Files)
	}

	setUserMetadataLanguages(t, db, 7, `["en-us","zh-cn"]`)
	paths := displayPaths(t, server, metadataLanguageViewer(7))
	if paths[41] != "library/RJ00000001/音频/第一首.mp3" || paths[42] != "library/RJ00000001/音频/notes.txt" {
		t.Fatalf("display paths = %v", paths)
	}
	// The original language shows the real names, as does a language without names.
	setUserMetadataLanguages(t, db, 7, `["ko-kr"]`)
	for _, check := range []struct {
		name string
		ctx  context.Context
	}{
		{"language without names", metadataLanguageViewer(7)},
		{"no preference", metadataLanguageViewer(8)},
		{"anonymous", context.Background()},
	} {
		for id, displayPath := range displayPaths(t, server, check.ctx) {
			if displayPath != "" {
				t.Fatalf("%s: location %d shows %q", check.name, id, displayPath)
			}
		}
	}

	setUserMetadataLanguages(t, db, 7, `["zh-cn"]`)
	response = putFileDisplayNames(server, "11", `{"language":"zh-cn","files":[{"mediaItemId":21,"name":""}]}`, "library:write")
	if response.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body = %s", response.Code, response.Body.String())
	}
	paths = displayPaths(t, server, metadataLanguageViewer(7))
	if paths[41] != "library/RJ00000001/音频/01 track.mp3" {
		t.Fatalf("display path after clearing the file name = %q", paths[41])
	}
}

func TestFileDisplayNamesRefuseInvalidSaves(t *testing.T) {
	db := seedDisplayNameWork(t)
	server := NewServer(db, config.Config{})
	for _, check := range []struct {
		body        string
		permissions []string
		want        int
	}{
		{`{"language":"zh-cn","files":[{"mediaItemId":21,"name":"x"}]}`, []string{"library:read"}, http.StatusForbidden},
		{`{"language":"origin","files":[{"mediaItemId":21,"name":"x"}]}`, nil, http.StatusBadRequest},
		{`{"language":"zh-cn","files":[]}`, nil, http.StatusBadRequest},
		{`{"language":"zh-cn","files":[{"mediaItemId":21,"name":"a/b"}]}`, nil, http.StatusBadRequest},
		{`{"language":"zh-cn","files":[{"mediaItemId":21,"name":"` + strings.Repeat("x", 256) + `"}]}`, nil, http.StatusBadRequest},
		{`{"language":"zh-cn","files":[{"mediaItemId":23,"name":"x"}]}`, nil, http.StatusBadRequest},
		{`{"language":"zh-cn","folders":[{"path":"elsewhere","name":"x"}]}`, nil, http.StatusBadRequest},
		{`{"language":"zh-cn","folders":[{"path":"mp3","name":"x"},{"path":"mp3/","name":"y"}]}`, nil, http.StatusBadRequest},
	} {
		permissions := check.permissions
		if permissions == nil {
			permissions = []string{"library:write"}
		}
		if response := putFileDisplayNames(server, "11", check.body, permissions...); response.Code != check.want {
			t.Fatalf("%s: status = %d, want %d, body = %s", check.body, response.Code, check.want, response.Body.String())
		}
	}
	var count int
	if err := db.QueryRow("SELECT (SELECT COUNT(*) FROM media_item_display_name) + (SELECT COUNT(*) FROM work_folder_display_name)").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("refused saves stored %d names", count)
	}
}

func TestFolderEditMovesFolderDisplayNames(t *testing.T) {
	db := seedDisplayNameWork(t)
	if _, err := db.Exec(`
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (24, 11, 'audio', 'kept', 'local:RJ00000001:wav/kept.wav');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(44, 24, 1, 'local', 'library/RJ00000001/wav/kept.wav', 'available');
		INSERT INTO work_folder_display_name (work_id, path, language, name) VALUES
			(11, 'mp3', 'zh-cn', '音频'), (11, 'wav', 'zh-cn', '无损');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	// Every file of mp3 moves to MP3, so mp3 is renamed. The file moved out of
	// wav leaves one behind, so wav keeps its name.
	if _, err := db.Exec(`
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (25, 11, 'audio', 'moved', 'local:RJ00000001:wav/moved.wav');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(45, 25, 1, 'local', 'library/RJ00000001/wav/moved.wav', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	payload := workFolderEditJobPayload{WorkID: 11, WorkCode: "RJ00000001", TargetRoot: "library/RJ00000001", Moves: []workFolderEditMove{
		{LocationID: 41, MediaItemID: 21, Path: "library/RJ00000001/mp3/01 track.mp3", TargetPath: "library/RJ00000001/MP3/01 track.mp3"},
		{LocationID: 42, MediaItemID: 22, Path: "library/RJ00000001/mp3/notes.txt", TargetPath: "library/RJ00000001/MP3/notes.txt"},
		{LocationID: 45, MediaItemID: 25, Path: "library/RJ00000001/wav/moved.wav", TargetPath: "library/RJ00000001/lossless/moved.wav"},
	}}
	if err := server.keepWorkFolderEditMovedItems(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	names := map[string]string{}
	rows, err := db.Query("SELECT path, name FROM work_folder_display_name WHERE work_id = 11")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var folder, name string
		if err := rows.Scan(&folder, &name); err != nil {
			t.Fatal(err)
		}
		names[folder] = name
	}
	if len(names) != 2 || names["MP3"] != "音频" || names["wav"] != "无损" {
		t.Fatalf("folder names after the edit = %v", names)
	}
}

func workFolderDisplayNamePaths(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query("SELECT path FROM work_folder_display_name WHERE work_id = 11 ORDER BY path")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	paths := []string{}
	for rows.Next() {
		var folder string
		if err := rows.Scan(&folder); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, folder)
	}
	return paths
}

// A folder renamed outside Kikoto keeps its names while its old file is only
// recorded missing, and loses them once disk-verified cleanup removes that
// file's last record. A name never matches a folder that only shares a prefix.
func TestFolderDisplayNamesLastWhileAFileBelowIsTracked(t *testing.T) {
	db := seedDisplayNameWork(t)
	if _, err := db.Exec(`
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(26, 11, 'audio', 'renamed', 'local:RJ00000001:old/renamed.mp3'),
			(27, 11, 'audio', 'wide', 'local:RJ00000001:音频/wide.mp3');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(46, 26, 1, 'local', 'library/RJ00000001/old/renamed.mp3', 'missing'),
			(47, 27, 1, 'local', 'library/RJ00000001/音频/wide.mp3', 'available');
		INSERT INTO work_folder_display_name (work_id, path, language, name) VALUES
			(11, 'mp3', 'zh-cn', '音频'), (11, 'mp', 'zh-cn', '前缀'), (11, 'old', 'zh-cn', '旧'),
			(11, '音频', 'en-us', 'Audio'), (11, 'gone', 'zh-cn', '没了');
		INSERT INTO work_folder_display_name (work_id, path, language, name) VALUES (12, 'mp3', 'zh-cn', '其他');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	if _, err := server.deleteEmptyMediaItems(ctx); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(workFolderDisplayNamePaths(t, db), ","); got != "mp3,old,音频" {
		t.Fatalf("names after cleanup with the old file recorded = %s", got)
	}
	var otherWork int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_folder_display_name WHERE work_id = 12").Scan(&otherWork); err != nil || otherWork != 0 {
		t.Fatalf("a name for a path no file of its own work lies below = %d, %v", otherWork, err)
	}

	if _, err := db.Exec("DELETE FROM media_file_location WHERE id = 46"); err != nil {
		t.Fatal(err)
	}
	if _, err := server.deleteEmptyMediaItems(ctx); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(workFolderDisplayNamePaths(t, db), ","); got != "mp3,音频" {
		t.Fatalf("names after the old file's last record is removed = %s", got)
	}
}

// A folder edit that spreads a folder's files over several folders keeps no
// name for the emptied folder.
func TestFolderEditDropsNamesOfAFolderItEmpties(t *testing.T) {
	db := seedDisplayNameWork(t)
	if _, err := db.Exec(`INSERT INTO work_folder_display_name (work_id, path, language, name) VALUES (11, 'mp3', 'zh-cn', '音频')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	payload := workFolderEditJobPayload{WorkID: 11, WorkCode: "RJ00000001", TargetRoot: "library/RJ00000001", Moves: []workFolderEditMove{
		{LocationID: 41, MediaItemID: 21, Path: "library/RJ00000001/mp3/01 track.mp3", TargetPath: "library/RJ00000001/audio/01 track.mp3"},
		{LocationID: 42, MediaItemID: 22, Path: "library/RJ00000001/mp3/notes.txt", TargetPath: "library/RJ00000001/text/notes.txt"},
	}}
	if err := server.keepWorkFolderEditMovedItems(context.Background(), payload); err != nil {
		t.Fatal(err)
	}
	if got := workFolderDisplayNamePaths(t, db); len(got) != 0 {
		t.Fatalf("names after the edit emptied mp3 = %v", got)
	}
}
