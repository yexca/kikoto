package metadatatags

import (
	"context"
	"database/sql"
	"sort"
	"strings"
)

// Effective resolves merges before applying overrides. A removal wins over an
// addition even when two original concepts now resolve to the same target.
func Effective(ctx context.Context, q Querier, workID, genreWorkID int64, fallback []int64) ([]EffectiveTag, error) {
	rows, err := q.QueryContext(ctx, "SELECT concept.tag_id FROM work_dlsite_genre AS genre INNER JOIN metadata_tag AS concept ON concept.dlsite_genre_id=genre.genre_id WHERE genre.work_id=? ORDER BY concept.tag_id", genreWorkID)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		ids = fallback
	}
	overrides, err := Overrides(ctx, q, workID)
	if err != nil {
		return nil, err
	}
	effective := map[int64]EffectiveTag{}
	for _, id := range ids {
		t, hidden, err := resolve(ctx, q, id)
		if err != nil {
			return nil, err
		}
		if !hidden {
			t.Source = "dlsite"
			effective[t.ID] = t
		}
	}
	removals := map[int64]bool{}
	for _, v := range overrides {
		t, hidden, err := resolve(ctx, q, v.TagID)
		if err != nil {
			return nil, err
		}
		if v.Action == "remove" {
			removals[t.ID] = true
		} else if !hidden {
			if _, exists := effective[t.ID]; !exists {
				t.Source = "manual"
				effective[t.ID] = t
			}
		}
	}
	result := []EffectiveTag{}
	for id, t := range effective {
		if !removals[id] {
			result = append(result, t)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].DisplayName != result[j].DisplayName {
			return result[i].DisplayName < result[j].DisplayName
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}

func ProjectWorkTx(ctx context.Context, tx *sql.Tx, workID, genreWorkID int64, legacy []string) error {
	fallback := []int64{}
	var genreCount int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM work_dlsite_genre WHERE work_id=?", genreWorkID).Scan(&genreCount); err != nil {
		return err
	}
	if genreCount == 0 {
		if legacy == nil {
			var err error
			fallback, err = Base(ctx, tx, workID)
			if err != nil {
				return err
			}
		}
		for _, name := range legacy {
			if strings.TrimSpace(name) == "" {
				continue
			}
			id, err := EnsureLegacyTx(ctx, tx, name)
			if err != nil {
				return err
			}
			fallback = append(fallback, id)
		}
	}
	base := fallback
	if genreCount > 0 {
		rows, err := tx.QueryContext(ctx, "SELECT concept.tag_id FROM work_dlsite_genre AS genre JOIN metadata_tag AS concept ON concept.dlsite_genre_id=genre.genre_id WHERE genre.work_id=?", genreWorkID)
		if err != nil {
			return err
		}
		base = []int64{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return err
			}
			base = append(base, id)
		}
		if err := closeRows(rows); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_metadata_tag_base WHERE work_id=?", workID); err != nil {
		return err
	}
	for _, id := range base {
		if _, err := tx.ExecContext(ctx, "INSERT INTO work_metadata_tag_base(work_id,tag_id) VALUES (?,?) ON CONFLICT DO NOTHING", workID, id); err != nil {
			return err
		}
	}
	desired, err := Effective(ctx, tx, workID, genreWorkID, fallback)
	if err != nil {
		return err
	}
	// Keep unchanged relations untouched so a refresh of provenance alone does
	// not invalidate recommendation generations.
	type link struct {
		id     int64
		source string
	}
	wanted := map[link]bool{}
	for _, t := range desired {
		wanted[link{t.ID, t.Source}] = true
	}
	rows, err := tx.QueryContext(ctx, "SELECT relation.tag_id,relation.source FROM work_tag AS relation INNER JOIN tag ON tag.id=relation.tag_id WHERE work_id=? AND tag.namespace IN ('dlsite','metadata')", workID)
	if err != nil {
		return err
	}
	obsolete := []link{}
	for rows.Next() {
		var v link
		if err := rows.Scan(&v.id, &v.source); err != nil {
			_ = rows.Close()
			return err
		}
		if !wanted[v] {
			obsolete = append(obsolete, v)
		}
	}
	if err := closeRows(rows); err != nil {
		return err
	}
	for _, v := range obsolete {
		if _, err := tx.ExecContext(ctx, "DELETE FROM work_tag WHERE work_id=? AND tag_id=? AND source=?", workID, v.id, v.source); err != nil {
			return err
		}
	}
	for _, t := range desired {
		if _, err := tx.ExecContext(ctx, "INSERT INTO work_tag(work_id,tag_id,source) VALUES (?,?,?) ON CONFLICT(work_id,tag_id,source) DO NOTHING", workID, t.ID, t.Source); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO work_metadata_tag_projection(work_id,source_work_id) VALUES (?,?) ON CONFLICT(work_id) DO UPDATE SET source_work_id=excluded.source_work_id", workID, genreWorkID)
	return err
}

func Read(ctx context.Context, q Querier, workID int64) ([]EffectiveTag, error) {
	rows, err := q.QueryContext(ctx, `SELECT tag.id,tag.display_name,relation.source FROM work_tag AS relation INNER JOIN tag ON tag.id=relation.tag_id
 WHERE relation.work_id=? AND tag.namespace IN ('dlsite','metadata')
 GROUP BY tag.id ORDER BY LOWER(tag.display_name),tag.id`, workID)
	if err != nil {
		return nil, err
	}
	result := []EffectiveTag{}
	for rows.Next() {
		var t EffectiveTag
		if err := rows.Scan(&t.ID, &t.DisplayName, &t.Source); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result = append(result, t)
	}
	return result, closeRows(rows)
}
