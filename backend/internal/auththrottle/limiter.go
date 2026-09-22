// Package auththrottle limits repeated failed credential attempts per key.
//
// An attempt is charged when it begins, so a burst of concurrent requests
// cannot all pass the check before the first failure is recorded. A failed
// attempt keeps its charge, a successful one may reset the key, and an attempt
// that ends without a credential decision is refunded.
package auththrottle

import (
	"sync"
	"time"
)

// Policy describes when one key locks and for how long.
type Policy struct {
	// MaxFailures is the number of failures tolerated before the key locks.
	MaxFailures int
	// BaseLockout is the first lockout; each later failure doubles it.
	BaseLockout time.Duration
	// MaxLockout caps the doubled lockout.
	MaxLockout time.Duration
	// ResetAfter forgets failures after this long without another failure.
	ResetAfter time.Duration
	// ResetOnSuccess clears the key's failures after a successful attempt.
	ResetOnSuccess bool
}

// Key names one throttled dimension of an attempt, such as a client address.
type Key struct {
	Name   string
	Policy Policy
}

const (
	defaultMaxEntries = 65536
	sweepInterval     = time.Minute
	// pendingRetryAfter is returned when a key is at its limit only because
	// other attempts are still in flight.
	pendingRetryAfter = time.Second
	// saturatedRetryAfter is returned when every tracked key is locked or in
	// flight and no room remains to track another key.
	saturatedRetryAfter = time.Minute
)

type Limiter struct {
	mu         sync.Mutex
	now        func() time.Time
	maxEntries int
	entries    map[string]*entry
	lastSweep  time.Time
}

type entry struct {
	policy      Policy
	failures    int
	pending     int
	lastFailure time.Time
	lockedUntil time.Time
}

func New() *Limiter {
	return newLimiter(time.Now, defaultMaxEntries)
}

func newLimiter(now func() time.Time, maxEntries int) *Limiter {
	return &Limiter{now: now, maxEntries: maxEntries, entries: map[string]*entry{}}
}

// Attempt is a charged credential attempt. Exactly one of Fail, Succeed, or
// Cancel should be called; later calls are ignored.
type Attempt struct {
	limiter *Limiter
	keys    []Key
	done    bool
}

// Begin charges an attempt against every key. When any key is locked it
// returns false and the longest remaining wait without charging any key.
func (l *Limiter) Begin(keys []Key) (*Attempt, time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.sweepLocked(now, false)

	var retryAfter time.Duration
	missing := 0
	for _, key := range keys {
		current, ok := l.entries[key.Name]
		if ok && current.expired(now) {
			delete(l.entries, key.Name)
			ok = false
		}
		if !ok {
			missing++
			continue
		}
		if wait := current.blockedFor(now); wait > retryAfter {
			retryAfter = wait
		}
	}
	if retryAfter > 0 {
		return nil, retryAfter, false
	}
	if missing > 0 && !l.makeRoomLocked(now, keys, missing) {
		return nil, saturatedRetryAfter, false
	}
	for _, key := range keys {
		current, ok := l.entries[key.Name]
		if !ok {
			current = &entry{policy: key.Policy}
			l.entries[key.Name] = current
		}
		current.pending++
	}
	return &Attempt{limiter: l, keys: keys}, 0, true
}

// Fail keeps the attempt's charge and locks every key that reached its limit.
func (a *Attempt) Fail() {
	a.finish(func(current *entry, now time.Time) {
		current.failures++
		current.lastFailure = now
		if over := current.failures - current.policy.MaxFailures; over >= 0 {
			current.lockedUntil = now.Add(current.policy.lockout(over))
		}
	})
}

// Succeed refunds the attempt and clears keys whose policy resets on success.
func (a *Attempt) Succeed() {
	a.finish(func(current *entry, _ time.Time) {
		if current.policy.ResetOnSuccess {
			current.failures = 0
			current.lockedUntil = time.Time{}
		}
	})
}

// Cancel refunds an attempt that ended without a credential decision.
func (a *Attempt) Cancel() {
	a.finish(func(*entry, time.Time) {})
}

func (a *Attempt) finish(apply func(*entry, time.Time)) {
	if a == nil {
		return
	}
	l := a.limiter
	l.mu.Lock()
	defer l.mu.Unlock()
	if a.done {
		return
	}
	a.done = true
	now := l.now()
	for _, key := range a.keys {
		current, ok := l.entries[key.Name]
		if !ok {
			continue
		}
		current.pending--
		apply(current, now)
		if current.expired(now) {
			delete(l.entries, key.Name)
		}
	}
}

func (e *entry) blockedFor(now time.Time) time.Duration {
	if now.Before(e.lockedUntil) {
		return e.lockedUntil.Sub(now)
	}
	// Up to MaxFailures attempts may be in flight together. Once the key has
	// locked before, only one probe runs at a time after the lock expires.
	if e.pending > 0 && e.failures+e.pending >= e.policy.MaxFailures {
		return pendingRetryAfter
	}
	return 0
}

func (e *entry) expired(now time.Time) bool {
	if e.pending > 0 || now.Before(e.lockedUntil) {
		return false
	}
	return e.failures == 0 || now.Sub(e.lastFailure) >= e.policy.ResetAfter
}

func (p Policy) lockout(over int) time.Duration {
	lockout := p.BaseLockout
	for ; over > 0 && lockout < p.MaxLockout; over-- {
		lockout *= 2
	}
	return min(lockout, p.MaxLockout)
}

func (l *Limiter) sweepLocked(now time.Time, force bool) {
	if !force && now.Sub(l.lastSweep) < sweepInterval {
		return
	}
	l.lastSweep = now
	for name, current := range l.entries {
		if current.expired(now) {
			delete(l.entries, name)
		}
	}
}

// makeRoomLocked keeps the table bounded when many distinct keys appear. It
// first drops expired keys, then evicts idle unlocked keys; it refuses only
// when every tracked key is locked or in flight.
func (l *Limiter) makeRoomLocked(now time.Time, keys []Key, needed int) bool {
	if len(l.entries)+needed <= l.maxEntries {
		return true
	}
	l.sweepLocked(now, true)
	requested := make(map[string]bool, len(keys))
	for _, key := range keys {
		requested[key.Name] = true
	}
	for name, current := range l.entries {
		if len(l.entries)+needed <= l.maxEntries {
			break
		}
		if !requested[name] && current.pending == 0 && !now.Before(current.lockedUntil) {
			delete(l.entries, name)
		}
	}
	return len(l.entries)+needed <= l.maxEntries
}
