package httpapi

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func linkFetchTestDirectory(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err == nil {
		return
	} else if runtime.GOOS != "windows" {
		t.Skipf("directory links unavailable: %v", err)
	}
	// Junctions exercise the Windows reparse-point boundary without requiring
	// the privilege needed to create symbolic links.
	if output, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Fatalf("create test junction: %v: %s", err, output)
	}
}

func assertFetchTestFile(t *testing.T, name, want string) {
	t.Helper()
	got, err := os.ReadFile(name)
	if err != nil || string(got) != want {
		t.Fatalf("protected file content=%q error=%v, want %q", got, err, want)
	}
}

func TestFetchInitializationRejectsLinkedStagingParents(t *testing.T) {
	for _, parent := range []string{".kikoto-staging", ".kikoto-staging/1"} {
		t.Run(parent, func(t *testing.T) {
			server, _, _ := newFetchPublishFixture(t)
			manifest, err := server.loadRemoteFetchManifest(context.Background(), 1)
			if err != nil {
				t.Fatal(err)
			}
			paths, err := server.remoteFetchPublishPaths(manifest)
			if err != nil {
				t.Fatal(err)
			}
			outside := t.TempDir()
			relative, err := filepath.Rel(filepath.FromSlash(parent), filepath.FromSlash(manifest.StagingRoot))
			if err != nil {
				t.Fatal(err)
			}
			sentinel := filepath.Join(outside, relative, "keep.txt")
			writeFetchTestFile(t, outside, filepath.ToSlash(filepath.Join(relative, "keep.txt")), "keep")
			linkFetchTestDirectory(t, outside, filepath.Join(server.cfg.DataRoot, filepath.FromSlash(parent)))

			if err := server.initializeRemoteFetchStaging(context.Background(), manifest, paths); err == nil {
				t.Error("Fetch initialized through a linked staging parent")
			}
			assertFetchTestFile(t, sentinel, "keep")
		})
	}
}

func TestFetchResumedStagingRejectsLinkedSubdirectories(t *testing.T) {
	server, _, plan := newFetchPublishFixture(t)
	ctx := context.Background()
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.initializeRemoteFetchStaging(ctx, manifest, paths); err != nil {
		t.Fatal(err)
	}
	manifest.State = "staging"
	outside := t.TempDir()
	writeFetchTestFile(t, outside, "track.mp3", "keep")
	linkFetchTestDirectory(t, outside, filepath.Join(paths.stageRoot, "nested"))
	plan.Items[0].TargetPath = plan.SaveRoot + "/nested/track.mp3"

	if err := server.stageRemoteFetchItems(ctx, manifest, plan, paths); err == nil {
		t.Error("Fetch wrote through a linked staging subdirectory")
	}
	assertFetchTestFile(t, filepath.Join(outside, "track.mp3"), "keep")
}

func TestFetchInitializationRejectsLinkedTargetParent(t *testing.T) {
	server, _, _ := newFetchPublishFixture(t)
	ctx := context.Background()
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	library := filepath.Join(server.cfg.DataRoot, "Library")
	outside := filepath.Join(t.TempDir(), "Library")
	if err := os.Rename(library, outside); err != nil {
		t.Fatal(err)
	}
	linkFetchTestDirectory(t, outside, library)

	if err := server.initializeRemoteFetchStaging(ctx, manifest, paths); err == nil {
		t.Error("Fetch copied a target behind a linked parent")
	}
	assertFetchTestFile(t, filepath.Join(outside, filepath.Base(paths.targetRoot), "earlier.mp3"), "earlier")
}

func TestFetchRootContainsOperationsAfterParentReplacement(t *testing.T) {
	server, _, _ := newFetchPublishFixture(t)
	manifest, err := server.loadRemoteFetchManifest(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	root, scoped, err := server.openRemoteFetchPublishPaths(paths)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = root.Close() }()
	outside := t.TempDir()
	writeFetchTestFile(t, outside, "1/work/keep.txt", "keep")
	// The path was valid when opened; replacing a parent afterwards must
	// still leave outside files untouched.
	linkFetchTestDirectory(t, outside, filepath.Join(server.cfg.DataRoot, ".kikoto-staging"))

	if err := removeFetchDirectory(root, scoped.stageRoot); err == nil {
		t.Error("Fetch followed a parent replaced after validation")
	}
	assertFetchTestFile(t, filepath.Join(outside, "1", "work", "keep.txt"), "keep")
}

func TestFetchPublicationRejectsLinkedBackupNamespace(t *testing.T) {
	server, _, plan := newFetchPublishFixture(t)
	ctx := context.Background()
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
	outside := t.TempDir()
	linkFetchTestDirectory(t, outside, filepath.Join(server.cfg.DataRoot, ".kikoto-backup"))

	if err := server.publishRemoteFetchRoot(ctx, manifest, paths); err == nil {
		t.Error("Fetch published through a linked backup namespace")
	}
	assertFetchTestFile(t, filepath.Join(paths.targetRoot, "earlier.mp3"), "earlier")
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatalf("Fetch changed the external backup directory: entries=%v error=%v", entries, err)
	}
}

func TestFetchRecoveryRejectsLinkedStagingNamespace(t *testing.T) {
	server, _, _ := newFetchPublishFixture(t)
	ctx := context.Background()
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(paths.targetRoot); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	writeFetchTestFile(t, outside, "1/work/keep.txt", "keep")
	linkFetchTestDirectory(t, outside, filepath.Join(server.cfg.DataRoot, ".kikoto-staging"))
	manifest.State = "publishing"

	if err := server.reconcilePublishingRemoteFetch(ctx, manifest); err == nil {
		t.Error("Fetch recovered through a linked staging namespace")
	}
	assertFetchTestFile(t, filepath.Join(outside, "1", "work", "keep.txt"), "keep")
}

func TestFetchCompletionKeepsBackupBehindLinkedNamespace(t *testing.T) {
	server, _, plan := newFetchPublishFixture(t)
	ctx := context.Background()
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	writeFetchTestFile(t, outside, "1/work/keep.txt", "keep")
	linkFetchTestDirectory(t, outside, filepath.Join(server.cfg.DataRoot, ".kikoto-backup"))

	if err := server.completeRemoteFetchManifest(ctx, manifest, plan, map[string]any{}, 0, 0); err != nil {
		t.Fatal(err)
	}
	assertFetchTestFile(t, filepath.Join(outside, "1", "work", "keep.txt"), "keep")
}
