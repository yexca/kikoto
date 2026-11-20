package auththrottle

import (
	"context"
	"testing"
	"time"
)

// Repeated failures on a key only slow it, up to a bound, and a success or
// a quiet period clears the delay.
func TestDelayerSlowsRepeatedFailuresWithoutRefusing(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	delayer := newDelayer(func() time.Time { return now }, DelayPolicy{
		FreeFailures: 2, BaseDelay: time.Second, MaxDelay: 4 * time.Second, ResetAfter: time.Hour,
	}, 2)
	want := []time.Duration{0, 0, time.Second, 2 * time.Second, 4 * time.Second, 4 * time.Second}
	for index, expected := range want {
		if got := delayer.Delay("account"); got != expected {
			t.Fatalf("delay after %d failures = %v, want %v", index, got, expected)
		}
		delayer.Fail("account")
	}
	delayer.Succeed("account")
	if got := delayer.Delay("account"); got != 0 {
		t.Fatalf("delay after a success = %v", got)
	}
	for range 5 {
		delayer.Fail("account")
	}
	now = now.Add(time.Hour)
	if got := delayer.Delay("account"); got != 0 {
		t.Fatalf("delay after the reset period = %v", got)
	}
	// The table stays bounded.
	for _, key := range []string{"a", "b", "c", "d"} {
		delayer.Fail(key)
	}
	if len(delayer.entries) > 2 {
		t.Fatalf("tracked keys = %d, want at most 2", len(delayer.entries))
	}
}

// Attempts on one key take turns, so parallel attempts cannot all wait out
// the same delay at once; another key is not held up.
func TestDelayerRunsOneAttemptPerKeyAtATime(t *testing.T) {
	delayer := NewDelayer(DelayPolicy{FreeFailures: 1, BaseDelay: time.Millisecond, MaxDelay: time.Millisecond, ResetAfter: time.Hour})
	ctx := context.Background()
	release, err := delayer.Acquire(ctx, "account")
	if err != nil {
		t.Fatal(err)
	}
	if other, err := delayer.Acquire(ctx, "other"); err != nil {
		t.Fatalf("another key waited: %v", err)
	} else {
		other()
	}
	waiting, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if _, err := delayer.Acquire(waiting, "account"); err == nil {
		t.Fatal("a second attempt on the key ran beside the first")
	}
	release()
	next, err := delayer.Acquire(ctx, "account")
	if err != nil {
		t.Fatalf("the next attempt after the first ended: %v", err)
	}
	next()
	if len(delayer.turns) != 0 {
		t.Fatalf("turns left behind = %d", len(delayer.turns))
	}
}
