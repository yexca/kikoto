package auththrottle

import (
	"context"
	"sync"
	"time"
)

// DelayPolicy slows repeated failures on a key without ever refusing it.
type DelayPolicy struct {
	// FreeFailures is the number of failures answered without delay.
	FreeFailures int
	// BaseDelay is the first delay; each later failure doubles it.
	BaseDelay time.Duration
	// MaxDelay caps the doubled delay.
	MaxDelay time.Duration
	// ResetAfter forgets failures after this long without another failure.
	ResetAfter time.Duration
}

// Delayer counts failures per key and answers how long the next attempt on
// that key waits. Unlike a Limiter it never refuses an attempt, so a key
// shared by every client, such as a username, slows guessing without
// locking the key's owner out.
type Delayer struct {
	mu         sync.Mutex
	now        func() time.Time
	policy     DelayPolicy
	maxEntries int
	entries    map[string]*delayEntry
	turns      map[string]*keyTurn
}

// keyTurn lets one attempt on a key run at a time.
type keyTurn struct {
	slot chan struct{}
	refs int
}

type delayEntry struct {
	failures    int
	lastFailure time.Time
}

func NewDelayer(policy DelayPolicy) *Delayer {
	return newDelayer(time.Now, policy, defaultMaxEntries)
}

func newDelayer(now func() time.Time, policy DelayPolicy, maxEntries int) *Delayer {
	return &Delayer{now: now, policy: policy, maxEntries: maxEntries, entries: map[string]*delayEntry{}, turns: map[string]*keyTurn{}}
}

// Acquire waits until no other attempt on key is in flight, so attempts on
// one key run one at a time and each waits out its delay in turn: the delay
// bounds how many attempts a key takes, not only how long each one takes. It
// never refuses; it returns when ctx ends, and the returned release ends the
// turn.
func (d *Delayer) Acquire(ctx context.Context, key string) (func(), error) {
	d.mu.Lock()
	turn := d.turns[key]
	if turn == nil {
		turn = &keyTurn{slot: make(chan struct{}, 1)}
		d.turns[key] = turn
	}
	turn.refs++
	d.mu.Unlock()
	leave := func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if turn.refs--; turn.refs == 0 {
			delete(d.turns, key)
		}
	}
	select {
	case turn.slot <- struct{}{}:
	case <-ctx.Done():
		leave()
		return nil, ctx.Err()
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			<-turn.slot
			leave()
		})
	}, nil
}

// Delay is how long the next attempt on key waits before it is checked.
func (d *Delayer) Delay(key string) time.Duration {
	d.mu.Lock()
	defer d.mu.Unlock()
	current, ok := d.entries[key]
	if !ok {
		return 0
	}
	now := d.now()
	if now.Sub(current.lastFailure) >= d.policy.ResetAfter {
		delete(d.entries, key)
		return 0
	}
	over := current.failures - d.policy.FreeFailures
	if over < 0 {
		return 0
	}
	delay := d.policy.BaseDelay
	for ; over > 0 && delay < d.policy.MaxDelay; over-- {
		delay *= 2
	}
	return min(delay, d.policy.MaxDelay)
}

// Fail records a failed attempt on key.
func (d *Delayer) Fail(key string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := d.now()
	current, ok := d.entries[key]
	if ok && now.Sub(current.lastFailure) >= d.policy.ResetAfter {
		current.failures = 0
	}
	if !ok {
		if len(d.entries) >= d.maxEntries {
			d.evictLocked(now)
		}
		current = &delayEntry{}
		d.entries[key] = current
	}
	current.failures++
	current.lastFailure = now
}

// Succeed forgets the failures on key.
func (d *Delayer) Succeed(key string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.entries, key)
}

// evictLocked keeps the table bounded: it drops expired keys, then the key
// whose last failure is oldest.
func (d *Delayer) evictLocked(now time.Time) {
	oldest := ""
	for name, current := range d.entries {
		if now.Sub(current.lastFailure) >= d.policy.ResetAfter {
			delete(d.entries, name)
			continue
		}
		if oldest == "" || current.lastFailure.Before(d.entries[oldest].lastFailure) {
			oldest = name
		}
	}
	if len(d.entries) >= d.maxEntries && oldest != "" {
		delete(d.entries, oldest)
	}
}
