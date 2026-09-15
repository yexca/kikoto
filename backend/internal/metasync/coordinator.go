package metasync

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// Coordinator is shared by all syncers belonging to one application instance.
// Unrelated work families do not wait for a whole-library synchronization.
type Coordinator struct {
	mu       sync.Mutex
	families map[string]*familyCall
	products map[string]*productGate
}

type familyCall struct {
	requested string
	profile   string
	done      chan struct{}
	result    DLsiteFamilySyncResult
	err       error
}

type productGate struct {
	token chan struct{}
	users int
}

func NewCoordinator() *Coordinator {
	return &Coordinator{families: map[string]*familyCall{}, products: map[string]*productGate{}}
}

func (c *Coordinator) IsRunning(familyCode string) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.families[familyCode] != nil
}

func (s *DLsiteSyncer) WithCoordinator(coordinator *Coordinator) *DLsiteSyncer {
	if coordinator != nil {
		s.coordinator = coordinator
	}
	return s
}

func (s *DLsiteSyncer) SyncFamily(ctx context.Context, requestedCode string) (DLsiteFamilySyncResult, error) {
	requestedCode = strings.ToUpper(strings.TrimSpace(requestedCode))
	profile := strings.Join(s.languages, "\x00") + "\x01" + strings.Join(s.metadataPriority, "\x00") + "\x01" + s.cacheRoot
	key := requestedCode
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(NULLIF(logical.canonical_code, ''), work.primary_code)
		FROM work LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE work.primary_code = ?`, requestedCode).Scan(&key)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return DLsiteFamilySyncResult{}, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return DLsiteFamilySyncResult{}, err
		}
		s.coordinator.mu.Lock()
		active := s.coordinator.families[key]
		if active != nil {
			s.coordinator.mu.Unlock()
			select {
			case <-ctx.Done():
				return DLsiteFamilySyncResult{}, ctx.Err()
			case <-active.done:
			}
			// A different edition may need a different requested-product outcome.
			// Serialize it, while identical requests reuse the in-flight result.
			if active.requested != requestedCode || active.profile != profile || errors.Is(active.err, context.Canceled) || errors.Is(active.err, context.DeadlineExceeded) {
				continue
			}
			if err := s.linkAttemptRun(ctx, active.result.attempt); err != nil {
				return DLsiteFamilySyncResult{}, err
			}
			return cloneFamilyResult(active.result), active.err
		}
		active = &familyCall{requested: requestedCode, profile: profile, done: make(chan struct{})}
		s.coordinator.families[key] = active
		s.coordinator.mu.Unlock()

		attemptCtx, beginErr := s.beginAttempt(ctx)
		if beginErr != nil {
			active.err = beginErr
		} else {
			active.result, active.err = s.syncFamily(attemptCtx, requestedCode)
			if ctx.Err() != nil {
				active.err = ctx.Err()
			}
			active.result.attempt = attemptID(attemptCtx)
		}
		s.coordinator.mu.Lock()
		delete(s.coordinator.families, key)
		close(active.done)
		s.coordinator.mu.Unlock()
		return cloneFamilyResult(active.result), active.err
	}
}

func cloneFamilyResult(result DLsiteFamilySyncResult) DLsiteFamilySyncResult {
	result.Codes = append([]string{}, result.Codes...)
	result.SyncedCodes = append([]string{}, result.SyncedCodes...)
	result.SkippedCodes = append([]string{}, result.SkippedCodes...)
	result.Failures = append([]string{}, result.Failures...)
	return result
}

func (c *Coordinator) acquireProduct(ctx context.Context, code string) (func(), error) {
	c.mu.Lock()
	gate := c.products[code]
	if gate == nil {
		gate = &productGate{token: make(chan struct{}, 1)}
		gate.token <- struct{}{}
		c.products[code] = gate
	}
	gate.users++
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		gate.users--
		if gate.users == 0 {
			delete(c.products, code)
		}
		c.mu.Unlock()
	}
	select {
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	case <-gate.token:
		return func() { gate.token <- struct{}{}; forget() }, nil
	}
}

func (s *DLsiteSyncer) syncFetchedProduct(ctx context.Context, code string, fetch func(context.Context, string) (dlsite.Product, error)) (dlsite.Product, int64, error) {
	release, err := s.coordinator.acquireProduct(ctx, code)
	if err != nil {
		return dlsite.Product{}, 0, err
	}
	defer release()
	ctx, err = s.beginAttempt(ctx)
	if err != nil {
		return dlsite.Product{}, 0, err
	}
	product, fetchErr := fetch(ctx, code)
	if fetchErr != nil {
		if err := s.recordCodeOutcome(ctx, code, "metadata", fetchErr); err != nil {
			return dlsite.Product{}, 0, err
		}
		return dlsite.Product{}, 0, fetchErr
	}
	workID, err := s.ensureWorkForProduct(ctx, product)
	if err == nil {
		err = s.applyProduct(ctx, workID, product)
	}
	if err != nil {
		if stateErr := s.recordCodeOutcome(ctx, code, "metadata", err); stateErr != nil {
			return product, workID, stateErr
		}
	}
	return product, workID, err
}
