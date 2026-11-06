package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"
)

// occupyRealtimeResource takes every slot of a resource kind, and with
// fullQueue every queue place too, as running work would.
func occupyRealtimeResource(server *Server, kind realtimeResourceKind, fullQueue bool) {
	limiter := server.realtimeLimiterFor(context.Background(), kind)
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	limiter.held = limiter.limit
	if fullQueue {
		limiter.waiting = limiter.queue
	}
}

func TestRealtimeLimiterFollowsALimitChange(t *testing.T) {
	limiter := newRealtimeLimiter(2, 1)
	first, err := limiter.acquire(context.Background(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	second, err := limiter.acquire(context.Background(), time.Second)
	if err != nil {
		t.Fatal(err)
	}

	// A lower limit holds new work back until enough slots are released.
	limiter.setLimit(1)
	first()
	if _, err := limiter.acquire(context.Background(), 20*time.Millisecond); !errors.Is(err, errRealtimeResourceBusy) {
		t.Fatalf("acquire above the lowered limit = %v", err)
	}

	// A waiting request gets a slot as soon as the limit rises.
	acquired := make(chan error, 1)
	go func() {
		release, err := limiter.acquire(context.Background(), time.Minute)
		if err == nil {
			defer release()
		}
		acquired <- err
	}()
	for {
		limiter.mu.Lock()
		waiting := limiter.waiting
		limiter.mu.Unlock()
		if waiting == 1 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	// The queue holds one request, so another is refused at once.
	if _, err := limiter.acquire(context.Background(), time.Minute); !errors.Is(err, errRealtimeResourceBusy) {
		t.Fatalf("acquire with a full queue = %v", err)
	}
	limiter.setLimit(2)
	select {
	case err := <-acquired:
		if err != nil {
			t.Fatalf("waiting acquire = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("a raised limit did not wake the waiting request")
	}
	second()
	second()
	if limiter.held != 0 {
		t.Fatalf("held = %d after every release", limiter.held)
	}
}
