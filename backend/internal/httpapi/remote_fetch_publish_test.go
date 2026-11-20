package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Publication renames only the Fetch's own files into an existing folder.
// Every other file keeps its content, its modification time, and its links,
// including a change made after staging, and a linked subfolder the Fetch
// does not write into does not stop it.
func TestFetchIntoAnExistingFolderPlacesOnlyItsOwnFiles(t *testing.T) {
	ctx := context.Background()
	server, _, plan := newFetchPublishFixture(t)
	target := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.SaveRoot))
	earlier := filepath.Join(target, "earlier.mp3")
	old := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := os.Chtimes(earlier, old, old); err != nil {
		t.Fatal(err)
	}
	hardLink := filepath.Join(server.cfg.DataRoot, "Shared", "earlier-link.mp3")
	if err := os.MkdirAll(filepath.Dir(hardLink), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(earlier, hardLink); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	outside := t.TempDir()
	writeFetchTestFile(t, outside, "bonus.txt", "bonus")
	linkFetchTestDirectory(t, outside, filepath.Join(target, "Extras"))

	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.stageRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
		t.Fatal(err)
	}
	if err := server.verifyRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
		t.Fatal(err)
	}
	// A change made while the Fetch waits to publish.
	writeFetchTestFile(t, target, "notes.txt", "written meanwhile")
	if err := server.publishRemoteFetchFiles(ctx, manifest, paths); err != nil {
		t.Fatal(err)
	}

	assertFetchTestFile(t, filepath.Join(target, "track.mp3"), "track")
	assertFetchTestFile(t, filepath.Join(target, "notes.txt"), "written meanwhile")
	assertFetchTestFile(t, filepath.Join(target, "Extras", "bonus.txt"), "bonus")
	info, err := os.Stat(earlier)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(old) {
		t.Fatalf("unselected file modification time = %v, want %v", info.ModTime(), old)
	}
	linked, err := os.Stat(hardLink)
	if err != nil || !os.SameFile(info, linked) {
		t.Fatalf("unselected file lost its hard link: %v", err)
	}
	if _, err := os.Stat(paths.stageRoot); !os.IsNotExist(err) {
		t.Fatalf("staging left after publication: %v", err)
	}
}

// A replaced file moves to the run backup on the same pool and stays there
// until the Fetch completes; a placement interrupted between the two renames
// finishes from the staged file.
func TestFetchKeepsAReplacedFileRecoverableUntilCompletion(t *testing.T) {
	ctx := context.Background()
	server, _, plan := newFetchPublishFixture(t)
	target := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.SaveRoot))
	writeFetchTestFile(t, target, "track.mp3", "older")
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.stageAndPublishRemoteFetch(ctx, manifest, plan); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(manifest.BackupRoot))
	assertFetchTestFile(t, filepath.Join(target, "track.mp3"), "track")
	assertFetchTestFile(t, filepath.Join(backup, "track.mp3"), "older")
	assertFetchTestFile(t, filepath.Join(target, "earlier.mp3"), "earlier")
	if _, err := os.Stat(filepath.Join(backup, "earlier.mp3")); !os.IsNotExist(err) {
		t.Fatalf("an unselected file was moved to the backup: %v", err)
	}
}

