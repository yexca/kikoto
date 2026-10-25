package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// Root-scoped operations preserve containment even if a directory changes
// after its no-follow check. Paths remain on the target's configured pool.
func (s *Server) openRemoteFetchPublishPaths(paths remoteFetchPublishPaths) (*os.Root, remoteFetchPublishPaths, error) {
	base, err := filepath.Abs(s.cfg.DataRoot)
	if err != nil {
		return nil, remoteFetchPublishPaths{}, err
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, remoteFetchPublishPaths{}, err
	}
	scoped := remoteFetchPublishPaths{}
	for _, item := range []struct {
		absolute    string
		destination *string
	}{
		{paths.stageRoot, &scoped.stageRoot}, {paths.targetRoot, &scoped.targetRoot}, {paths.backupRoot, &scoped.backupRoot},
	} {
		relative, err := filepath.Rel(base, item.absolute)
		if err == nil && (!filepath.IsLocal(relative) || relative == ".") {
			err = errors.New("fetch path escapes the data root")
		}
		if err == nil {
			err = validateFetchDirectoryPath(root, relative)
		}
		if err != nil {
			_ = root.Close()
			return nil, remoteFetchPublishPaths{}, err
		}
		*item.destination = relative
	}
	return root, scoped, nil
}

func validateFetchDirectoryPath(root *os.Root, relative string) error {
	current := "."
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := root.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if unsafeFetchStagingEntry(info) || !info.IsDir() {
			return errors.New("fetch path contains a symbolic link, reparse point or non-directory entry")
		}
	}
	return nil
}

func walkFetchDirectory(root *os.Root, directory string, visit func(string, fs.FileInfo) error) error {
	return fs.WalkDir(root.FS(), filepath.ToSlash(directory), func(name string, _ fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := root.Lstat(filepath.FromSlash(name))
		if err != nil {
			return err
		}
		if unsafeFetchStagingEntry(info) || !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("fetch directory contains a symbolic link, reparse point or unsupported file")
		}
		if visit != nil {
			return visit(filepath.FromSlash(name), info)
		}
		return nil
	})
}

func removeFetchDirectory(root *os.Root, directory string) error {
	if _, err := root.Lstat(directory); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if err := walkFetchDirectory(root, directory, nil); err != nil {
		return err
	}
	return root.RemoveAll(directory)
}

func (s *Server) removeRemoteFetchBackup(manifest remoteFetchManifestRecord) error {
	paths, err := s.remoteFetchPublishPaths(manifest)
	if err != nil {
		return err
	}
	root, scoped, err := s.openRemoteFetchPublishPaths(paths)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	return removeFetchDirectory(root, filepath.Dir(scoped.backupRoot))
}

func copyFetchDirectory(root *os.Root, source, target string) error {
	return walkFetchDirectory(root, source, func(name string, info fs.FileInfo) error {
		relative, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if info.IsDir() {
			return root.MkdirAll(destination, 0o755)
		}
		file, err := root.Open(name)
		if err != nil {
			return err
		}
		defer func() { _ = file.Close() }()
		return copyFetchFile(root, destination, file)
	})
}

func copyFetchFile(root *os.Root, targetPath string, source io.Reader) error {
	if err := validateFetchDirectoryPath(root, filepath.Dir(targetPath)); err != nil {
		return err
	}
	if err := root.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	tempPath := targetPath + ".tmp"
	if info, err := root.Lstat(tempPath); err == nil {
		if unsafeFetchStagingEntry(info) || !info.Mode().IsRegular() {
			return errors.New("fetch temporary file is not a regular file")
		}
		if err := root.Remove(tempPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	target, err := root.OpenFile(tempPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() { _ = root.Remove(tempPath) }()
	_, copyErr := io.CopyBuffer(writerOnly{target}, struct{ io.Reader }{source}, make([]byte, copyFileBufferBytes))
	closeErr := target.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	return root.Rename(tempPath, targetPath)
}

func (s *Server) openRemoteFetchSource(item remoteWorkSavePlanItem) (*os.File, error) {
	base, relative := s.cfg.CacheRoot, item.CachePath
	if item.Action == "copy_local" {
		base, relative = s.cfg.DataRoot, item.LocalSourcePath
	}
	if _, err := safeDataPath(base, relative); err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	return root.Open(filepath.FromSlash(relative))
}

func hashFetchFile(root *os.Root, name string) (string, int64, error) {
	file, err := root.Open(name)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, errors.New("fetch input is not a regular file")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	return hex.EncodeToString(hash.Sum(nil)), size, err
}
