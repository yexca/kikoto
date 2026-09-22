package httpapi

import (
	"context"
	"errors"
	"log/slog"
)

// execBestEffort runs a status or bookkeeping write whose failure must not
// change the caller's outcome. A failed write leaves the stored state at its
// previous value, so it is logged for diagnosis instead of silently dropped.
// Cancellation is expected when a request or job ends and is not logged.
func (s *Server) execBestEffort(ctx context.Context, operation string, query string, args ...any) {
	if _, err := s.db.ExecContext(ctx, query, args...); err != nil && !errors.Is(err, context.Canceled) {
		slog.Warn("best-effort database write failed", "operation", operation, "error", err)
	}
}
