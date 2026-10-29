package httpapi

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// copyFileBufferBytes bounds each write of a staged copy. io.Copy between two
// files uses copy_file_range, which hands a whole file to the filesystem in one
// call; on Docker Desktop bind mounts that call blocks unrelated writes on the
// same share, including SQLite's WAL, until the entire file is copied.
const copyFileBufferBytes = 1 << 20

func copyFile(sourcePath string, targetPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()
	// A new, uniquely named temporary never replaces a file beside the target,
	// such as a user's own file named like it with a .tmp suffix.
	target, err := os.CreateTemp(filepath.Dir(targetPath), ".kikoto-copy-*.partial")
	if err != nil {
		return err
	}
	tempPath := target.Name()
	// CreateTemp makes the file private; the copy keeps the library's usual mode.
	if err := target.Chmod(0o644); err != nil {
		_ = target.Close()
		_ = os.Remove(tempPath)
		return err
	}
	// The wrappers hide ReadFrom and WriteTo so the copy stays chunked.
	if _, err := io.CopyBuffer(writerOnly{target}, struct{ io.Reader }{source}, make([]byte, copyFileBufferBytes)); err != nil {
		_ = target.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := target.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

var errPathEscapesRoot = errors.New("path escapes data root")

// resolvePathWithinRoot resolves every symbolic link in candidate and returns
// its real path when that path stays inside the real path of root. Both sides
// are resolved so that a root reached through a symbolic link, or one below a
// linked parent directory, still contains its own files. A candidate that does
// not exist returns the os.ErrNotExist error from resolving it.
func resolvePathWithinRoot(root string, candidate string) (string, error) {
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", err
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	realRoot, err := filepath.EvalSymlinks(absRoot)
	if err != nil {
		return "", err
	}
	if !isPathWithinRoot(realRoot, resolved) {
		return "", errPathEscapesRoot
	}
	return resolved, nil
}

// resolveMissingPathWithinRoot returns where candidate, which does not exist,
// would be: its deepest existing folder, resolved and checked like
// resolvePathWithinRoot, joined with the missing rest. A dangling link on the
// way is refused, so opening the result later cannot follow a link that
// leaves the root. The configured root is trusted, so when even it is missing
// the candidate is returned as it is.
func resolveMissingPathWithinRoot(root string, candidate string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if !isPathWithinRoot(absRoot, candidate) {
		return "", errPathEscapesRoot
	}
	missing := []string{}
	for directory := filepath.Clean(candidate); ; directory = filepath.Dir(directory) {
		if directory == absRoot {
			realRoot, err := filepath.EvalSymlinks(absRoot)
			if err != nil {
				return candidate, nil
			}
			return filepath.Join(append([]string{realRoot}, missing...)...), nil
		}
		resolved, err := resolvePathWithinRoot(root, directory)
		if err == nil {
			return filepath.Join(append([]string{resolved}, missing...)...), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		if _, err := os.Lstat(directory); err == nil {
			return "", errPathEscapesRoot
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		missing = append([]string{filepath.Base(directory)}, missing...)
	}
}

func isPathWithinRoot(root string, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
