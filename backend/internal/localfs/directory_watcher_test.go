package localfs

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDirectoryWatcherReportsVisibleChangesAndRegistersNewTrees(t *testing.T) {
	root := t.TempDir()
	workDir := filepath.Join(root, "Library", "RJ01234567")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatal(err)
	}
	watcher, err := NewDirectoryWatcher(root, 3)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	if watcher.WatchedDirectoryCount() != 3 {
		t.Fatalf("watched directories = %d, want 3", watcher.WatchedDirectoryCount())
	}
	if err := os.WriteFile(filepath.Join(workDir, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	waitForDirectoryChange(t, watcher.Changes())

	newWorkDir := filepath.Join(root, "New", "RJ07654321")
	if err := os.MkdirAll(newWorkDir, 0o755); err != nil {
		t.Fatal(err)
	}
	waitForDirectoryChange(t, watcher.Changes())
	deadline := time.Now().Add(3 * time.Second)
	for watcher.WatchedDirectoryCount() < 5 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if watcher.WatchedDirectoryCount() != 5 {
		t.Fatalf("watched directories after create = %d, want 5", watcher.WatchedDirectoryCount())
	}
}

func TestDirectoryWatcherIgnoresInternalTrees(t *testing.T) {
	root := t.TempDir()
	watcher, err := NewDirectoryWatcher(root, 4)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	if err := os.MkdirAll(filepath.Join(root, ".kikoto-staging", "42", "RJ01234567"), 0o755); err != nil {
		t.Fatal(err)
	}
	select {
	case <-watcher.Changes():
		t.Fatal("internal transaction directory emitted a visible change")
	case <-time.After(300 * time.Millisecond):
	}
	if watcher.WatchedDirectoryCount() != 1 {
		t.Fatalf("watched internal directories = %d, want root only", watcher.WatchedDirectoryCount())
	}
}

func TestDirectoryWatcherReportsAtomicPublicationFromInternalTree(t *testing.T) {
	root := t.TempDir()
	staged := filepath.Join(root, ".kikoto-staging", "42", "RJ01234567")
	if err := os.MkdirAll(staged, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staged, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	watcher, err := NewDirectoryWatcher(root, 3)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = watcher.Close() })
	published := filepath.Join(root, "RJ01234567")
	if err := os.Rename(staged, published); err != nil {
		t.Fatal(err)
	}
	waitForDirectoryChange(t, watcher.Changes())
	deadline := time.Now().Add(3 * time.Second)
	for watcher.WatchedDirectoryCount() < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if watcher.WatchedDirectoryCount() != 2 {
		t.Fatalf("watched directories after publish = %d, want 2", watcher.WatchedDirectoryCount())
	}
}

func waitForDirectoryChange(t *testing.T, changes <-chan struct{}) {
	t.Helper()
	select {
	case _, ok := <-changes:
		if !ok {
			t.Fatal("directory watcher closed before change")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for directory change")
	}
}
