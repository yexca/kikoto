package metadatatags

import (
	"context"
	"database/sql"
	"strings"
)

// StoredLanguages is the priority of every stored display name. Stored and
// shared metadata always use the original language; a viewer's own language
// is applied when a request presents tags.
var StoredLanguages = []string{"origin"}

// EqualFold matches Unicode case variants; names are definitions, not substring
// search keys. Creation and reuse happen inside the caller's write transaction.
func FindByName(ctx context.Context, q Querier, name string) (int64, error) {
	matches, err := FindByNames(ctx, q, []string{name})
	if err != nil {
		return 0, err
	}
	if id, ok := matches[strings.TrimSpace(name)]; ok {
		return id, nil
	}
	return 0, sql.ErrNoRows
}

// FindByNames reads every known concept name once and returns, for each
// requested trimmed name, the lowest concept id with a case-folded equal name.
func FindByNames(ctx context.Context, q Querier, names []string) (map[string]int64, error) {
	wanted := []string{}
	for _, name := range names {
		if name = strings.TrimSpace(name); name != "" {
			wanted = append(wanted, name)
		}
	}
	result := map[string]int64{}
	if len(wanted) == 0 {
		return result, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT tag.id,tag.display_name FROM tag INNER JOIN metadata_tag ON tag_id=tag.id
 UNION SELECT tag_id,name FROM metadata_tag_name
 UNION SELECT tag_id,name FROM metadata_tag_provider_name
 UNION SELECT concept.tag_id,name.name FROM metadata_tag AS concept INNER JOIN dlsite_genre_name AS name ON name.genre_id=concept.dlsite_genre_id ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var candidate string
		if err := rows.Scan(&id, &candidate); err != nil {
			return nil, err
		}
		candidate = strings.TrimSpace(candidate)
		for _, name := range wanted {
			if _, found := result[name]; !found && strings.EqualFold(candidate, name) {
				result[name] = id
			}
		}
	}
	return result, rows.Err()
}

func Projected(ctx context.Context, q Querier, workID int64) (bool, error) {
	var done bool
	err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM work_metadata_tag_projection WHERE work_id=?)", workID).Scan(&done)
	return done, err
}

func Base(ctx context.Context, q Querier, workID int64) ([]int64, error) {
	rows, err := q.QueryContext(ctx, "SELECT tag_id FROM work_metadata_tag_base WHERE work_id=? ORDER BY tag_id", workID)
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
	return ids, closeRows(rows)
}

// AffectedWorks follows the whole connected merge component, including hidden
// provider bases and removals that currently have no effective work_tag row.
// Indexed references keep the operation proportional to this component.
func AffectedWorks(ctx context.Context, q Querier, id int64) ([]int64, error) {
	rows, err := q.QueryContext(ctx, affectedWorksSQL+" ORDER BY work_id", id)
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
	return ids, closeRows(rows)
}

const affectedWorksSQL = `WITH RECURSIVE related(tag_id) AS (
 SELECT tag_id FROM metadata_tag WHERE tag_id=?
 UNION SELECT concept.tag_id FROM metadata_tag AS concept JOIN related ON concept.merged_into_tag_id=related.tag_id
 UNION SELECT concept.merged_into_tag_id FROM metadata_tag AS concept JOIN related ON concept.tag_id=related.tag_id WHERE concept.merged_into_tag_id IS NOT NULL
 ), affected(work_id) AS (
 SELECT base.work_id FROM related JOIN work_metadata_tag_base AS base ON base.tag_id=related.tag_id
 UNION SELECT overrides.work_id FROM related JOIN work_tag_override AS overrides ON overrides.tag_id=related.tag_id
 UNION SELECT link.work_id FROM related JOIN work_tag AS link ON link.tag_id=related.tag_id
 UNION SELECT genre.work_id FROM related JOIN metadata_tag AS concept ON concept.tag_id=related.tag_id JOIN work_dlsite_genre AS genre ON genre.genre_id=concept.dlsite_genre_id
 ), dependents(work_id) AS (
 SELECT work_id FROM affected
 UNION SELECT projection.work_id FROM work_metadata_tag_projection AS projection JOIN affected ON projection.source_work_id=affected.work_id
 ) SELECT work_id FROM dependents`

// EnqueueAffectedTx records the component in one indexed set operation. No work
// projection or per-work round trip occurs in the management transaction.
func EnqueueAffectedTx(ctx context.Context, tx *sql.Tx, id int64) error {
	if id <= 0 {
		return nil
	}
	_, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id) "+affectedWorksSQL, id)
	return err
}
