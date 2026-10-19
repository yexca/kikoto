package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

const (
	editionIdentityLookupTimeout = 10 * time.Second
	editionIdentityResultTTL     = 6 * time.Hour
	editionIdentityFailureTTL    = 5 * time.Minute
	maxEditionIdentityResults    = 256
)

// errEditionIdentityUnverified means DLsite could not answer an edition
// identity question. Callers keep the remote work's own code; the provider
// failure is never reported as a failure of the remote source.
var errEditionIdentityUnverified = errors.New("edition identity could not be verified")

type editionIdentityResult struct {
	product   dlsite.Product
	noProduct bool
	expiresAt time.Time
}

// editionIdentityLookups remembers exact DLsite product answers used only for
// edition identity, so repeated source checks do not repeat provider requests.
// After a provider failure every identity lookup is skipped for a short period.
type editionIdentityLookups struct {
	mu               sync.Mutex
	results          map[string]editionIdentityResult
	unavailableUntil time.Time
}

// editionIdentityProduct requests one exact DLsite product for an edition
// identity check. It returns dlsite.ErrNoProduct for a product DLsite does not
// list and errEditionIdentityUnverified when DLsite fails, is slow, or is in
// its failure backoff. Only cancellation of ctx is returned as an error.
func (s *Server) editionIdentityProduct(ctx context.Context, code string) (dlsite.Product, error) {
	if errors.Is(ctx.Err(), context.Canceled) {
		return dlsite.Product{}, ctx.Err()
	}
	if ctx.Err() != nil {
		return dlsite.Product{}, errEditionIdentityUnverified
	}
	lookups := &s.editionIdentity
	now := time.Now()
	lookups.mu.Lock()
	if now.Before(lookups.unavailableUntil) {
		lookups.mu.Unlock()
		return dlsite.Product{}, errEditionIdentityUnverified
	}
	if cached, ok := lookups.results[code]; ok && now.Before(cached.expiresAt) {
		lookups.mu.Unlock()
		if cached.noProduct {
			return dlsite.Product{}, dlsite.ErrNoProduct
		}
		return cached.product, nil
	}
	lookups.mu.Unlock()

	lookupCtx, cancel := context.WithTimeout(ctx, editionIdentityLookupTimeout)
	product, err := s.dlsiteClient.FetchProduct(lookupCtx, code)
	cancel()
	if err != nil && errors.Is(ctx.Err(), context.Canceled) {
		return dlsite.Product{}, ctx.Err()
	}
	if err != nil && ctx.Err() != nil {
		// The caller's deadline ran out while DLsite answered slowly.
		slog.Warn("dlsite edition identity lookup exceeded its deadline", "work_code", code)
		return dlsite.Product{}, errEditionIdentityUnverified
	}
	noProduct := errors.Is(err, dlsite.ErrNoProduct)
	if err != nil && !noProduct {
		slog.Warn("dlsite edition identity lookup failed", "work_code", code, "error", err)
		lookups.mu.Lock()
		lookups.unavailableUntil = time.Now().Add(editionIdentityFailureTTL)
		lookups.mu.Unlock()
		return dlsite.Product{}, errEditionIdentityUnverified
	}
	// Identity checks read only codes, languages, and family fields.
	product.Raw, product.ProductRaw, product.DynamicRaw = nil, nil, nil
	lookups.mu.Lock()
	if lookups.results == nil || len(lookups.results) >= maxEditionIdentityResults {
		lookups.results = pruneEditionIdentityResults(lookups.results, now)
	}
	lookups.results[code] = editionIdentityResult{product: product, noProduct: noProduct, expiresAt: now.Add(editionIdentityResultTTL)}
	lookups.mu.Unlock()
	if noProduct {
		return dlsite.Product{}, dlsite.ErrNoProduct
	}
	return product, nil
}

func pruneEditionIdentityResults(results map[string]editionIdentityResult, now time.Time) map[string]editionIdentityResult {
	kept := make(map[string]editionIdentityResult, len(results))
	for code, result := range results {
		if now.Before(result.expiresAt) {
			kept[code] = result
		}
	}
	if len(kept) >= maxEditionIdentityResults {
		return map[string]editionIdentityResult{}
	}
	return kept
}
