package httpapi

import (
	"fmt"
	"os"
	"sync"
	"time"
)

const (
	// mediaPreparationFailureTTL is how long a failed transcode or loudness
	// measurement is answered from memory. Repeated requests for a file FFmpeg
	// cannot read then return at once instead of occupying an encode slot.
	mediaPreparationFailureTTL = 30 * time.Second
	// mediaPreparationFailureLimit bounds the remembered failures.
	mediaPreparationFailureLimit = 256
)

// mediaPreparationFailures remembers recent FFmpeg failures by purpose and
// file revision. A changed file has a new revision and is tried again.
type mediaPreparationFailures struct {
	mu      sync.Mutex
	expires map[string]time.Time
}

func mediaPreparationFailureKey(purpose string, path string, info os.FileInfo) string {
	return fmt.Sprintf("%s\x00%s\x00%d\x00%d", purpose, path, info.Size(), info.ModTime().UnixNano())
}

// failedRecently reports whether key failed within the TTL.
func (failures *mediaPreparationFailures) failedRecently(key string) bool {
	failures.mu.Lock()
	defer failures.mu.Unlock()
	expires, ok := failures.expires[key]
	if ok && time.Now().Before(expires) {
		return true
	}
	if ok {
		delete(failures.expires, key)
	}
	return false
}

func (failures *mediaPreparationFailures) remember(key string) {
	now := time.Now()
	failures.mu.Lock()
	defer failures.mu.Unlock()
	if failures.expires == nil {
		failures.expires = map[string]time.Time{}
	}
	for existing, expires := range failures.expires {
		if !now.Before(expires) {
			delete(failures.expires, existing)
		}
	}
	for len(failures.expires) >= mediaPreparationFailureLimit {
		var oldestKey string
		var oldest time.Time
		for existing, expires := range failures.expires {
			if oldestKey == "" || expires.Before(oldest) {
				oldestKey, oldest = existing, expires
			}
		}
		delete(failures.expires, oldestKey)
	}
	failures.expires[key] = now.Add(mediaPreparationFailureTTL)
}
