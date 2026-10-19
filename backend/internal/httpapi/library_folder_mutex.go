package httpapi

import (
	"context"
	"sync"
)

// contextMutex is a mutual-exclusion lock whose waiters can give up when
// their context ends. Its zero value is an unlocked mutex.
type contextMutex struct {
	once sync.Once
	slot chan struct{}
}

func (m *contextMutex) ready() chan struct{} {
	m.once.Do(func() { m.slot = make(chan struct{}, 1) })
	return m.slot
}

// Lock waits without limit until the mutex is free.
func (m *contextMutex) Lock() {
	m.ready() <- struct{}{}
}

// LockContext waits until the mutex is free or ctx ends. It returns ctx's
// error, without holding the mutex, when ctx ends first.
func (m *contextMutex) LockContext(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	select {
	case m.ready() <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	// The lock and the cancellation can become ready together; a cancelled
	// caller never proceeds holding the lock.
	if err := ctx.Err(); err != nil {
		m.Unlock()
		return err
	}
	return nil
}

// TryLock takes the mutex only when it is free.
func (m *contextMutex) TryLock() bool {
	select {
	case m.ready() <- struct{}{}:
		return true
	default:
		return false
	}
}

func (m *contextMutex) Unlock() {
	select {
	case <-m.ready():
	default:
		panic("httpapi: unlock of unlocked contextMutex")
	}
}
