package httpapi

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestRemoveDestructiveFileRejectsParentSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	outsideFile := filepath.Join(outside, "outside.txt")
	if err := os.WriteFile(outsideFile, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	if _, _, err := removeDestructiveFile(root, filepath.Join("link", "outside.txt")); err == nil {
		t.Fatal("parent symlink was accepted")
	}
	if _, err := os.Stat(outsideFile); err != nil {
		t.Fatalf("outside file was affected: %v", err)
	}
}

func TestRemoveDestructiveTreePreflightsNestedSymlink(t *testing.T) {
	root := t.TempDir()
	tree := filepath.Join(root, "tree")
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatal(err)
	}
	safeFile := filepath.Join(tree, "safe.txt")
	if err := os.WriteFile(safeFile, []byte("safe"), 0o644); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(tree, "link")); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	if _, err := removeDestructiveTree(root, "tree"); err == nil {
		t.Fatal("tree containing a symlink was accepted")
	}
	if _, err := os.Stat(safeFile); err != nil {
		t.Fatalf("preflight removed a safe file before rejecting the tree: %v", err)
	}
}

func TestValidateDestructivePathRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	if _, err := validateDestructivePath(root, filepath.Join("..", "outside"), true, false); err == nil {
		t.Fatal("path traversal was accepted")
	}
}

// linkTestDirectory links link to target with a symbolic link, or with a
// junction on Windows when symbolic links need a privilege the test lacks.
func linkTestDirectory(t *testing.T, target, link string) {
	t.Helper()
	symlinkErr := os.Symlink(target, link)
	if symlinkErr == nil {
		return
	}
	if runtime.GOOS == "windows" {
		output, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
		if err == nil {
			return
		}
		t.Skipf("directory link is not available: %v; junction: %v (%s)", symlinkErr, err, output)
	}
	t.Skipf("directory symlink is not available on this system: %v", symlinkErr)
}

// A data root reached through a link is the configured root, so deletion works
// below it; a link below the root is still refused.
func TestDestructivePathsFollowALinkedDataRootOnly(t *testing.T) {
	target := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(target, "Library", "RJ00000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	trackPath := filepath.Join(target, "Library", "RJ00000000", "track.mp3")
	if err := os.WriteFile(trackPath, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "outside.mp3")
	if err := os.WriteFile(outsideFile, []byte("outside"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "data")
	linkTestDirectory(t, target, root)
	linkTestDirectory(t, outside, filepath.Join(target, "Escape"))

	deleted, _, err := removeDestructiveFile(root, "Library/RJ00000000/track.mp3")
	if err != nil || !deleted {
		t.Fatalf("delete below a linked data root = %t, %v", deleted, err)
	}
	if _, err := os.Stat(trackPath); !os.IsNotExist(err) {
		t.Fatalf("track still exists: %v", err)
	}
	if _, _, err := removeDestructiveFile(root, "Escape/outside.mp3"); err == nil {
		t.Fatal("a link below the data root was followed")
	}
	if _, err := os.Stat(outsideFile); err != nil {
		t.Fatalf("outside file was affected: %v", err)
	}
}
