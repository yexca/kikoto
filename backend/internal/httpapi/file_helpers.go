package httpapi

import (
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
	tempPath := targetPath + ".tmp"
	target, err := os.Create(tempPath)
	if err != nil {
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

func isPathWithinRoot(root string, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
