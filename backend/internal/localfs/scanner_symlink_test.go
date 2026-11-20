package localfs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCollectWorkFilesSkipsFileSymlink(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "RJ00000000")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.mp3")
	if err := os.WriteFile(outside, []byte("synthetic audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(work, "track.mp3")); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}
	files, err := CollectWorkFiles(root, work)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("CollectWorkFiles returned symlink file: %+v", files)
	}
}

// filepath.WalkDir does not descend into a start that is a link. A data root
// reached through one is still walked, with paths below the configured root.
func TestDiscoverFoldersWalksLinkedDataRoot(t *testing.T) {
	target := t.TempDir()
	if err := os.MkdirAll(filepath.Join(target, "Works", "RJ00000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "data")
	linkDirectoryForTest(t, target, root)
	folders, summary, err := DiscoverFolders(root, Options{ScanDepth: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].RelPath != "Works/RJ00000000" || folders[0].AbsPath != filepath.Join(root, "Works", "RJ00000000") {
		t.Fatalf("folders below a linked data root = %+v", folders)
	}
	if len(summary.UnreadableFolders) != 0 {
		t.Fatalf("unreadable folders = %v", summary.UnreadableFolders)
	}
}

// A storage pool replaced by a link is not walked. It is reported unreadable,
// so the works recorded below it are unseen rather than missing.
func TestDiscoverFoldersLeavesLinkedSubRootUnseen(t *testing.T) {
	target := t.TempDir()
	if err := os.MkdirAll(filepath.Join(target, "RJ00000001"), 0o755); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	linkDirectoryForTest(t, target, filepath.Join(root, "disk1"))
	folders, summary, err := DiscoverFolders(root, Options{ScanDepth: 2, SubRoots: []string{"disk1"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 0 {
		t.Fatalf("folders below a linked pool = %+v", folders)
	}
	if len(summary.UnreadableFolders) != 1 || summary.UnreadableFolders[0] != "disk1" {
		t.Fatalf("unreadable folders = %v, want the linked pool", summary.UnreadableFolders)
	}
}
