package httpapi

import (
	"errors"
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

// linkedDataRoot returns a data root reached through a symbolic link to a real
// directory, as on hosts where the root or one of its parents is a link.
func linkedDataRoot(t *testing.T) (string, string) {
	t.Helper()
	realDir := filepath.Join(t.TempDir(), "real")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "data")
	if err := os.Symlink(realDir, link); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}
	return link, realDir
}

func TestSafeResolvedPathReadsFilesBelowLinkedDataRoot(t *testing.T) {
	root, _ := linkedDataRoot(t)
	relPath := "Library/track.mp3"
	if err := os.MkdirAll(filepath.Join(root, "Library"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(relPath)), []byte("synthetic audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The root's parent directory is a link as well as the root itself.
	parentLink := filepath.Join(t.TempDir(), "mount")
	if err := os.Symlink(filepath.Dir(root), parentLink); err != nil {
		t.Fatal(err)
	}
	for _, dataRoot := range []string{root, filepath.Join(parentLink, filepath.Base(root))} {
		path, err := safeResolvedPath(dataRoot, relPath)
		if err != nil {
			t.Fatalf("safeResolvedPath(%q) rejected a file inside the root: %v", dataRoot, err)
		}
		content, err := os.ReadFile(path)
		if err != nil || string(content) != "synthetic audio" {
			t.Fatalf("read resolved path = %q, %v", content, err)
		}
	}
}

func TestResolvePathWithinRootRejectsLinkLeavingLinkedRoot(t *testing.T) {
	root, realDir := linkedDataRoot(t)
	outside := filepath.Join(t.TempDir(), "secret.mp3")
	if err := os.WriteFile(outside, []byte("synthetic secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A sibling of the real root shares its path prefix without being inside it.
	sibling := realDir + "-other"
	if err := os.MkdirAll(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "outside.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(sibling, filepath.Join(root, "sibling")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"outside.mp3", "sibling"} {
		if _, err := resolvePathWithinRoot(root, filepath.Join(root, name)); !errors.Is(err, errPathEscapesRoot) {
			t.Fatalf("resolvePathWithinRoot(%s) error = %v, want errPathEscapesRoot", name, err)
		}
	}
	if _, err := safeResolvedPath(root, "outside.mp3"); err == nil {
		t.Fatal("safeResolvedPath accepted a link leaving a linked root")
	}
	if _, err := resolvePathWithinRoot(root, filepath.Join(root, "missing.mp3")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing candidate error = %v, want os.ErrNotExist", err)
	}
}

func TestRemoteFetchSourceRejectsSymlinkOutsideRoot(t *testing.T) {
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
	source, err := server.openRemoteFetchSource(remoteWorkSavePlanItem{
		Action:          "copy_local",
		LocalSourcePath: filepath.ToSlash(filepath.Join("Library", "track.mp3")),
	})
	if err == nil {
		_ = source.Close()
		t.Fatal("Fetch opened a source outside the root")
	}
}

// A missing file still resolves to a path, so its caller reports it missing,
// but never to one a link can redirect out of the root once its target
// appears.
func TestSafeResolvedPathKeepsMissingFilesInsideTheRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "Library"), 0o755); err != nil {
		t.Fatal(err)
	}
	path, err := safeResolvedPath(root, "Library/missing.mp3")
	if err != nil {
		t.Fatalf("missing file: %v", err)
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if !isPathWithinRoot(realRoot, path) || filepath.Base(path) != "missing.mp3" {
		t.Fatalf("missing file resolved to %q, want it inside %q", path, realRoot)
	}

	outside := t.TempDir()
	if err := os.Symlink(filepath.Join(outside, "later.mp3"), filepath.Join(root, "Library", "track.mp3")); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}
	if err := os.Symlink(filepath.Join(outside, "later"), filepath.Join(root, "Library", "Disc")); err != nil {
		t.Fatal(err)
	}
	for _, relPath := range []string{"Library/track.mp3", "Library/Disc/track.mp3"} {
		if path, err := safeResolvedPath(root, relPath); err == nil {
			t.Fatalf("dangling link %q resolved to %q", relPath, path)
		}
	}
}
