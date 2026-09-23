package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"time"
)

const (
	// databaseAutoCleanupInitialDelay lets startup recovery and startup
	// workflows settle before the first automatic pass.
	databaseAutoCleanupInitialDelay = 2 * time.Minute
	databaseAutoCleanupPeriod       = 24 * time.Hour
)

// databaseAutoCleanupTasks are the manual Database cleanup tasks that also run
// automatically. They only remove records with a fixed retention rule and do
// not depend on the data mount, so they are safe without an operator review.
var databaseAutoCleanupTasks = []string{
	databaseCleanupTaskExpiredSessions,
	databaseCleanupTaskOldRuns,
}

type databaseCleanupTaskRunner func(ctx context.Context, key string) (int, error)

// runAutomaticDatabaseCleanup applies the automatic cleanup tasks with the
// same retention rules as the manual Database cleanup. It records results in
// the server log rather than the audit log, because no user initiated it.
func (s *Server) runAutomaticDatabaseCleanup(ctx context.Context) {
	runDatabaseCleanupTasks(ctx, databaseAutoCleanupTasks, func(ctx context.Context, key string) (int, error) {
		var removed int
		err := withDatabaseBusyRetry(ctx, func() error {
			var err error
			removed, err = s.runDatabaseCleanupTask(ctx, key)
			return err
		})
		return removed, err
	})
}

// runDatabaseCleanupTasks runs every task even when an earlier one fails, so
// one busy table does not postpone the other retention rule for a whole period.
func runDatabaseCleanupTasks(ctx context.Context, tasks []string, run databaseCleanupTaskRunner) []databaseCleanupTaskResult {
	results := make([]databaseCleanupTaskResult, 0, len(tasks))
	for _, key := range tasks {
		if ctx.Err() != nil {
			return results
		}
		removed, err := run(ctx, key)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				slog.Error("automatic database cleanup failed", "task", key, "error", err)
			}
			continue
		}
		results = append(results, databaseCleanupTaskResult{Key: key, Removed: removed})
		if removed > 0 {
			slog.Info("automatic database cleanup", "task", key, "removed", removed)
		}
	}
	return results
}
