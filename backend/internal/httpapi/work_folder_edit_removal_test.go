package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A removed file waits in the edit's staging folder on its pool until the edit
// succeeds. An edit that fails after the removal puts the file back, with its
// location available again, and a later successful edit deletes it.
func TestWorkFolderEditPutsARemovedFileBackWhenItFails(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"selected.txt": "copied into the edited folder"})
	before := fixture.withSecondTrack(t)
	removedID := before[folderEditSecondTrack]
	body := map[string]any{
		"removeLocationIds": []int64{removedID},
		"additions":         []any{localAddition(siblingFolderID, "selected.txt")},
	}
	job := fixture.apply(t, body)
	// A file that appears at the added file's path stops the edit after the
	// removal.
	if err := os.WriteFile(fixture.targetFile("selected.txt"), []byte("appeared after the plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the edit published over a file that appeared after the plan")
	}
	if status := fixture.runStatus(t, job.RunID); status != "failed" {
		t.Fatalf("run status = %q", status)
	}
	if content, err := os.ReadFile(fixture.targetFile(folderEditSecondTrack)); err != nil || string(content) != "second synthetic audio" {
		t.Fatalf("the removed file did not return: %q, %v", content, err)
	}
	if after := fixture.locations(t); after[folderEditSecondTrack] != removedID {
		t.Fatalf("the returned file's location is not available: %v", after)
	}
	fixture.assertNoEditStaging(t)

	if err := os.Remove(fixture.targetFile("selected.txt")); err != nil {
		t.Fatal(err)
	}
	fixture.run(t, body)
	if _, err := os.Stat(fixture.targetFile(folderEditSecondTrack)); !os.IsNotExist(err) {
		t.Fatalf("the removed file is still there after the edit succeeded: %v", err)
	}
	if _, ok := fixture.locations(t)[folderEditSecondTrack]; ok {
		t.Fatal("the removed file's location is still available")
	}
}

// A file set aside without its checkpoint, as a failure or a stop between
// the rename and the checkpoint leaves it, still returns to its place when
// the edit is discarded.
func TestWorkFolderEditPutsBackARemovalItsCheckpointMissed(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	job := fixture.apply(t, map[string]any{"removeLocationIds": []int64{before[folderEditSecondTrack]}})
	execution := stageFolderEditForRecovery(t, fixture, job)
	if err := os.MkdirAll(execution.stagingAbs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(fixture.targetFile(folderEditSecondTrack), execution.removedPath(0)); err != nil {
		t.Fatal(err)
	}
	if kept := execution.discardStaging(context.Background()); kept != 0 {
		t.Fatalf("files kept in staging = %d", kept)
	}
	if content, err := os.ReadFile(fixture.targetFile(folderEditSecondTrack)); err != nil || string(content) != "second synthetic audio" {
		t.Fatalf("the set-aside file did not return: %q, %v", content, err)
	}
}

// A removed file whose path the edit's own replacement took cannot return:
// the replacement stays, as the edit decided, and the set-aside file goes
// instead of waiting in staging for good.
func TestWorkFolderEditDropsARemovalItsReplacementTookThePlaceOf(t *testing.T) {
	dataRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot})
	execution := &workFolderEditExecution{server: server}
	execution.targetAbs = filepath.Join(dataRoot, "Library", "RJ00000024")
	execution.stagingAbs = filepath.Join(dataRoot, "Library", ".kikoto-staging", "1", "edit")
	execution.payload.Removals = []mediaCleanupTarget{{Kind: "local", LocationID: 1, Path: "Library/RJ00000024/track.mp3"}}
	var item workFolderEditItem
	item.ItemKey, item.TargetPath = "local:track.mp3", "Library/RJ00000024/track.mp3"
	execution.payload.Items = []workFolderEditItem{item}
	execution.checkpoint.Published = []string{"local:track.mp3"}
	execution.checkpoint.Removed = []string{mediaCleanupTargetKey(execution.payload.Removals[0])}
	writeFetchTestFile(t, execution.targetAbs, "track.mp3", "replacement")
	writeFetchTestFile(t, execution.stagingAbs, "r000000", "replaced")

	if kept := execution.putBackRemovals(context.Background()); kept != 0 {
		t.Fatalf("files kept in staging = %d", kept)
	}
	assertFetchTestFile(t, filepath.Join(execution.targetAbs, "track.mp3"), "replacement")
	if _, err := os.Stat(execution.removedPath(0)); !os.IsNotExist(err) {
		t.Fatalf("the replaced file still waits in staging: %v", err)
	}
}
