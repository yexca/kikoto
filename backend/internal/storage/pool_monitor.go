package storage

import (
	"context"
	"database/sql"
	"log/slog"
	"time"
)

const (
	// PoolMonitorInterval is how often MonitorPool samples connection pool
	// statistics.
	PoolMonitorInterval = 10 * time.Second
	// A pool that stays fully checked out with new waiters for this many
	// consecutive samples is reported as saturated.
	poolSaturatedSamples = 3
	// Completed waits averaging at least this long are reported as contention.
	poolContendedAverageWait = time.Second
)

type poolCondition int

const (
	poolSteady poolCondition = iota
	poolContended
	poolSaturated
	poolRecovered
)

type poolReport struct {
	condition poolCondition
	stats     sql.DBStats
	// waits started and wait time completed since the previous sample.
	waits  int64
	waited time.Duration
}

// poolMonitor compares consecutive database/sql pool samples. WaitCount grows
// when a request starts waiting for a connection, while WaitDuration grows only
// when a wait ends, so a pool that stays full while WaitCount rises is stuck
// even though no completed wait has been recorded yet.
type poolMonitor struct {
	previous         sql.DBStats
	saturatedSamples int
	saturatedWaits   int64
	reported         bool
}

func (m *poolMonitor) observe(stats sql.DBStats) poolReport {
	report := poolReport{
		stats:  stats,
		waits:  stats.WaitCount - m.previous.WaitCount,
		waited: stats.WaitDuration - m.previous.WaitDuration,
	}
	m.previous = stats
	full := stats.MaxOpenConnections > 0 && stats.InUse >= stats.MaxOpenConnections
	if !full {
		wasReported := m.reported
		m.saturatedSamples, m.saturatedWaits, m.reported = 0, 0, false
		if wasReported {
			report.condition = poolRecovered
			return report
		}
	} else {
		m.saturatedSamples++
		m.saturatedWaits += report.waits
		if !m.reported && m.saturatedSamples >= poolSaturatedSamples && m.saturatedWaits > 0 {
			m.reported = true
			report.condition = poolSaturated
			return report
		}
	}
	if report.waits > 0 && report.waited >= poolContendedAverageWait*time.Duration(report.waits) {
		report.condition = poolContended
	}
	return report
}

func (r poolReport) log(logger *slog.Logger) {
	attributes := []any{
		"in_use", r.stats.InUse,
		"idle", r.stats.Idle,
		"max_open", r.stats.MaxOpenConnections,
		"new_waits", r.waits,
		"completed_wait", r.waited,
	}
	switch r.condition {
	case poolSaturated:
		logger.Error("database connection pool saturated; requests are waiting for a connection", attributes...)
	case poolRecovered:
		logger.Warn("database connection pool recovered from saturation", attributes...)
	case poolContended:
		logger.Warn("database connection pool contention", attributes...)
	}
}

// MonitorPool samples db's connection pool until ctx ends and logs sustained
// saturation, recovery, and slow connection waits.
func MonitorPool(ctx context.Context, db *sql.DB, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	monitor := poolMonitor{previous: db.Stats()}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			monitor.observe(db.Stats()).log(slog.Default())
		}
	}
}
