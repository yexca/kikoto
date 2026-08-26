package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	transcodeCacheLimitSetting   = "transcode_cache_limit_gb"
	defaultTranscodeCacheLimitGB = 5
	transcodeCacheRootRelative   = "transcodes"
	transcodeCachePartialMaxAge  = 5 * time.Minute
)

type transcodeCacheOverview struct {
	Files      int    `json:"files"`
	Bytes      int64  `json:"bytes"`
	LimitBytes int64  `json:"limitBytes"`
	ScannedAt  string `json:"scannedAt"`
}

type transcodeCacheEntry struct {
	relPath  string
	size     int64
	modified time.Time
}

type transcodeCacheClearResult struct {
	DeletedFiles int   `json:"deletedFiles"`
	FreedBytes   int64 `json:"freedBytes"`
}

func (s *Server) transcodeCacheLimitBytes(ctx context.Context) int64 {
	limitGB := defaultTranscodeCacheLimitGB
	if s.db != nil {
		limitGB = s.settingIntContext(ctx, transcodeCacheLimitSetting, defaultTranscodeCacheLimitGB)
	}
	if limitGB < 1 {
		limitGB = defaultTranscodeCacheLimitGB
	}
	return int64(limitGB) << 30
}

func (s *Server) scanTranscodeCache(ctx context.Context) (transcodeCacheOverview, error) {
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	overview, _, err := s.scanTranscodeCacheUnlocked(ctx)
	return overview, err
}

func (s *Server) scanTranscodeCacheUnlocked(ctx context.Context) (transcodeCacheOverview, []transcodeCacheEntry, error) {
	scannedAt := time.Now()
	overview := transcodeCacheOverview{
		LimitBytes: s.transcodeCacheLimitBytes(ctx),
		ScannedAt:  scannedAt.UTC().Format(time.RFC3339),
	}
	cacheRoot, err := filepath.Abs(s.cfg.CacheRoot)
	if err != nil {
		return transcodeCacheOverview{}, nil, err
	}
	root := filepath.Join(cacheRoot, transcodeCacheRootRelative)
	if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
		return overview, []transcodeCacheEntry{}, nil
	} else if err != nil {
		return transcodeCacheOverview{}, nil, err
	}
	entries := []transcodeCacheEntry{}
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if unsafeFetchStagingEntry(info) {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.IsDir() || !info.Mode().IsRegular() {
			return nil
		}
		isSegment := strings.EqualFold(filepath.Ext(entry.Name()), ".ts")
		isStalePartial := strings.HasPrefix(entry.Name(), ".hls-segment-") &&
			strings.EqualFold(filepath.Ext(entry.Name()), ".part") &&
			scannedAt.Sub(info.ModTime()) >= transcodeCachePartialMaxAge
		if !isSegment && !isStalePartial {
			return nil
		}
		relPath, err := filepath.Rel(cacheRoot, path)
		if err != nil {
			return err
		}
		relPath = filepath.ToSlash(relPath)
		overview.Files++
		overview.Bytes += info.Size()
		entries = append(entries, transcodeCacheEntry{relPath: relPath, size: info.Size(), modified: info.ModTime()})
		return nil
	})
	return overview, entries, err
}

func (s *Server) enforceTranscodeCacheLimit(ctx context.Context, reservedBytes int64) (transcodeCacheOverview, error) {
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	s.transcodeCacheQuotaMu.Lock()
	defer s.transcodeCacheQuotaMu.Unlock()
	return s.trimTranscodeCacheLocked(ctx, reservedBytes)
}

func (s *Server) reserveTranscodeCache(ctx context.Context, bytes int64) (func(), error) {
	if bytes <= 0 {
		return func() {}, nil
	}
	s.transcodeCacheQuotaMu.Lock()
	_, err := s.trimTranscodeCacheLocked(ctx, bytes)
	if err != nil {
		s.transcodeCacheQuotaMu.Unlock()
		return nil, err
	}
	s.transcodeCacheReservedBytes += bytes
	s.transcodeCacheQuotaMu.Unlock()
	return func() {
		s.transcodeCacheQuotaMu.Lock()
		s.transcodeCacheReservedBytes -= bytes
		if s.transcodeCacheReservedBytes < 0 {
			s.transcodeCacheReservedBytes = 0
		}
		s.transcodeCacheQuotaMu.Unlock()
	}, nil
}

func (s *Server) trimTranscodeCacheLocked(ctx context.Context, additionalReservation int64) (transcodeCacheOverview, error) {
	overview, entries, err := s.scanTranscodeCacheUnlocked(ctx)
	if err != nil {
		return transcodeCacheOverview{}, err
	}
	targetBytes := overview.LimitBytes - s.transcodeCacheReservedBytes - additionalReservation
	if targetBytes < 0 {
		return overview, fmt.Errorf("transcode cache quota is smaller than one playback segment")
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].modified.Equal(entries[j].modified) {
			return entries[i].relPath < entries[j].relPath
		}
		return entries[i].modified.Before(entries[j].modified)
	})
	for _, entry := range entries {
		if overview.Bytes <= targetBytes {
			break
		}
		deleted, bytes, err := s.removeCacheFile(ctx, entry.relPath)
		if err != nil {
			return transcodeCacheOverview{}, err
		}
		if !deleted {
			continue
		}
		overview.Files--
		overview.Bytes -= bytes
	}
	if overview.Bytes > targetBytes {
		return overview, fmt.Errorf("transcode cache quota has no evictable space")
	}
	return overview, nil
}

func (s *Server) clearTranscodeCache(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	s.transcodeCacheActivityMu.Lock()
	defer s.transcodeCacheActivityMu.Unlock()
	s.transcodeCacheQuotaMu.Lock()
	defer s.transcodeCacheQuotaMu.Unlock()
	overview, _, err := s.scanTranscodeCacheUnlocked(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := removeDestructiveTree(s.cfg.CacheRoot, transcodeCacheRootRelative); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, transcodeCacheClearResult{DeletedFiles: overview.Files, FreedBytes: overview.Bytes})
}
