package httpapi

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

const folderEditManagedLyricsPath = "lyrics_kikoto/ja/Track1.vtt"

// siblingWithManagedLyrics gives the sibling edition a local folder whose
// lyrics folder Kikoto created and holds Japanese lyrics.
func (fixture folderEditFixture) siblingWithManagedLyrics(t *testing.T) int64 {
	t.Helper()
	sibling := filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002")
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ensureLyricsRoot(sibling); err != nil {
		t.Fatal(err)
	}
	return fixture.addSiblingFolder(t, map[string]string{folderEditManagedLyricsPath: lyricsFetchVTT})
}

func TestWorkFolderEditCopiesManagedLyricsIntoAMarkedLyricsFolder(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.siblingWithManagedLyrics(t)
	body := map[string]any{"additions": []any{localAddition(siblingFolderID, folderEditManagedLyricsPath)}}

	plan := fixture.plan(t, body)
	if len(plan.Items) != 1 || plan.Items[0].TargetPath != fixture.root+"/"+folderEditManagedLyricsPath || plan.Items[0].Action != "copy_local" {
		t.Fatalf("plan items = %+v", plan.Items)
	}
	job := fixture.apply(t, body)
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(fixture.targetFile(folderEditManagedLyricsPath)); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("lyrics file = %q, %v", content, err)
	}
	if !lyricsRootOwned(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root))) {
		t.Fatal("the lyrics folder is not marked as Kikoto's")
	}
	fixture.assertNoEditStaging(t)
}

func TestWorkFolderEditNeverWritesIntoALyricsFolderItDidNotCreate(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.siblingWithManagedLyrics(t)
	if err := os.MkdirAll(fixture.targetFile("lyrics_kikoto"), 0o755); err != nil {
		t.Fatal(err)
	}
	response := fixture.request(t, fixture.server.planWorkFolderEdit, map[string]any{
		"additions": []any{localAddition(siblingFolderID, folderEditManagedLyricsPath)},
	})
	if response.Code != http.StatusConflict {
		t.Fatalf("blocked lyrics folder: status = %d, body = %s", response.Code, response.Body.String())
	}

	// A file is never placed into the lyrics folder; lyrics of a language are
	// added in Manage lyrics.
	placed := remoteAddition("RJ00000002", folderEditVTTPath)
	placed["targetPath"] = "lyrics_kikoto/ja/Track1.vtt"
	response = fixture.request(t, fixture.server.planWorkFolderEdit, map[string]any{"additions": []any{placed}})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("placed into the lyrics folder: status = %d, body = %s", response.Code, response.Body.String())
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("a refused edit queued a run")
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("refused edits made %d upstream requests", fixture.requests.Load())
	}
}
