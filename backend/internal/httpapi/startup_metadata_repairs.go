package httpapi

import (
	"context"
	"database/sql"
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
				if err := retireInstanceMetadataLanguage(ctx, s.db); err != nil {
					return err
				}
				return metasync.BackfillMetadataTags(ctx, s.db, s.instanceMetadataLanguages(ctx))
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

// retireInstanceMetadataLanguage removes the former instance default
// metadata language. Stored titles and tag names now always use the original
// language, so a database projected in another language is marked for the
// backfill that follows to project again.
func retireInstanceMetadataLanguage(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO app_setting(key,value_json)
 SELECT 'metadata_projection_pending','true'
 WHERE EXISTS(SELECT 1 FROM app_setting WHERE (key=? AND value_json<>'["origin"]') OR (key=? AND value_json<>'"origin"'))
 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`, dlsiteMetadataLanguagesSetting, dlsiteMetadataLanguageSetting); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM app_setting WHERE key IN (?,?)", dlsiteMetadataLanguagesSetting, dlsiteMetadataLanguageSetting); err != nil {
		return err
	}
	return tx.Commit()
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
