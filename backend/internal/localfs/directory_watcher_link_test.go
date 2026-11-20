package localfs

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// linkDirectoryForTest links link to target with a symbolic link, or with a
// junction on Windows when symbolic links need a privilege the test lacks.
func linkDirectoryForTest(t *testing.T, target, link string) {
	t.Helper()
	symlinkErr := os.Symlink(target, link)
	if symlinkErr == nil {
		return
	}
	if runtime.GOOS == "windows" {
		if output, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err == nil {
			return
		} else {
			t.Skipf("directory link is not available: %v; junction: %v (%s)", symlinkErr, err, output)
		}
	}
	t.Skipf("directory symlink is not available on this system: %v", symlinkErr)
}

// A data root reached through a link is watched below the link, as a scan
// walks it, and its changes are reported under the configured root.
func TestDirectoryWatcherWatchesALinkedDataRoot(t *testing.T) {
	target := t.TempDir()
	workDir := filepath.Join(target, "Library", "RJ00000000")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "data")
	linkDirectoryForTest(t, target, root)
	watcher, err := NewDirectoryWatcher(root, 2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	if count := watcher.WatchedDirectoryCount(); count != 3 {
		t.Fatalf("watched directories below a linked root = %d, want 3", count)
	}
	trackPath := filepath.Join(root, "Library", "RJ00000000", "track.flac")
	if err := os.WriteFile(trackPath, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	for {
		select {
		case change := <-watcher.Changes():
			if sameFilesystemPath(change.Path, trackPath) {
				return
			}
		case <-deadline:
			t.Fatal("timed out waiting for a change below the linked root")
		}
	}
}
