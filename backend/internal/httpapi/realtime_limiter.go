package httpapi

import (
	"context"
	"sync"
	"time"
)

// realtimeLimiter bounds how many runs of one kind of FFmpeg or FFprobe work
// happen at once. A request that finds every slot taken waits in a bounded
// queue for at most its queue wait; a request that finds the queue full is
// refused at once. The limit can change while slots are held: a lower limit
// takes effect as held slots are released.
type realtimeLimiter struct {
	mu      sync.Mutex
	limit   int
	queue   int
	held    int
	waiting int
	// changed is closed and cleared whenever a slot frees or the limit changes.
	changed chan struct{}
}

func newRealtimeLimiter(limit int, queue int) *realtimeLimiter {
	return &realtimeLimiter{limit: limit, queue: queue}
}

func (limiter *realtimeLimiter) acquire(ctx context.Context, queueWait time.Duration) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	limiter.mu.Lock()
	if limiter.held < limiter.limit {
		limiter.held++
		limiter.mu.Unlock()
		return limiter.releaser(), nil
	}
	if limiter.waiting >= limiter.queue {
		limiter.mu.Unlock()
		return nil, errRealtimeResourceBusy
	}
	limiter.waiting++
	limiter.mu.Unlock()
	defer func() {
		limiter.mu.Lock()
		limiter.waiting--
		limiter.mu.Unlock()
	}()
	timer := time.NewTimer(queueWait)
	defer timer.Stop()
	for {
		limiter.mu.Lock()
		if limiter.held < limiter.limit {
			limiter.held++
			limiter.mu.Unlock()
			return limiter.releaser(), nil
		}
		if limiter.changed == nil {
			limiter.changed = make(chan struct{})
		}
		changed := limiter.changed
		limiter.mu.Unlock()
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			return nil, errRealtimeResourceBusy
		}
	}
}

func (limiter *realtimeLimiter) releaser() func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			limiter.mu.Lock()
			defer limiter.mu.Unlock()
			limiter.held--
			limiter.broadcastLocked()
		})
	}
}

func (limiter *realtimeLimiter) setLimit(limit int) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	limiter.limit = limit
	limiter.broadcastLocked()
}

func (limiter *realtimeLimiter) broadcastLocked() {
	if limiter.changed != nil {
		close(limiter.changed)
		limiter.changed = nil
	}
}
