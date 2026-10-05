package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/yexca/kikoto/backend/internal/metasync"
)

// Optional repairs run after core startup dispatch and snapshot projection.
// Each has its own lifetime-tracked task; a failed cache file or tag batch
// cannot prevent system workflows from starting, or block the other repair.
func (s *Server) startStartupMetadataRepairs() {
	s.startupRepairsOnce.Do(func() {
		for _, repair := range []struct {
			key string
			run func(context.Context) error
		}{
			{"startup_cover_migration", s.migrateFlatCoverCache},
			{"startup_metadata_tag_backfill", func(ctx context.Context) error {
				return metasync.BackfillMetadataTags(ctx, s.db, s.preferredMetadataLanguages(ctx))
			}},
		} {
			s.Go(func(ctx context.Context) {
				s.recordStartupRepair(ctx, repair.key, "running")
				status := "complete"
				if err := repair.run(ctx); err != nil {
					status = "failed"
					slog.Error("startup metadata repair failed", "repair", repair.key, "error", err)
				}
				recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer cancel()
				s.recordStartupRepair(recordCtx, repair.key, status)
			})
		}
	})
}

func (s *Server) recordStartupRepair(ctx context.Context, key, status string) {
	raw, err := json.Marshal(struct {
		Status    string `json:"status"`
		UpdatedAt string `json:"updatedAt"`
		Retry     bool   `json:"retryOnStartup"`
	}{status, time.Now().UTC().Format(time.RFC3339), status != "complete"})
	if err == nil {
		_, err = s.db.ExecContext(ctx, "INSERT INTO app_setting(key,value_json) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json", key, string(raw))
	}
	if err != nil {
		slog.Error("record startup metadata repair", "repair", key, "error", err)
	}
}
