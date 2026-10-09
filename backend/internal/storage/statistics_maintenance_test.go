package storage

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestStatisticsMaintenanceCoalescesChangesAndStopsOnCancellation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var passes atomic.Int32
		m := &StatisticsMaintainer{wake: make(chan struct{}, 1), settle: time.Second, cooldown: 30 * time.Second, budget: 5 * time.Second,
			optimize: func(context.Context) error { passes.Add(1); return nil }}
		done := make(chan struct{})
		go func() { m.Run(ctx, 24*time.Hour); close(done) }()
		synctest.Wait()
		for range 1000 {
			m.Request(ctx)
		}
		time.Sleep(time.Second)
		synctest.Wait()
		if got := passes.Load(); got != 2 {
			t.Fatalf("startup and burst passes=%d, want 2", got)
		}
		for range 1000 {
			m.Request(ctx)
		}
		time.Sleep(29 * time.Second)
		synctest.Wait()
		if got := passes.Load(); got != 2 {
			t.Fatalf("refresh storm: passes=%d", got)
		}
		time.Sleep(time.Second)
		synctest.Wait()
		if got := passes.Load(); got != 3 {
			t.Fatalf("follow-up passes=%d, want 3", got)
		}
		m.Request(ctx)
		cancel()
		<-done
		time.Sleep(time.Hour)
		if got := passes.Load(); got != 3 {
			t.Fatalf("pass after shutdown: %d", got)
		}
	})
}

func TestStatisticsMaintenanceRetriesFailedCommittedChange(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		var passes atomic.Int32
		m := &StatisticsMaintainer{wake: make(chan struct{}, 1), settle: time.Second, cooldown: 30 * time.Second, budget: 5 * time.Second,
			optimize: func(context.Context) error {
				if passes.Add(1) == 2 {
					return errors.New("synthetic busy writer")
				}
				return nil
			}}
		done := make(chan struct{})
		go func() { m.Run(ctx, 24*time.Hour); close(done) }()
		synctest.Wait()
		m.Request(ctx)
		time.Sleep(time.Second)
		synctest.Wait()
		if passes.Load() != 2 {
			t.Fatal("change was not refreshed")
		}
		time.Sleep(29 * time.Second)
		synctest.Wait()
		if passes.Load() != 2 {
			t.Fatal("failure bypassed cooldown")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		if passes.Load() != 3 {
			t.Fatal("failed change was lost until daily maintenance")
		}
		cancel()
		<-done
	})
}

func TestStatisticsMaintenanceBoundsActivePass(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		result := make(chan error, 1)
		m := &StatisticsMaintainer{wake: make(chan struct{}, 1), settle: time.Second, cooldown: 30 * time.Second, budget: 5 * time.Second,
			optimize: func(ctx context.Context) error { <-ctx.Done(); result <- ctx.Err(); return ctx.Err() }}
		done := make(chan struct{})
		go func() { m.Run(ctx, 24*time.Hour); close(done) }()
		time.Sleep(5 * time.Second)
		if err := <-result; err != context.DeadlineExceeded {
			t.Fatalf("pass error=%v", err)
		}
		cancel()
		<-done
	})
}
