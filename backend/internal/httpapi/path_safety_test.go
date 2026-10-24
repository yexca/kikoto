package httpapi

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestSafeResolvedPathRejectsSymlinkOutsideRoot(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.mp3")
	if err := os.WriteFile(outside, []byte("synthetic secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "Library", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}
	if _, err := safeResolvedPath(root, filepath.ToSlash(filepath.Join("Library", "track.mp3"))); err == nil {
		t.Fatal("safeResolvedPath accepted a symlink outside the root")
	}
}

func TestRemoteFetchSourcePathRejectsSymlinkOutsideRoot(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.mp3")
	if err := os.WriteFile(outside, []byte("synthetic secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "Library", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}
	server := &Server{cfg: config.Config{DataRoot: root}}
	_, err := server.remoteFetchSourcePath(remoteWorkSavePlanItem{
		Action:          "copy_local",
		LocalSourcePath: filepath.ToSlash(filepath.Join("Library", "track.mp3")),
	})
	if err == nil {
		t.Fatal("remoteFetchSourcePath accepted a symlink outside the root")
	}
}
