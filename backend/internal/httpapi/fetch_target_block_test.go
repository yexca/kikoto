package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

func TestLyricsEditNeverOffersToReplaceAFolder(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	const sidecar = "mp3/Track1.Original name.mp3.vtt"
	const managed = "lyrics_kikoto/ja/" + sidecar
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT})
	ownLyricsRoot(t, fixture.absolute(""))
	if err := os.MkdirAll(fixture.absolute(managed), 0o755); err != nil {
		t.Fatal(err)
	}
	body := func(resolution string) map[string]any {
		edit := map[string]any{"additions": []any{lyricsEditFolderAddition(sidecar, "ja-jp")}, "folderMode": "move"}
		if resolution != "" {
			edit["decisions"] = []any{map[string]any{"itemKey": "folder:" + sidecar, "resolution": resolution}}
		}
		return edit
	}

	plan := fixture.plan(t, body(""))
	if plan.Summary.Conflict != 1 || plan.Items[0].TargetBlock != targetBlockNotFile {
		t.Fatalf("plan = %+v", plan.Items)
	}
	// Replace cannot remove a folder, so the conflict stays unresolved instead
	// of failing when the edit is applied.
	if plan := fixture.plan(t, body("replace")); plan.Summary.Conflict != 1 || plan.Items[0].Resolution != "auto" {
		t.Fatalf("replace plan = %+v", plan.Items)
	}
	if response := fixture.edit(t, body("replace")); response.Code != http.StatusConflict {
		t.Fatalf("replace edit = %d %s", response.Code, response.Body.String())
	}
	if info, err := os.Stat(fixture.absolute(managed)); err != nil || !info.IsDir() {
		t.Fatalf("the folder at the target changed: %v", err)
	}
	// Keeping both still gives the incoming file a free name beside the folder.
	if plan := fixture.plan(t, body("keep_both")); plan.Summary.Move != 1 || plan.Items[0].TargetPath == fixture.root+"/"+managed {
		t.Fatalf("keep-both plan = %+v", plan.Items)
	}
	fixture.assertNoStagingLeft(t)
}

func TestLyricsEditNamesAFileThatBlocksTheLyricsFolder(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	const sidecar = "mp3/Track1.Original name.mp3.vtt"
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT, "lyrics_kikoto/ja": "not a folder"})
	body := func(resolution string) map[string]any {
		return map[string]any{
			"additions": []any{lyricsEditFolderAddition(sidecar, "ja-jp")},
			"decisions": []any{map[string]any{"itemKey": "folder:" + sidecar, "resolution": resolution}},
		}
	}

	for _, resolution := range []string{"auto", "replace", "keep_both"} {
		plan := fixture.plan(t, body(resolution))
		item := plan.Items[0]
		if plan.Summary.Conflict != 1 || item.TargetBlock != targetBlockBlockedPath || !strings.Contains(item.TargetConflictReason, "lyrics_kikoto/ja") {
			t.Fatalf("%s plan = %+v", resolution, plan.Items)
		}
	}
	if fixture.content("lyrics_kikoto/ja") != "not a folder" || fixture.content(sidecar) != lyricsFetchVTT {
		t.Fatal("planning changed the folder")
	}
}

// A work can ship a folder of the lyrics folder's name. Kikoto neither adds
// lyrics into it nor offers its files as managed lyrics to delete.
func TestLyricsEditLeavesALyricsFolderKikotoDidNotCreate(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	const sidecar = "mp3/Track1.Original name.mp3.vtt"
	const shipped = "lyrics_kikoto/ja/Track1.lrc"
	if err := os.MkdirAll(filepath.Dir(fixture.absolute(shipped)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.absolute(shipped), []byte("[00:01.00]shipped"), 0o644); err != nil {
		t.Fatal(err)
	}
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT})

	response := fixture.request(t, "/plan", fixture.server.planWorkLyricsEdit,
		map[string]any{"additions": []any{lyricsEditFolderAddition(sidecar, "ja-jp")}})
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != http.StatusConflict || body.Code != "lyrics_folder_blocked" {
		t.Fatalf("add plan = %d %s", response.Code, response.Body.String())
	}
	locationID, _ := fixture.location(t, shipped)
	if removal := fixture.edit(t, map[string]any{"removeLocationIds": []int64{locationID}}); removal.Code != http.StatusBadRequest {
		t.Fatalf("removal = %d %s", removal.Code, removal.Body.String())
	}
	if fixture.content(shipped) != "[00:01.00]shipped" || fixture.content(sidecar) != lyricsFetchVTT {
		t.Fatal("the edit changed the work's files")
	}
	if _, err := os.Lstat(fixture.absolute("lyrics_kikoto/" + localfs.LyricsRootMarkerName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the work's folder was marked as Kikoto's: %v", err)
	}
}

