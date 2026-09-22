package auththrottle

import (
	"testing"
	"time"
)

type fakeClock struct{ now time.Time }

func (c *fakeClock) Now() time.Time          { return c.now }
func (c *fakeClock) Advance(d time.Duration) { c.now = c.now.Add(d) }

var testPolicy = Policy{
	MaxFailures: 3, BaseLockout: time.Minute, MaxLockout: 4 * time.Minute,
	ResetAfter: time.Hour, ResetOnSuccess: true,
}

func newTestLimiter(maxEntries int) (*Limiter, *fakeClock) {
	clock := &fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	return newLimiter(clock.Now, maxEntries), clock
}

func mustBegin(t *testing.T, limiter *Limiter, keys []Key) *Attempt {
	t.Helper()
	attempt, retryAfter, ok := limiter.Begin(keys)
	if !ok {
		t.Fatalf("Begin() rejected with retryAfter %v, want allowed", retryAfter)
	}
	return attempt
}

func expectBlocked(t *testing.T, limiter *Limiter, keys []Key, want time.Duration) {
	t.Helper()
	if _, retryAfter, ok := limiter.Begin(keys); ok || retryAfter != want {
		t.Fatalf("Begin() = allowed %v retryAfter %v, want blocked for %v", ok, retryAfter, want)
	}
}

func TestLimiterLocksAfterMaxFailuresAndDoublesRepeatedLockouts(t *testing.T) {
	limiter, clock := newTestLimiter(defaultMaxEntries)
	keys := []Key{{Name: "client", Policy: testPolicy}}

	for range 3 {
		mustBegin(t, limiter, keys).Fail()
	}
	expectBlocked(t, limiter, keys, time.Minute)

	clock.Advance(time.Minute)
	mustBegin(t, limiter, keys).Fail()
	expectBlocked(t, limiter, keys, 2*time.Minute)

	clock.Advance(2 * time.Minute)
	mustBegin(t, limiter, keys).Fail()
	clock.Advance(4 * time.Minute)
	mustBegin(t, limiter, keys).Fail()
	expectBlocked(t, limiter, keys, 4*time.Minute)
}

func TestLimiterChargesInFlightAttemptsBeforeTheyFail(t *testing.T) {
	limiter, clock := newTestLimiter(defaultMaxEntries)
	keys := []Key{{Name: "client", Policy: testPolicy}}

	inFlight := []*Attempt{mustBegin(t, limiter, keys), mustBegin(t, limiter, keys), mustBegin(t, limiter, keys)}
	expectBlocked(t, limiter, keys, pendingRetryAfter)

	inFlight[0].Cancel()
	inFlight[1].Fail()
	inFlight[2].Fail()
	mustBegin(t, limiter, keys).Fail()
	expectBlocked(t, limiter, keys, time.Minute)

	// After a lockout expires only one probe may run at a time.
	clock.Advance(time.Minute)
	probe := mustBegin(t, limiter, keys)
	expectBlocked(t, limiter, keys, pendingRetryAfter)
	probe.Fail()
	expectBlocked(t, limiter, keys, 2*time.Minute)
}

func TestLimiterSuccessResetsOnlyKeysThatAllowIt(t *testing.T) {
	limiter, _ := newTestLimiter(defaultMaxEntries)
	account := Key{Name: "account", Policy: testPolicy}
	clientPolicy := testPolicy
	clientPolicy.ResetOnSuccess = false
	client := Key{Name: "client", Policy: clientPolicy}
	keys := []Key{account, client}

	mustBegin(t, limiter, keys).Fail()
	mustBegin(t, limiter, keys).Fail()
	mustBegin(t, limiter, keys).Succeed()
	mustBegin(t, limiter, []Key{account}).Fail()
	mustBegin(t, limiter, []Key{account}).Fail()
	mustBegin(t, limiter, []Key{account}) // account has two failures, still open

	mustBegin(t, limiter, []Key{client}).Fail()
	expectBlocked(t, limiter, []Key{client}, time.Minute)
	expectBlocked(t, limiter, keys, time.Minute)
}

func TestLimiterForgetsFailuresAfterResetWindow(t *testing.T) {
	limiter, clock := newTestLimiter(defaultMaxEntries)
	keys := []Key{{Name: "client", Policy: testPolicy}}

	for range 3 {
		mustBegin(t, limiter, keys).Fail()
	}
	clock.Advance(time.Hour)
	for range 2 {
		mustBegin(t, limiter, keys).Fail()
	}
	mustBegin(t, limiter, keys)
}

func TestLimiterBoundsTrackedKeysWithoutReleasingLockedKeys(t *testing.T) {
	limiter, _ := newTestLimiter(2)
	locked := []Key{{Name: "locked", Policy: testPolicy}}
	for range 3 {
		mustBegin(t, limiter, locked).Fail()
	}
	mustBegin(t, limiter, []Key{{Name: "idle", Policy: testPolicy}}).Fail()

	// The idle key is evicted to track a new key; the locked key is kept.
	mustBegin(t, limiter, []Key{{Name: "new", Policy: testPolicy}}).Fail()
	if len(limiter.entries) != 2 {
		t.Fatalf("tracked keys = %d, want 2", len(limiter.entries))
	}
	expectBlocked(t, limiter, locked, time.Minute)

	// With every tracked key locked or in flight, an untracked key is refused.
	mustBegin(t, limiter, []Key{{Name: "new", Policy: testPolicy}})
	expectBlocked(t, limiter, []Key{{Name: "another", Policy: testPolicy}}, saturatedRetryAfter)
}
