package httpapi

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestCopyFileCopiesAcrossChunkBoundaries(t *testing.T) {
	root := t.TempDir()
	content := make([]byte, 2*copyFileBufferBytes+123)
	for index := range content {
		content[index] = byte(index % 251)
	}
	source := filepath.Join(root, "source.bin")
	target := filepath.Join(root, "staging", "target.bin")
	if err := os.WriteFile(source, content, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(source, target); err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(copied, content) {
		t.Fatalf("copied %d bytes, want %d identical bytes: %v", len(copied), len(content), err)
	}
	if _, err := os.Stat(target + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("temporary copy left behind: %v", err)
	}
}
