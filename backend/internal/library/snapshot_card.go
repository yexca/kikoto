package library

import "strconv"

// SnapshotCardSummaryVersion identifies the format of
// metadata_snapshot_card_summary.summary_json. Readers ignore a summary with
// another version and fall back to the raw snapshot, and the summary backfill
// rewrites it. Increase it whenever the stored summary fields change.
const SnapshotCardSummaryVersion = 1

// LatestSnapshotCardColumnsSQL projects the card metadata of the latest
// metadata snapshot for workIDExpression as two columns:
//
//   - card_summary_json: the current-version card summary, or empty.
//   - snapshot_json: the raw snapshot only when it has no current summary,
//     otherwise empty. SQLite reads the snapshot row only for this fallback.
//
// With dlsiteOnly the latest snapshot is chosen among DLsite snapshots;
// otherwise among snapshots from every provider.
func LatestSnapshotCardColumnsSQL(workIDExpression string, dlsiteOnly bool) string {
	from := `FROM metadata_snapshot AS card_snapshot`
	where := `WHERE card_snapshot.work_id = ` + workIDExpression
	if dlsiteOnly {
		from += ` INNER JOIN metadata_provider AS card_provider ON card_provider.id = card_snapshot.provider_id`
		where += ` AND card_provider.code = 'dlsite'`
	}
	from += ` LEFT JOIN metadata_snapshot_card_summary AS card_summary ON card_summary.snapshot_id = card_snapshot.id AND card_summary.version = ` + strconv.Itoa(SnapshotCardSummaryVersion)
	latest := from + ` ` + where + ` ORDER BY card_snapshot.fetched_at DESC, card_snapshot.id DESC LIMIT 1`
	return `COALESCE((SELECT card_summary.summary_json ` + latest + `), '') AS card_summary_json,
		COALESCE((SELECT CASE WHEN card_summary.snapshot_id IS NULL THEN card_snapshot.snapshot_json END ` + latest + `), '') AS snapshot_json`
}
