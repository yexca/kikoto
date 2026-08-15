package httpapi

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// validateDestructivePath checks every existing component between a trusted
// storage root and a destructive target. Lexical containment alone is not
// enough because a parent symlink, junction, or reparse point can redirect an
// otherwise safe-looking path outside the configured storage root.
func validateDestructivePath(storageRoot string, relativePath string, allowMissingLeaf bool, wantDirectory bool) (string, error) {
	absRoot, err := filepath.Abs(storageRoot)
	if err != nil {
		return "", err
	}
	absTarget, err := safeDataPath(storageRoot, relativePath)
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(absRoot, absTarget)
	if err != nil {
		return "", err
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes configured storage root")
	}

	rootInfo, err := os.Lstat(absRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && allowMissingLeaf {
			return absTarget, nil
		}
		return "", err
	}
	if unsafeFetchStagingEntry(rootInfo) || !rootInfo.IsDir() {
		return "", fmt.Errorf("configured storage root is not a regular directory")
	}

	current := absRoot
	parts := strings.Split(relative, string(filepath.Separator))
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, statErr := os.Lstat(current)
		last := index == len(parts)-1
		if errors.Is(statErr, os.ErrNotExist) {
			if allowMissingLeaf {
				return absTarget, nil
			}
			return "", fmt.Errorf("destructive path component does not exist: %s", filepath.ToSlash(current))
		}
		if statErr != nil {
			return "", statErr
		}
		if unsafeFetchStagingEntry(info) {
			return "", fmt.Errorf("refusing to cross symbolic link or reparse point: %s", filepath.ToSlash(current))
		}
		if !last && !info.IsDir() {
			return "", fmt.Errorf("destructive path parent is not a directory: %s", filepath.ToSlash(current))
		}
		if last {
			if wantDirectory && !info.IsDir() {
				return "", fmt.Errorf("destructive target is not a directory: %s", filepath.ToSlash(current))
			}
			if !wantDirectory && info.IsDir() {
				return "", fmt.Errorf("refusing to delete directory: %s", filepath.ToSlash(current))
			}
		}
	}

	return absTarget, nil
}

func validateDestructiveDirectoryTree(storageRoot string, relativePath string) (string, error) {
	absRoot, err := validateDestructivePath(storageRoot, relativePath, true, true)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(absRoot); errors.Is(err, os.ErrNotExist) {
		return absRoot, nil
	} else if err != nil {
		return "", err
	}
	err = filepath.WalkDir(absRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if unsafeFetchStagingEntry(info) {
			return fmt.Errorf("refusing to traverse symbolic link or reparse point: %s", filepath.ToSlash(path))
		}
		if !entry.IsDir() {
			return fmt.Errorf("local work root still contains %s", filepath.ToSlash(path))
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return absRoot, nil
}

// removeDestructiveFile removes one regular file after checking every
// existing parent component. The second validation closes the common window
// where a caller validates a path and then unlinks it later.
func removeDestructiveFile(storageRoot string, relativePath string) (bool, int64, error) {
	target, err := validateDestructivePath(storageRoot, relativePath, true, false)
	if err != nil {
		return false, 0, err
	}
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, err
	}
	if unsafeFetchStagingEntry(info) {
		return false, 0, fmt.Errorf("refusing to delete symbolic link or reparse point: %s", filepath.ToSlash(relativePath))
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return false, 0, fmt.Errorf("refusing to delete non-regular file: %s", filepath.ToSlash(relativePath))
	}
	if _, err := validateDestructivePath(storageRoot, relativePath, true, false); err != nil {
		return false, 0, err
	}
	if err := os.Remove(target); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, info.Size(), nil
		}
		return false, 0, err
	}
	return true, info.Size(), nil
}

// removeDestructiveTree removes a validated directory tree. It refuses
// symlinks, reparse points, and special files before removing anything.
func removeDestructiveTree(storageRoot string, relativePath string) (bool, error) {
	absStorageRoot, err := filepath.Abs(storageRoot)
	if err != nil {
		return false, err
	}
	root, err := validateDestructivePath(storageRoot, relativePath, true, true)
	if err != nil {
		return false, err
	}
	rootInfo, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if unsafeFetchStagingEntry(rootInfo) || !rootInfo.IsDir() {
		return false, fmt.Errorf("refusing to delete unsafe directory: %s", filepath.ToSlash(relativePath))
	}

	type entry struct {
		path string
		dir  bool
	}
	entries := []entry{{path: root, dir: true}}
	if err := filepath.WalkDir(root, func(path string, item os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		info, err := item.Info()
		if err != nil {
			return err
		}
		if unsafeFetchStagingEntry(info) {
			return fmt.Errorf("refusing to traverse symbolic link or reparse point: %s", filepath.ToSlash(path))
		}
		if item.IsDir() {
			entries = append(entries, entry{path: path, dir: true})
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing to delete special file: %s", filepath.ToSlash(path))
		}
		entries = append(entries, entry{path: path})
		return nil
	}); err != nil {
		return false, err
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].dir != entries[j].dir {
			return !entries[i].dir
		}
		return len(entries[i].path) > len(entries[j].path)
	})
	for _, item := range entries {
		rel, err := filepath.Rel(absStorageRoot, item.path)
		if err != nil {
			return false, err
		}
		rel = filepath.ToSlash(rel)
		if _, err := validateDestructivePath(storageRoot, rel, false, item.dir); err != nil {
			return false, err
		}
		if err := os.Remove(item.path); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return false, err
		}
	}
	return true, nil
}
