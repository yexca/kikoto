package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/yexca/kikoto/backend/internal/metasync"
)

func (s *Server) runMetadataTagQueueWorker(ctx context.Context) {
	processor := metasync.NewMetadataTagQueueProcessor(s.db)
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		continueNow := false
		if !s.layoutMigrationActive.Load() {
			var err error
			continueNow, err = processor.ProcessBatch(ctx, s.instanceMetadataLanguages(ctx))
			if err != nil && !errors.Is(err, context.Canceled) {
				slog.Error("project queued metadata tags", "error", err)
			}
		}
		if continueNow {
			timer.Reset(0)
		} else {
			timer.Reset(2 * time.Second)
		}
	}
}
