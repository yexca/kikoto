package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Ranking history is kept in tiers. Every changed snapshot stays for the full
// retention; after it, one snapshot per day in Japan stays for the daily
// retention, the one in effect at the end of that day. A variant's latest
// snapshot, the snapshots of a finished annual list, and any snapshot an
// account last displayed are always kept.

const (
	rankingFullRetentionKey          = "ranking_full_retention_days"
	rankingDailyRetentionKey         = "ranking_daily_retention_days"
	rankingDefaultFullRetentionDays  = 30
	rankingDefaultDailyRetentionDays = 365
	rankingMaxFullRetentionDays      = 365
	rankingMaxDailyRetentionDays     = 10 * 365
)

type rankingRetention struct {
	FullDays int `json:"fullDays"`
	// DailyDays 0 keeps the daily snapshots forever.
	DailyDays int `json:"dailyDays"`
}

func (retention rankingRetention) validate() error {
	if retention.FullDays < 1 || retention.FullDays > rankingMaxFullRetentionDays {
		return fmt.Errorf("fullDays must be between 1 and %d", rankingMaxFullRetentionDays)
	}
	if retention.DailyDays != 0 && (retention.DailyDays < retention.FullDays || retention.DailyDays > rankingMaxDailyRetentionDays) {
		return fmt.Errorf("dailyDays must be 0 or between fullDays and %d", rankingMaxDailyRetentionDays)
	}
	return nil
}

func (s *Server) rankingRetentionSettings(ctx context.Context) rankingRetention {
	retention := rankingRetention{
		FullDays:  s.settingIntContext(ctx, rankingFullRetentionKey, rankingDefaultFullRetentionDays),
		DailyDays: s.settingIntContext(ctx, rankingDailyRetentionKey, rankingDefaultDailyRetentionDays),
	}
	if retention.validate() != nil {
		return rankingRetention{FullDays: rankingDefaultFullRetentionDays, DailyDays: rankingDefaultDailyRetentionDays}
	}
	return retention
}

// fullHistoryFrom is the earliest time whose every changed snapshot is kept.
func (retention rankingRetention) fullHistoryFrom(now time.Time) time.Time {
	return now.UTC().AddDate(0, 0, -retention.FullDays)
}

// removableRankingSnapshotsSQL selects the snapshots the retention removes. A
// snapshot's age is when the next snapshot of its variant replaced it, so a
// snapshot still in effect is never old.
const removableRankingSnapshotsSQL = `
	WITH ordered AS (
		SELECT snapshot.id, snapshot.ranking_variant_id, snapshot.pulled_at,
			LEAD(snapshot.pulled_at) OVER (
				PARTITION BY snapshot.ranking_variant_id ORDER BY snapshot.pulled_at, snapshot.id
			) AS replaced_at
		FROM ranking_snapshot AS snapshot
	)
	SELECT ordered.id FROM ordered
	INNER JOIN ranking_variant AS variant ON variant.id = ordered.ranking_variant_id
	INNER JOIN ranking_list AS list ON list.id = variant.ranking_list_id
	WHERE ordered.replaced_at IS NOT NULL
		AND ordered.replaced_at < ?
		AND list.final_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM user_ranking_state AS state WHERE state.seen_snapshot_id = ordered.id)
		AND (
			date(ordered.pulled_at, '+9 hours') = date(ordered.replaced_at, '+9 hours')
			OR (? AND ordered.replaced_at < ?)
		)
`

func (retention rankingRetention) removalArgs(now time.Time) []any {
	dailyCutoff := now.UTC()
	if retention.DailyDays > 0 {
		dailyCutoff = dailyCutoff.AddDate(0, 0, -retention.DailyDays)
	}
	return []any{formatWorkflowTimestamp(retention.fullHistoryFrom(now)), retention.DailyDays > 0, formatWorkflowTimestamp(dailyCutoff)}
}

func (s *Server) countOldRankingSnapshots(ctx context.Context, now time.Time) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ("+removableRankingSnapshotsSQL+")", s.rankingRetentionSettings(ctx).removalArgs(now)...).Scan(&count)
	return count, err
}

// cleanupOldRankingSnapshots removes the snapshots the retention no longer
// keeps, then the entries that no kept snapshot of their variant holds, so the
// history that remains keeps its titles and circles.
func (s *Server) cleanupOldRankingSnapshots(ctx context.Context, now time.Time) (int, error) {
	args := s.rankingRetentionSettings(ctx).removalArgs(now)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, "DELETE FROM ranking_snapshot WHERE id IN ("+removableRankingSnapshotsSQL+")", args...)
	if err != nil {
		return 0, err
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM ranking_entry
		WHERE NOT EXISTS (
			SELECT 1 FROM ranking_snapshot_item AS item
			INNER JOIN ranking_snapshot AS snapshot ON snapshot.id = item.snapshot_id
			WHERE snapshot.ranking_variant_id = ranking_entry.ranking_variant_id AND item.primary_code = ranking_entry.primary_code
		)
	`); err != nil {
		return 0, err
	}
	return int(removed), tx.Commit()
}

func (s *Server) updateRankingRetention(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	if s.rejectDemoRankingWrite(w) {
		return
	}
	var retention rankingRetention
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&retention); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := retention.validate(); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := saveSettingValueTx(r.Context(), tx, rankingFullRetentionKey, retention.FullDays); err != nil {
		writeError(w, err)
		return
	}
	if err := saveSettingValueTx(r.Context(), tx, rankingDailyRetentionKey, retention.DailyDays); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, retention)
}
