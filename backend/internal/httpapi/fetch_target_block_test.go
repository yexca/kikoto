package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLyricsEditNeverOffersToReplaceAFolder(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	const sidecar = "mp3/Track1.Original name.mp3.vtt"
	const managed = "lyrics_ja/" + sidecar
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT})
	if err := os.MkdirAll(fixture.absolute(managed), 0o755); err != nil {
		t.Fatal(err)
	}
	body := func(resolution string) map[string]any {
		edit := map[string]any{"additions": []any{lyricsEditFolderAddition(sidecar, "ja-jp")}}
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
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT, "lyrics_ja": "not a folder"})
	body := func(resolution string) map[string]any {
		return map[string]any{
			"additions": []any{lyricsEditFolderAddition(sidecar, "ja-jp")},
			"decisions": []any{map[string]any{"itemKey": "folder:" + sidecar, "resolution": resolution}},
		}
	}

	for _, resolution := range []string{"auto", "replace", "keep_both"} {
		plan := fixture.plan(t, body(resolution))
		item := plan.Items[0]
		if plan.Summary.Conflict != 1 || item.TargetBlock != targetBlockBlockedPath || !strings.Contains(item.TargetConflictReason, "lyrics_ja") {
			t.Fatalf("%s plan = %+v", resolution, plan.Items)
		}
	}
	if fixture.content("lyrics_ja") != "not a folder" || fixture.content(sidecar) != lyricsFetchVTT {
		t.Fatal("planning changed the folder")
	}
}

func TestAddingGeneratedLyricsExplainsAFileBlockingTheLyricsFolder(t *testing.T) {
	fixture := newASRFixture(t, 3)
	_, id, _ := fixture.create(t, "ja-jp")
	if err := fixture.server.runNextQueuedWorkflowJob(t.Context()); err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_ja", "mp3")
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
