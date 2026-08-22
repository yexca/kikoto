package httpapi

import (
	"context"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

type cachePathLockEntry struct {
	gate chan struct{}
	refs int
}

// cachePathLocker serializes mutations to one final cache file while allowing
// unrelated cache files to proceed independently.
type cachePathLocker struct {
	mu      sync.Mutex
	entries map[string]*cachePathLockEntry
}

func (locker *cachePathLocker) acquire(ctx context.Context, key string) (func(), error) {
	locker.mu.Lock()
	if locker.entries == nil {
		locker.entries = map[string]*cachePathLockEntry{}
	}
	entry := locker.entries[key]
	if entry == nil {
		entry = &cachePathLockEntry{gate: make(chan struct{}, 1)}
		entry.gate <- struct{}{}
		locker.entries[key] = entry
	}
	entry.refs++
	locker.mu.Unlock()

	select {
	case <-entry.gate:
		var once sync.Once
		return func() {
			once.Do(func() {
				entry.gate <- struct{}{}
				locker.mu.Lock()
				entry.refs--
				if entry.refs == 0 {
					delete(locker.entries, key)
				}
				locker.mu.Unlock()
			})
		}, nil
	case <-ctx.Done():
		locker.mu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(locker.entries, key)
		}
		locker.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (s *Server) acquireCachePathLock(ctx context.Context, cachePath string) (func(), error) {
	targetPath, err := safeCachePath(s.cfg.CacheRoot, cachePath)
	if err != nil {
		return nil, err
	}
	key := filepath.Clean(targetPath)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return s.cachePathLocks.acquire(ctx, key)
}

func (s *Server) removeCacheFileUnlocked(relPath string) (bool, int64, error) {
	targetPath, err := validateDestructivePath(s.cfg.CacheRoot, relPath, true, false)
	if err != nil {
		return false, 0, err
	}
	deleted, bytes, err := removeDestructiveFile(s.cfg.CacheRoot, relPath)
	if err != nil || !deleted {
		return deleted, bytes, err
	}
	if err := pruneEmptyCacheParents(s.cfg.CacheRoot, filepath.Dir(targetPath)); err != nil {
		return false, bytes, err
	}
	return true, bytes, nil
}

func (s *Server) removeCacheFile(ctx context.Context, relPath string) (bool, int64, error) {
	release, err := s.acquireCachePathLock(ctx, relPath)
	if err != nil {
		return false, 0, err
	}
	defer release()
	return s.removeCacheFileUnlocked(relPath)
}
