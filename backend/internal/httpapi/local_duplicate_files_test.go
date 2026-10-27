package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

type duplicateFilesFixture struct {
	server   *Server
	db       *sqlutil.DB
	dataRoot string
	originID int64
}

// newDuplicateFilesFixture builds an original edition and a translated
// edition of one family. The translation repeats the original's audio under
// other names and adds lyrics; one file only shares a size with another.
func newDuplicateFilesFixture(t *testing.T) duplicateFilesFixture {
	t.Helper()
	dataRoot := t.TempDir()
	files := map[string]string{
		"RJ00000001/mp3/01 Original.mp3":           "synthetic audio one",
		"RJ00000001/mp3/02 Original.mp3":           "synthetic audio two",
		"RJ00000001/mp3/02 Original copy.mp3":      "synthetic audio two",
		"RJ00000001/cover.jpg":                     "synthetic image",
		"RJ00000002/Translated/01 Translated.mp3":  "synthetic audio one",
		"RJ00000002/Translated/02 Translated.mp3":  "synthetic audio two",
		"RJ00000002/Translated/03 Same length.mp3": "synthetic audio XYZ",
		"RJ00000002/Translated/01 Translated.vtt":  "WEBVTT\n",
		"RJ00000003/unrelated/01 Other family.mp3": "synthetic audio one",
		"RJ00000001/empty-a.txt":                   "",
		"RJ00000002/Translated/empty-b.txt":        "",
	}
	for name, content := range files {
		absolute := filepath.Join(dataRoot, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := storagepool.WriteMarker(dataRoot, "synthetic-library"); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	executeLocalScanForTest(t, server)

	fixture := duplicateFilesFixture{server: server, db: db, dataRoot: dataRoot}
	rows, err := db.Query(`
		SELECT work.primary_code, folder.work_id, folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN work ON work.id = folder.work_id
		ORDER BY work.primary_code
	`)
	if err != nil {
		t.Fatal(err)
	}
	type folder struct {
		code                 string
		workID, fileSourceID int64
		root                 string
	}
	folders := []folder{}
	for rows.Next() {
		var entry folder
		if err := rows.Scan(&entry.code, &entry.workID, &entry.fileSourceID, &entry.root); err != nil {
			t.Fatal(err)
		}
		folders = append(folders, entry)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	ids := map[string]int64{}
	for _, entry := range folders {
		ids[entry.code] = entry.workID
		// The translated edition stays as a scan leaves it: found, but with no
		// indexed files until something asks for them.
		if entry.code == "RJ00000002" {
			continue
		}
		if err := server.indexLocalMediaForWork(context.Background(), entry.workID, entry.fileSourceID, entry.root); err != nil {
			t.Fatal(err)
		}
	}
	fixture.originID = ids["RJ00000001"]
	// One statement per Exec: placeholders do not bind across statements.
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{query: "INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, ?, 'RJ00000001')", args: []any{fixture.originID}},
		{query: `INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical)
			VALUES (?, 1, 'RJ00000001', 'RJ00000001', 'JPN', 1)`, args: []any{fixture.originID}},
		{query: `INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical)
			VALUES (?, 1, 'RJ00000002', 'RJ00000001', 'CHI_HANS', 0)`, args: []any{ids["RJ00000002"]}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	return fixture
}

// groupPaths renders each group as its sorted paths joined by " = ".
func groupPaths(response duplicateFilesResponse) []string {
	groups := []string{}
	for _, group := range response.Groups {
		paths := []string{}
		for _, file := range group.Files {
			paths = append(paths, file.WorkCode+":"+file.Path)
		}
		groups = append(groups, strings.Join(paths, " = "))
	}
	return groups
}

func TestDuplicateFilesAreFoundAcrossTheFamilyByContent(t *testing.T) {
	fixture := newDuplicateFilesFixture(t)

	response, err := fixture.server.duplicateFilesForWork(context.Background(), fixture.originID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	// Same bytes are one group whatever the names and folders; a file that
	// only shares a size, empty files, and another family's files are not.
	want := []string{
		"RJ00000001:RJ00000001/mp3/01 Original.mp3 = RJ00000002:RJ00000002/Translated/01 Translated.mp3",
		"RJ00000001:RJ00000001/mp3/02 Original copy.mp3 = RJ00000001:RJ00000001/mp3/02 Original.mp3 = RJ00000002:RJ00000002/Translated/02 Translated.mp3",
	}
	if got := groupPaths(response); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("groups = %v, want %v", got, want)
	}
	if !response.Complete || response.PendingFiles != 0 || response.CheckedFiles != 6 {
		t.Fatalf("response = complete %t, pending %d, checked %d", response.Complete, response.PendingFiles, response.CheckedFiles)
	}

	// Only files that share a size are read.
	var hashed int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE content_hash <> ''").Scan(&hashed); err != nil {
		t.Fatal(err)
	}
	if hashed != 6 {
		t.Fatalf("hashed %d files, want only the six that share a size within the family", hashed)
	}
}

func TestDuplicateFilesContinueAcrossRequestsAndFollowFileChanges(t *testing.T) {
	fixture := newDuplicateFilesFixture(t)
	ctx := context.Background()

	// A request without time still hashes one file, so repeating it finishes.
	first, err := fixture.server.duplicateFilesForWork(ctx, fixture.originID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if first.Complete || first.CheckedFiles != 1 || first.PendingFiles != 5 || len(first.Groups) != 0 {
		t.Fatalf("first response = %+v", first)
	}
	response := first
	for attempt := 0; attempt < 10 && !response.Complete; attempt++ {
		if response, err = fixture.server.duplicateFilesForWork(ctx, fixture.originID, 0); err != nil {
			t.Fatal(err)
		}
	}
	if !response.Complete || len(response.Groups) != 2 {
		t.Fatalf("repeated requests ended with %+v", response)
	}

	// A file that changes is no longer identical: its cached hash belongs to
	// the old version and is not reused.
	changed := filepath.Join(fixture.dataRoot, "RJ00000002", "Translated", "01 Translated.mp3")
	if err := os.WriteFile(changed, []byte("synthetic audio ONE"), 0o644); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(changed, later, later); err != nil {
		t.Fatal(err)
	}
	response, err = fixture.server.duplicateFilesForWork(ctx, fixture.originID, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if got := groupPaths(response); len(got) != 1 || !strings.Contains(got[0], "02 Original.mp3") {
		t.Fatalf("groups after a change = %v", got)
	}
}

func TestDuplicateFilesRequireDownloadsManage(t *testing.T) {
	fixture := newDuplicateFilesFixture(t)
	request := func(workID string, permissions ...string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/works/"+workID+"/local-files/duplicates", nil)
		request.SetPathValue("id", workID)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 0, Permissions: permissions}))
		response := httptest.NewRecorder()
		fixture.server.findWorkDuplicateFiles(response, request)
		return response
	}
	if response := request(jsonNumber(fixture.originID), "playback:use"); response.Code != http.StatusForbidden {
		t.Fatalf("status without downloads:manage = %d", response.Code)
	}
	response := request(jsonNumber(fixture.originID), "downloads:manage")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"complete":true`) {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), filepath.ToSlash(fixture.dataRoot)) {
		t.Fatalf("response exposes the data root: %s", response.Body.String())
	}
	if response := request("999999", "downloads:manage"); response.Code != http.StatusNotFound {
		t.Fatalf("unknown work status = %d", response.Code)
	}
}
