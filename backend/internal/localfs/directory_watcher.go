package localfs

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fsnotify/fsnotify"
)

const (
	directoryWatcherEventBuffer = 4096
	fetchRootMarkerMaxBytes     = 4096
)

// FetchRootMarkerName and FetchRootMarkerVersion define the ownership marker
// for a directory managed by Kikoto's remote Fetch workflow. Marked trees are
// registered directly by Fetch and must not enqueue the general local-library
// scan for their own file changes.
const (
	FetchRootMarkerName    = ".kikoto-fetch-root"
	FetchRootMarkerVersion = 1
)

type DirectoryWatcher struct {
	watcher     *fsnotify.Watcher
	root        string
	scanDepth   int
	changes     chan struct{}
	invalidated chan struct{}
	errors      chan error
	done        chan struct{}
	closeOnce   sync.Once
	mu          sync.RWMutex
	watched     map[string]struct{}
	excluded    map[string]struct{}
}

func NewDirectoryWatcher(root string, scanDepth int, excludedRoots ...string) (*DirectoryWatcher, error) {
	if scanDepth <= 0 {
		scanDepth = 2
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(absRoot)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, &fs.PathError{Op: "watch", Path: absRoot, Err: errors.New("not a directory")}
	}
	watcher, err := fsnotify.NewBufferedWatcher(directoryWatcherEventBuffer)
	if err != nil {
		return nil, err
	}
	result := &DirectoryWatcher{
		watcher: watcher, root: filepath.Clean(absRoot), scanDepth: scanDepth,
		changes: make(chan struct{}, 1), invalidated: make(chan struct{}, 1), errors: make(chan error, 8),
		done: make(chan struct{}), watched: map[string]struct{}{}, excluded: map[string]struct{}{},
	}
	for _, excludedRoot := range excludedRoots {
		if err := result.addExcludedRoot(excludedRoot); err != nil {
			_ = watcher.Close()
			return nil, err
		}
	}
	if err := result.addTree(result.root); err != nil {
		_ = watcher.Close()
		return nil, err
	}
	go result.run()
	return result, nil
}

func (w *DirectoryWatcher) Changes() <-chan struct{} {
	return w.changes
}

func (w *DirectoryWatcher) Invalidated() <-chan struct{} {
	return w.invalidated
}

func (w *DirectoryWatcher) Errors() <-chan error {
	return w.errors
}

func (w *DirectoryWatcher) WatchedDirectoryCount() int {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return len(w.watched)
}

func (w *DirectoryWatcher) Close() error {
	var closeErr error
	w.closeOnce.Do(func() {
		closeErr = w.watcher.Close()
		<-w.done
	})
	return closeErr
}

func (w *DirectoryWatcher) run() {
	defer close(w.done)
	defer close(w.changes)
	defer close(w.invalidated)
	defer close(w.errors)
	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.processEvent(event)
		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			w.emitError(err)
		}
	}
}

func (w *DirectoryWatcher) processEvent(event fsnotify.Event) {
	path := filepath.Clean(event.Name)
	if strings.EqualFold(filepath.Base(path), FetchRootMarkerName) && event.Has(fsnotify.Create|fsnotify.Write|fsnotify.Rename) && fetchRootMarkerExists(filepath.Dir(path)) {
		root := filepath.Dir(path)
		if err := w.addExcludedRoot(root); err != nil {
			w.emitError(err)
			return
		}
		w.removeTree(root)
		return
	}
	if w.isInternalPath(path) {
		return
	}
	if sameFilesystemPath(path, w.root) && event.Has(fsnotify.Remove|fsnotify.Rename) {
		select {
		case w.invalidated <- struct{}{}:
		default:
		}
		return
	}
	if event.Has(fsnotify.Create) {
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			if err := w.addTree(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
				w.emitError(err)
			}
		}
	}
	if event.Has(fsnotify.Remove | fsnotify.Rename) {
		w.removeTree(path)
	}
	if event.Has(fsnotify.Create | fsnotify.Write | fsnotify.Remove | fsnotify.Rename) {
		select {
		case w.changes <- struct{}{}:
		default:
		}
	}
}

func (w *DirectoryWatcher) addTree(start string) error {
	return filepath.WalkDir(start, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		if w.isInternalPath(path) {
			return filepath.SkipDir
		}
		if !sameFilesystemPath(path, w.root) && fetchRootMarkerExists(path) {
			if err := w.addExcludedRoot(path); err != nil {
				return err
			}
			return filepath.SkipDir
		}
		depth, _, err := relativeDepth(w.root, path)
		if err != nil {
			return err
		}
		if depth > w.scanDepth {
			return filepath.SkipDir
		}
		cleanPath := filepath.Clean(path)
		w.mu.RLock()
		_, exists := w.watched[cleanPath]
		w.mu.RUnlock()
		if exists {
			return nil
		}
		if err := w.watcher.Add(cleanPath); err != nil {
			return err
		}
		w.mu.Lock()
		w.watched[cleanPath] = struct{}{}
		w.mu.Unlock()
		return nil
	})
}

func (w *DirectoryWatcher) removeTree(root string) {
	w.mu.Lock()
	paths := make([]string, 0)
	for path := range w.watched {
		if isAncestorOrSame(root, path) {
			paths = append(paths, path)
			delete(w.watched, path)
		}
	}
	w.mu.Unlock()
	for _, path := range paths {
		_ = w.watcher.Remove(path)
	}
}

func (w *DirectoryWatcher) isInternalPath(path string) bool {
	rel, err := filepath.Rel(w.root, path)
	if err != nil || rel == "." {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return true
	}
	for root := range w.excluded {
		if isAncestorOrSame(root, path) {
			return true
		}
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if isKikotoInternalDirectory(part) {
			return true
		}
	}
	return false
}

func (w *DirectoryWatcher) addExcludedRoot(path string) error {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(w.root, path)
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	absPath = filepath.Clean(absPath)
	if sameFilesystemPath(absPath, w.root) || !isAncestorOrSame(w.root, absPath) {
		return &fs.PathError{Op: "exclude", Path: absPath, Err: errors.New("path must be below the watch root")}
	}
	w.excluded[absPath] = struct{}{}
	return nil
}

func fetchRootMarkerExists(root string) bool {
	path := filepath.Join(root, FetchRootMarkerName)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > fetchRootMarkerMaxBytes {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, fetchRootMarkerMaxBytes+1))
	if err != nil || len(data) > fetchRootMarkerMaxBytes {
		return false
	}
	var marker struct {
		Version    int    `json:"version"`
		ManagedBy  string `json:"managed_by"`
		Purpose    string `json:"purpose"`
		SourceCode string `json:"source_code"`
	}
	if json.Unmarshal(data, &marker) != nil {
		return false
	}
	return marker.Version == FetchRootMarkerVersion && marker.ManagedBy == "kikoto" && marker.Purpose == "remote_fetch" && strings.TrimSpace(marker.SourceCode) != ""
}

func (w *DirectoryWatcher) emitError(err error) {
	select {
	case w.errors <- err:
	default:
	}
}

func sameFilesystemPath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}
