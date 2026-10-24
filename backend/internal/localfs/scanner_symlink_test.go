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
