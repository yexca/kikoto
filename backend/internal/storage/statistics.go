package storage

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"log/slog"
	"time"
)

const (
	// StatisticsMaintenancePeriod is how often MaintainStatistics refreshes
	// query planner statistics after its startup pass.
	StatisticsMaintenancePeriod = 24 * time.Hour
	// statisticsAnalysisLimit bounds the rows ANALYZE samples per index, as
	// the SQLite documentation recommends for PRAGMA optimize, so one pass
	// stays short even on a large library.
	statisticsAnalysisLimit = 400
)

// OptimizeStatistics refreshes query planner statistics for every table whose
// statistics are missing or stale. Mask 0x10002 checks all tables rather than
// only those this pooled connection has queried, so a table filled after the
// last pass, such as by a new install's first scan, is analyzed. A table
// whose size has not changed much is skipped, which keeps a pass cheap.
func OptimizeStatistics(ctx context.Context, db *sql.DB) (err error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := conn.Close(); err == nil {
			err = closeErr
		}
	}()
	var previousLimit int64
	if err := conn.QueryRowContext(ctx, `PRAGMA analysis_limit`).Scan(&previousLimit); err != nil {
		return err
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA analysis_limit = %d", statisticsAnalysisLimit)); err != nil {
		return err
	}
	// analysis_limit belongs to this connection. A connection whose limit
	// cannot be restored is discarded rather than returned to the pool.
	defer func() {
		if _, restoreErr := conn.ExecContext(context.Background(), fmt.Sprintf("PRAGMA analysis_limit = %d", previousLimit)); restoreErr != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	_, err = conn.ExecContext(ctx, `PRAGMA optimize = 0x10002`)
	return err
}

// MaintainStatistics refreshes query planner statistics once at startup and
// then every period until ctx is cancelled. Without statistics SQLite can
// choose a full scan over an index, which makes a new install's Library slow
// until someone compacts the database by hand.
func MaintainStatistics(ctx context.Context, db *sql.DB, period time.Duration) {
	ticker := time.NewTicker(period)
	defer ticker.Stop()
	for {
		if err := OptimizeStatistics(ctx, db); err != nil && ctx.Err() == nil {
			slog.Warn("refresh query planner statistics", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