// On a case-insensitive filesystem a folder whose name differs only in case
// would take the lyrics under a path the index does not know.
func TestLyricsRootRefusesANameThatDiffersOnlyInCase(t *testing.T) {
	workRoot := t.TempDir()
	if err := os.Mkdir(filepath.Join(workRoot, "Lyrics_Kikoto"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensureLyricsRoot(workRoot); !errors.Is(err, errLyricsFolderBlocked) {
		t.Fatalf("ensure = %v, want the folder blocked", err)
	}
	if _, err := os.Lstat(filepath.Join(workRoot, "Lyrics_Kikoto", localfs.LyricsRootMarkerName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the differently named folder was marked: %v", err)
	}
}

func TestAddingGeneratedLyricsExplainsAFileBlockingTheLyricsFolder(t *testing.T) {
	fixture := newASRFixture(t, 3)
	_, id, _ := fixture.create(t, "ja-jp")
	if err := fixture.server.runNextQueuedWorkflowJob(t.Context()); err != nil {
		t.Fatal(err)
	}
	ownLyricsRoot(t, filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root)))
	blocker := filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_kikoto", "ja", "mp3")
	if err := os.MkdirAll(filepath.Dir(blocker), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(blocker, []byte("not a folder"), 0o644); err != nil {
		t.Fatal(err)
	}

	response := fixture.accept(t, id)
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != http.StatusConflict || body.Code != "lyrics_folder_blocked" {
		t.Fatalf("accept = %d %s", response.Code, response.Body.String())
	}
	if content, err := os.ReadFile(blocker); err != nil || string(content) != "not a folder" {
		t.Fatalf("the blocking file changed: %q, %v", content, err)
	}
	// The transcription is kept, so it can be added once the file is moved.
	if err := os.Remove(blocker); err != nil {
		t.Fatal(err)
	}
	if accepted := fixture.accept(t, id); accepted.Code != http.StatusOK {
		t.Fatalf("retry = %d %s", accepted.Code, accepted.Body.String())
	}
}

func TestAddingGeneratedLyricsLeavesALyricsFolderKikotoDidNotCreate(t *testing.T) {
	fixture := newASRFixture(t, 3)
	_, id, _ := fixture.create(t, "ja-jp")
	if err := fixture.server.runNextQueuedWorkflowJob(t.Context()); err != nil {
		t.Fatal(err)
	}
	shipped := filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_kikoto", "ja")
	if err := os.MkdirAll(shipped, 0o755); err != nil {
		t.Fatal(err)
	}

	response := fixture.accept(t, id)
	var body struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(response.Body.Bytes(), &body)
	if response.Code != http.StatusConflict || body.Code != "lyrics_folder_blocked" {
		t.Fatalf("accept = %d %s", response.Code, response.Body.String())
	}
	if entries, err := os.ReadDir(shipped); err != nil || len(entries) != 0 {
		t.Fatalf("the work's folder changed: %v, %v", entries, err)
	}
}

func TestWorkFolderEditKeepsFoldersAndBlockingFilesOutOfReplace(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{
		"extra/notes.txt": "synthetic notes",
		"blocked/a.txt":   "synthetic text",
	})
	if err := os.MkdirAll(fixture.targetFile("extra/notes.txt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixture.targetFile("blocked"), []byte("not a folder"), 0o644); err != nil {
		t.Fatal(err)
	}
	notes := localAddition(siblingFolderID, "extra/notes.txt")
	blocked := localAddition(siblingFolderID, "blocked/a.txt")
	key := func(path string) string { return "local:" + jsonNumber(siblingFolderID) + ":" + path }
	decide := func(resolution string) map[string]any {
		return map[string]any{
			"additions": []any{notes, blocked},
			"decisions": []any{
				map[string]any{"itemKey": key("extra/notes.txt"), "resolution": resolution},
				map[string]any{"itemKey": key("blocked/a.txt"), "resolution": resolution},
			},
		}
	}

	for _, resolution := range []string{"auto", "replace"} {
		plan := fixture.plan(t, decide(resolution))
		if plan.Summary.Conflict != 2 {
			t.Fatalf("%s plan = %+v", resolution, plan.Items)
		}
		blocks := map[string]string{}
		for _, item := range plan.Items {
			blocks[item.Path] = item.TargetBlock
		}
		if blocks["extra/notes.txt"] != targetBlockNotFile || blocks["blocked/a.txt"] != targetBlockBlockedPath {
			t.Fatalf("%s blocks = %v", resolution, blocks)
		}
	}
	// Keeping both works beside a folder, but not below a file.
	keepBoth := fixture.plan(t, decide("keep_both"))
	if keepBoth.Summary.Conflict != 1 {
		t.Fatalf("keep-both plan = %+v", keepBoth.Items)
	}
	if response := fixture.request(t, fixture.server.applyWorkFolderEdit, decide("replace")); response.Code != http.StatusConflict {
		t.Fatalf("replace apply = %d %s", response.Code, response.Body.String())
	}
	if info, err := os.Stat(fixture.targetFile("extra/notes.txt")); err != nil || !info.IsDir() {
		t.Fatalf("the folder at the target changed: %v", err)
	}
}