// A staged file removed by hand before its placement leaves nothing half
// done: the replaced file returns to its place and the Fetch stages again.
func TestFetchPlacementRestoresAReplacedFileWhenItsStagedFileIsGone(t *testing.T) {
	ctx := context.Background()
	server, db, plan := newFetchPublishFixture(t)
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	writeFetchTestFile(t, paths.backupRoot, "track.mp3", "older")
	if err := os.MkdirAll(paths.stageRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	execFetchTestStatements(t, db, `UPDATE remote_fetch_manifest SET state = 'publishing' WHERE id = 1`)
	manifest.State = "publishing"

	if manifest, err = server.settleInterruptedRemoteFetchPublication(ctx, manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.State != "planned" {
		t.Fatalf("manifest state = %q, want planned", manifest.State)
	}
	assertFetchTestFile(t, filepath.Join(paths.targetRoot, "track.mp3"), "older")
	if _, err := server.stageAndPublishRemoteFetch(ctx, manifest, plan); err != nil {
		t.Fatal(err)
	}
	assertFetchTestFile(t, filepath.Join(paths.targetRoot, "track.mp3"), "track")
}

// A retry that stages a file an earlier attempt already placed finds the same
// content in the target and keeps the earlier backup of the replaced file.
func TestFetchRetryKeepsAFileAnEarlierAttemptPlaced(t *testing.T) {
	ctx := context.Background()
	server, _, plan := newFetchPublishFixture(t)
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(plan.SaveRoot))
	backup := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(manifest.BackupRoot))
	writeFetchTestFile(t, target, "track.mp3", "track")
	writeFetchTestFile(t, backup, "track.mp3", "original")
	if _, err := server.stageAndPublishRemoteFetch(ctx, manifest, plan); err != nil {
		t.Fatalf("retry of a placed file: %v", err)
	}
	assertFetchTestFile(t, filepath.Join(target, "track.mp3"), "track")
	assertFetchTestFile(t, filepath.Join(backup, "track.mp3"), "original")
}

// A publication that fails part way, here on a target that became a folder,
// puts back what it placed: the replaced file returns, the placed file goes
// back to staging, and the Fetch is verified again rather than left
// publishing, so a retry publishes the same staged files.
func TestFetchPublicationThatFailsPartWayPutsBackWhatItPlaced(t *testing.T) {
	ctx := context.Background()
	server, db, _ := newFetchPublishFixture(t)
	root := "Library/RJ00000000"
	execFetchTestStatements(t, db, `DELETE FROM remote_fetch_manifest`)
	size := int64(len("track"))
	plan := remoteWorkSavePlan{SourceID: 1, PrimaryCode: "RJ00000000", SaveRoot: root}
	for _, name := range []string{"a.mp3", "b.mp3"} {
		cachePath := "remote/RJ00000000/" + name
		writeFetchTestFile(t, server.cfg.CacheRoot, cachePath, "track")
		plan.Items = append(plan.Items, remoteWorkSavePlanItem{
			ItemKey: "remote:" + name, Path: name, Kind: "audio", SizeBytes: &size, SourceKind: "remote", Action: "cache_hit",
			CachePath: cachePath, TargetPath: root + "/" + name, OriginalTargetPath: root + "/" + name, Resolution: "replace", RemoteSourceID: 1,
		})
	}
	plan.Summary = summarizeRemoteSavePlan(plan.Items)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createRemoteFetchManifest(ctx, tx, 1, 1, "synthetic-request", 1, 1, 2, plan); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(root))
	writeFetchTestFile(t, target, "a.mp3", "older")
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.stageRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
		t.Fatal(err)
	}
	if err := server.verifyRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
		t.Fatal(err)
	}
	// The second target turns into a folder before publication.
	if err := os.MkdirAll(filepath.Join(target, "b.mp3"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := server.publishRemoteFetchFiles(ctx, manifest, paths); err == nil {
		t.Fatal("publication over a folder succeeded")
	}
	assertFetchTestFile(t, filepath.Join(target, "a.mp3"), "older")
	assertFetchTestFile(t, filepath.Join(paths.stageRoot, "a.mp3"), "track")
	if manifest, err = server.loadRemoteFetchManifest(ctx, 1); err != nil || manifest.State != "verified" {
		t.Fatalf("manifest after a failed publication = %q, %v; want verified", manifest.State, err)
	}
	// Once the folder is gone, the retry publishes the same staged files.
	if err := os.Remove(filepath.Join(target, "b.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := server.publishRemoteFetchFiles(ctx, manifest, paths); err != nil {
		t.Fatal(err)
	}
	assertFetchTestFile(t, filepath.Join(target, "a.mp3"), "track")
	assertFetchTestFile(t, filepath.Join(target, "b.mp3"), "track")
}
