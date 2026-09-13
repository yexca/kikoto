package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/outbound"
)

const sourceTransportCacheLimit = 64

type sourceTransportCache struct {
	mu      sync.Mutex
	entries map[string]sourceTransportEntry
}

type sourceTransportEntry struct {
	boundary string
	policy   *outbound.Policy
	base     http.RoundTripper
	usedAt   time.Time
}

func (cache *sourceTransportCache) load(source remoteSourceForUse) (*outbound.Policy, http.RoundTripper, error) {
	boundary, err := json.Marshal(struct {
		API, Base, Fallback string
		Restricted          bool
		Hosts               []string
	}{source.Endpoint.APIURL, source.Endpoint.BaseURL, source.Endpoint.FallbackURL, source.Endpoint.RestrictOutboundHosts, source.Endpoint.AllowedHostPatterns})
	if err != nil {
		return nil, nil, err
	}
	key := fmt.Sprintf("%d:%s", source.ID, source.Code)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if cache.entries == nil {
		cache.entries = make(map[string]sourceTransportEntry)
	}
	if entry, ok := cache.entries[key]; ok {
		if entry.boundary == string(boundary) {
			entry.usedAt = time.Now()
			cache.entries[key] = entry
			return entry.policy, entry.base, nil
		}
		closeSourceIdleConnections(entry.base)
		delete(cache.entries, key)
	}
	policy, err := sourceOutboundPolicy(source)
	if err != nil {
		return nil, nil, err
	}
	if len(cache.entries) >= sourceTransportCacheLimit {
		var oldestKey string
		var oldest time.Time
		for candidate, entry := range cache.entries {
			if oldest.IsZero() || entry.usedAt.Before(oldest) {
				oldestKey, oldest = candidate, entry.usedAt
			}
		}
		closeSourceIdleConnections(cache.entries[oldestKey].base)
		delete(cache.entries, oldestKey)
	}
	entry := sourceTransportEntry{boundary: string(boundary), policy: policy, base: policy.Transport(), usedAt: time.Now()}
	cache.entries[key] = entry
	return policy, entry.base, nil
}

func closeSourceIdleConnections(transport http.RoundTripper) {
	if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}
