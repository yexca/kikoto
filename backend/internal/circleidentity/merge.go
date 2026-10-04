package circleidentity

import (
	"context"
	"database/sql"
	"encoding/json"
)

func Merge(ctx context.Context, db *sql.DB, target, source int64) (int64, error) {
	if target <= 0 || source <= 0 || target == source {
		return 0, ErrInvalid
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	t, err := Load(ctx, tx, target)
	if err != nil {
		return 0, err
	}
	s, err := Load(ctx, tx, source)
	if err != nil {
		return 0, err
	}
	before, err := capture(ctx, tx, target, source)
	if err != nil {
		return 0, err
	}
	if err := mergeRelations(ctx, tx, target, source, s.DisplayName); err != nil {
		return 0, err
	}
	after, err := capture(ctx, tx, target, source)
	if err != nil {
		return 0, err
	}
	raw, err := json.Marshal(mergeSnapshot{Before: before, After: after})
	if err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO party_merge_review(target_party_id,source_party_id,target_name,source_name,snapshot_json) VALUES (?,?,?,?,?)", target, source, t.DisplayName, s.DisplayName, string(raw))
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	return id, tx.Commit()
}
func mergeRelations(ctx context.Context, tx *sql.Tx, target, source int64, sourceName string) error {
	queries := []struct {
		sql  string
		args []any
	}{
		{"INSERT INTO party_alias(party_id,alias,source) VALUES (?,?,'merged_name') ON CONFLICT(party_id,alias) DO NOTHING", []any{target, sourceName}},
		{"INSERT INTO party_alias(party_id,alias,source) SELECT ?,alias,'merged_alias' FROM party_alias WHERE party_id=? ON CONFLICT(party_id,alias) DO NOTHING", []any{target, source}},
		{`UPDATE party_external_id SET party_id=?,is_primary=CASE WHEN EXISTS(
   SELECT 1 FROM party_external_id AS kept WHERE kept.party_id=? AND kept.provider_id=party_external_id.provider_id AND kept.id_type=party_external_id.id_type AND kept.is_primary=1
  ) THEN 0 ELSE is_primary END WHERE party_id=?`, []any{target, target, source}},
		{`INSERT INTO work_party(work_id,party_id,role,provider_id,source,created_at,updated_at)
   SELECT work_id,?,role,provider_id,source,created_at,updated_at FROM work_party WHERE party_id=?
   ON CONFLICT(work_id,party_id,role) DO NOTHING`, []any{target, source}},
		{`INSERT INTO user_party_state(user_id,party_id,rating,note,favorite,last_viewed_at,created_at,updated_at)
   SELECT user_id,?,rating,note,favorite,last_viewed_at,created_at,updated_at FROM user_party_state WHERE party_id=?
   ON CONFLICT(user_id,party_id) DO UPDATE SET rating=COALESCE(user_party_state.rating,excluded.rating),
    note=CASE WHEN user_party_state.note='' THEN excluded.note ELSE user_party_state.note END,
    favorite=MAX(user_party_state.favorite,excluded.favorite),
    last_viewed_at=COALESCE(user_party_state.last_viewed_at,excluded.last_viewed_at)`, []any{target, source}},
		{`INSERT INTO user_party_tag_assignment(user_id,party_id,user_party_tag_id,created_at)
   SELECT user_id,?,user_party_tag_id,created_at FROM user_party_tag_assignment WHERE party_id=?
   ON CONFLICT(user_id,party_id,user_party_tag_id) DO NOTHING`, []any{target, source}},
		{`INSERT INTO party_catalog_item(party_id,provider_id,primary_code,title,release_date,url,catalog_status,dlsite_available,raw_json,last_seen_at)
   SELECT ?,provider_id,primary_code,title,release_date,url,catalog_status,dlsite_available,raw_json,last_seen_at FROM party_catalog_item WHERE party_id=?
   ON CONFLICT(party_id,provider_id,primary_code) DO UPDATE SET title=excluded.title,release_date=excluded.release_date,url=excluded.url,catalog_status=excluded.catalog_status,
   dlsite_available=excluded.dlsite_available,raw_json=excluded.raw_json,last_seen_at=excluded.last_seen_at
   WHERE excluded.last_seen_at>party_catalog_item.last_seen_at`, []any{target, source}},
		{"UPDATE party_metadata_snapshot SET party_id=? WHERE party_id=?", []any{target, source}},
		{"DELETE FROM party_catalog_refresh_state WHERE party_id IN (?,?)", []any{target, source}},
		{"UPDATE party_merge_review SET target_party_id=? WHERE target_party_id=?", []any{target, source}},
	}
	for _, q := range queries {
		if _, err := tx.ExecContext(ctx, q.sql, q.args...); err != nil {
			return err
		}
	}
	if err := mergeSeries(ctx, tx, target, source); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM party WHERE id=?", source); err != nil {
		return err
	}
	// Match the provider snapshot retention boundary while the complete pre-merge
	// records remain in the protected merge review for Undo.
	_, err := tx.ExecContext(ctx, `DELETE FROM party_metadata_snapshot WHERE id IN (
 SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY provider_id ORDER BY fetched_at DESC,id DESC) AS n
 FROM party_metadata_snapshot WHERE party_id=?) WHERE n>2)`, target)
	return err
}
func mergeSeries(ctx context.Context, tx *sql.Tx, target, source int64) error {
	rows, err := tx.QueryContext(ctx, "SELECT id,provider_id,title_id FROM party_series WHERE party_id=? ORDER BY id", source)
	if err != nil {
		return err
	}
	type series struct {
		id, provider int64
		title        string
	}
	items := []series{}
	for rows.Next() {
		var s series
		if err := rows.Scan(&s.id, &s.provider, &s.title); err != nil {
			_ = rows.Close()
			return err
		}
		items = append(items, s)
	}
	if err := closeRows(rows); err != nil {
		return err
	}
	for _, s := range items {
		var targetID int64
		err := tx.QueryRowContext(ctx, "SELECT id FROM party_series WHERE party_id=? AND provider_id=? AND title_id=?", target, s.provider, s.title).Scan(&targetID)
		if err == sql.ErrNoRows {
			if _, err := tx.ExecContext(ctx, "UPDATE party_series SET party_id=? WHERE id=?", target, s.id); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO party_series_work(series_id,primary_code,position,created_at,updated_at) SELECT ?,primary_code,position,created_at,updated_at FROM party_series_work WHERE series_id=? ON CONFLICT(series_id,primary_code) DO NOTHING", targetID, s.id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM party_series WHERE id=?", s.id); err != nil {
			return err
		}
	}
	return nil
}
func Undo(ctx context.Context, db *sql.DB, target, mergeID int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var source, latest int64
	var raw string
	if err := tx.QueryRowContext(ctx, "SELECT source_party_id,snapshot_json FROM party_merge_review WHERE id=? AND target_party_id=? AND status='merged'", mergeID, target).Scan(&source, &raw); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, "SELECT MAX(id) FROM party_merge_review WHERE target_party_id=? AND status='merged'", target).Scan(&latest); err != nil {
		return err
	}
	if latest != mergeID {
		return ErrConflict
	}
	var record mergeSnapshot
	if err := json.Unmarshal([]byte(raw), &record); err != nil {
		return err
	}
	current, err := capture(ctx, tx, target, source)
	if err != nil {
		return err
	}
	if err := restore(ctx, tx, record, current); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE party_merge_review SET status='undone',undone_at=CURRENT_TIMESTAMP WHERE id=?", mergeID); err != nil {
		return err
	}
	return tx.Commit()
}
