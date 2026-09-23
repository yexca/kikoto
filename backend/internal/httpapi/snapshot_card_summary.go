package httpapi

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/yexca/kikoto/backend/internal/library"
)

// dlsiteCardSummary is the compact, versioned projection of a metadata
// snapshot that Library and voice cards read instead of decoding the complete
// snapshot. It holds exactly the parseDLsiteSnapshot fields those cards use.
// Change library.SnapshotCardSummaryVersion whenever these fields change.
type dlsiteCardSummary struct {
	Version          int      `json:"v"`
	Circle           string   `json:"circle,omitempty"`
	CircleExternalID string   `json:"circleId,omitempty"`
	BaseCode         string   `json:"baseCode,omitempty"`
	EditionCodes     []string `json:"editions,omitempty"`
	ReleaseDate      *string  `json:"releaseDate,omitempty"`
	RatingCount      *int64   `json:"ratingCount,omitempty"`
	Series           string   `json:"series,omitempty"`
	Tags             []string `json:"tags,omitempty"`
	VoiceActors      []string `json:"voiceActors,omitempty"`
}

func newDLsiteCardSummary(metadata dlsiteSnapshotMetadata) dlsiteCardSummary {
	summary := dlsiteCardSummary{
		Version: library.SnapshotCardSummaryVersion, Circle: metadata.Circle,
		CircleExternalID: metadata.CircleExternalID, BaseCode: metadata.BaseCode,
		ReleaseDate: metadata.ReleaseDate, RatingCount: metadata.RatingCount, Series: metadata.Series,
		Tags: metadata.Tags, VoiceActors: metadata.VoiceActors,
	}
	for _, edition := range metadata.LanguageEditions {
		summary.EditionCodes = append(summary.EditionCodes, edition.PrimaryCode)
	}
	return summary
}

// cardMetadata returns the card fields in parseDLsiteSnapshot's shape.
// Language editions carry only their codes.
func (summary dlsiteCardSummary) cardMetadata() dlsiteSnapshotMetadata {
	metadata := dlsiteSnapshotMetadata{
		Circle: summary.Circle, CircleExternalID: summary.CircleExternalID, BaseCode: summary.BaseCode,
		ReleaseDate: summary.ReleaseDate, RatingCount: summary.RatingCount, Series: summary.Series,
		Tags: summary.Tags, VoiceActors: summary.VoiceActors,
	}
	if metadata.Tags == nil {
		metadata.Tags = []string{}
	}
	if metadata.VoiceActors == nil {
		metadata.VoiceActors = []string{}
	}
	for _, code := range summary.EditionCodes {
		metadata.LanguageEditions = append(metadata.LanguageEditions, workTranslation{PrimaryCode: code})
	}
	return metadata
}

// dlsiteCardMetadata reads card metadata from a list row: the stored summary
// when present, otherwise the raw snapshot. A list query projects the raw
// snapshot only for rows whose summary is missing or has another version.
func dlsiteCardMetadata(summaryJSON string, snapshotJSON string) dlsiteSnapshotMetadata {
	if summaryJSON != "" {
		var summary dlsiteCardSummary
		if err := json.Unmarshal([]byte(summaryJSON), &summary); err == nil && summary.Version == library.SnapshotCardSummaryVersion {
			return summary.cardMetadata()
		}
	}
	return parseDLsiteSnapshot(snapshotJSON)
}

func encodeDLsiteCardSummary(snapshotJSON string) (string, error) {
	encoded, err := json.Marshal(newDLsiteCardSummary(parseDLsiteSnapshot(snapshotJSON)))
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// latestSnapshotCardColumnsAnyProviderSQL projects card_summary_json and
// snapshot_json for the latest snapshot of work.id from any provider.
var latestSnapshotCardColumnsAnyProviderSQL = library.LatestSnapshotCardColumnsSQL("work.id", false)

// snapshotCardSummaryBackfillBatch bounds each coordinator pass so the write
// transaction stays short while an upgraded library drains its queue.
const snapshotCardSummaryBackfillBatch = 200

type pendingSnapshotCardSummary struct {
	snapshotID int64
	snapshot   string
}

// backfillSnapshotCardSummaries writes card summaries for at most limit
// queued snapshots and returns how many it wrote. Summaries of another
// version are queued again first. A snapshot changed after it was read keeps
// its queue entry and is summarized on a later pass.
func (s *Server) backfillSnapshotCardSummaries(ctx context.Context, limit int) (int, error) {
	if limit <= 0 {
		return 0, nil
	}
	version := library.SnapshotCardSummaryVersion
	if err := withDatabaseBusyRetry(ctx, func() error {
		_, err := s.db.ExecContext(ctx, `
			INSERT INTO metadata_snapshot_card_summary_dirty (snapshot_id)
			SELECT summary.snapshot_id
			FROM metadata_snapshot_card_summary AS summary
			WHERE (summary.version < ? OR summary.version > ?)
				AND NOT EXISTS (
					SELECT 1 FROM metadata_snapshot_card_summary_dirty AS dirty
					WHERE dirty.snapshot_id = summary.snapshot_id
				)
		`, version, version)
		return err
	}); err != nil {
		return 0, fmt.Errorf("queue outdated snapshot card summaries: %w", err)
	}
	pending, err := s.loadPendingSnapshotCardSummaries(ctx, limit)
	if err != nil || len(pending) == 0 {
		return 0, err
	}
	summaries := make([]string, len(pending))
	for index, item := range pending {
		if summaries[index], err = encodeDLsiteCardSummary(item.snapshot); err != nil {
			return 0, fmt.Errorf("encode snapshot card summary: %w", err)
		}
	}
	written := 0
	err = withDatabaseBusyRetry(ctx, func() error {
		written = 0
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		for index, item := range pending {
			// The content comparison skips a snapshot rewritten since it was
			// read; the update trigger has already queued it again.
			result, err := tx.ExecContext(ctx, `
				INSERT INTO metadata_snapshot_card_summary (snapshot_id, version, summary_json)
				SELECT id, ?, ? FROM metadata_snapshot WHERE id = ? AND snapshot_json = ?
				ON CONFLICT(snapshot_id) DO UPDATE SET version = excluded.version, summary_json = excluded.summary_json
			`, version, summaries[index], item.snapshotID, item.snapshot)
			if err != nil {
				return err
			}
			if affected, err := result.RowsAffected(); err != nil {
				return err
			} else if affected == 0 {
				continue
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM metadata_snapshot_card_summary_dirty WHERE snapshot_id = ?`, item.snapshotID); err != nil {
				return err
			}
			written++
		}
		return tx.Commit()
	})
	if err != nil {
		return 0, fmt.Errorf("store snapshot card summaries: %w", err)
	}
	return written, nil
}

func (s *Server) loadPendingSnapshotCardSummaries(ctx context.Context, limit int) ([]pendingSnapshotCardSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT dirty.snapshot_id, snapshot.snapshot_json
		FROM metadata_snapshot_card_summary_dirty AS dirty
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.id = dirty.snapshot_id
		ORDER BY dirty.snapshot_id
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("load queued snapshot card summaries: %w", err)
	}
	defer func() { _ = rows.Close() }()
	pending := []pendingSnapshotCardSummary{}
	for rows.Next() {
		var item pendingSnapshotCardSummary
		if err := rows.Scan(&item.snapshotID, &item.snapshot); err != nil {
			return nil, err
		}
		pending = append(pending, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return pending, nil
}
