package storage

import (
	"context"
	"database/sql"
	"log/slog"
	"time"
)

// StatisticsMaintainer merges committed bulk changes into a single bounded
// worker. Requests wait before borrowing a connection, never on a GET path.
type StatisticsMaintainer struct {
	wake                     chan struct{}
	optimize                 func(context.Context) error
	settle, cooldown, budget time.Duration
}

func NewStatisticsMaintainer(db *sql.DB) *StatisticsMaintainer {
	return &StatisticsMaintainer{
		wake:     make(chan struct{}, 1),
		optimize: func(ctx context.Context) error { return OptimizeStatistics(ctx, db) },
		settle:   time.Second, cooldown: 30 * time.Second, budget: 5 * time.Second,
	}
}

func (m *StatisticsMaintainer) Request(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

// Run has one owner for the database lifetime. The first post-startup change
// gets a pass after settle; later bursts get at most one pass per cooldown.
// The settle window does not reset, so continuous imports cannot starve it.
func (m *StatisticsMaintainer) Run(ctx context.Context, period time.Duration) {
	refresh := func() {
		passCtx, cancel := context.WithTimeout(ctx, m.budget)
		defer cancel()
		if err := m.optimize(passCtx); err != nil && ctx.Err() == nil {
			slog.Warn("refresh query planner statistics", "error", err)
			m.Request(ctx)
		}
	}
	if ctx.Err() != nil {
		return
	}
	refresh()
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	defer timer.Stop()
	var due <-chan time.Time
	var lastChangePass time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.wake:
			if due == nil {
				delay := max(m.settle, time.Until(lastChangePass.Add(m.cooldown)))
				timer.Reset(delay)
				due = timer.C
			}
		case <-due:
			due = nil
			refresh()
			lastChangePass = time.Now()
		case <-ticker.C:
			timer.Stop()
			due = nil
			refresh()
			lastChangePass = time.Now()
		}
	}
}
