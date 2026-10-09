package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

const remoteBrowseCacheBytes = 16 << 20
const remoteBrowseCacheEntries = 32
const remoteBrowseCacheTTL = 30 * time.Second

type remoteBrowseCacheEntry struct {
	data        []byte
	expires     time.Time
	sortApplied bool
}

// Only upstream pages are retained. Personal tags, marks, availability and
// recommendation scores are read again on every request, including cache hits.
type remoteBrowsePageCache struct {
	mu      sync.Mutex
	entries map[string]remoteBrowseCacheEntry
	bytes   int
}

func remoteBrowsePageKey(source remoteSourceForUse, userID int64, request remoteSourceWorksRequest, upstreamPage int) string {
	request.Page = upstreamPage
	request.PageSize = 100
	data, _ := json.Marshal(struct {
		Source     remoteSourceForUse
		Generation uint64
		UserID     int64
		Request    remoteSourceWorksRequest
	}{source, source.cacheGeneration, userID, request})
	return fmt.Sprintf("%d:%x", source.ID, sha256.Sum256(data))
}

func (cache *remoteBrowsePageCache) page(ctx context.Context, key string, load func() (kikoeru.WorksPage, error)) (kikoeru.WorksPage, error) {
	if err := ctx.Err(); err != nil {
		return kikoeru.WorksPage{}, err
	}
	cache.mu.Lock()
	entry, found := cache.entries[key]
	cache.mu.Unlock()
	if found && time.Now().Before(entry.expires) {
		var page kikoeru.WorksPage
		if err := json.Unmarshal(entry.data, &page); err == nil {
			page.SortApplied = entry.sortApplied
			return page, nil
		}
	}
	page, err := load()
	if err != nil {
		return page, err
	}
	if err := ctx.Err(); err != nil {
		return kikoeru.WorksPage{}, err
	}
	data, err := json.Marshal(page)
	// Large valid pages still browse normally, but cannot displace the cache.
	if err != nil || len(data) > 2<<20 {
		return page, nil
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.entries == nil {
		cache.entries = make(map[string]remoteBrowseCacheEntry)
	}
	now := time.Now()
	for candidate, entry := range cache.entries {
		if candidate == key || !now.Before(entry.expires) {
			cache.bytes -= len(entry.data)
			delete(cache.entries, candidate)
		}
	}
	for len(cache.entries) >= remoteBrowseCacheEntries || cache.bytes+len(data) > remoteBrowseCacheBytes {
		var oldest string
		var expires time.Time
		for candidate, entry := range cache.entries {
			if expires.IsZero() || entry.expires.Before(expires) {
				oldest, expires = candidate, entry.expires
			}
		}
		cache.bytes -= len(cache.entries[oldest].data)
		delete(cache.entries, oldest)
	}
	cache.entries[key] = remoteBrowseCacheEntry{data: data, expires: now.Add(remoteBrowseCacheTTL), sortApplied: page.SortApplied}
	cache.bytes += len(data)
	return page, nil
}

func (s *Server) remoteBrowsePageLoader(ctx context.Context, userID int64, source remoteSourceForUse, request remoteSourceWorksRequest, client *kikoeru.Client) func(int) (kikoeru.WorksPage, error) {
	s.remoteWorkCacheMu.Lock()
	source.cacheGeneration = s.remoteWorkCacheGenerations[source.ID]
	s.remoteWorkCacheMu.Unlock()
	return func(page int) (kikoeru.WorksPage, error) {
		if err := s.validateRemoteCacheResult(ctx, source); err != nil {
			return kikoeru.WorksPage{}, err
		}
		result, err := s.remoteBrowseCache.page(ctx, remoteBrowsePageKey(source, userID, request, page), func() (kikoeru.WorksPage, error) {
			return client.ListWorksSortedSeeded(ctx, page, 100, request.Plan.PushdownQuery, request.UpstreamOrder, request.Direction, request.Seed)
		})
		if err == nil {
			err = s.validateRemoteCacheResult(ctx, source)
		}
		return result, err
	}
}
