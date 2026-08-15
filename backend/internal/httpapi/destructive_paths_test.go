package httpapi

import (
	"os"
	"path/filepath"
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
