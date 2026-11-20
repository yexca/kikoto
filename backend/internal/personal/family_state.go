package personal

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// Personal state of a work family lives on the family's canonical work: the
// logical work's canonical work, else its canonical edition, else the work
// itself when the family has neither in the library. Writes made through an
// edition land there, and ConsolidateFamily moves what an edition still holds
// when the family's canonical work changes.

// CanonicalWorkIDSQL is the SQL expression for the canonical work of the work
// whose id the given expression yields.
func CanonicalWorkIDSQL(workIDExpression string) string {
	return fmt.Sprintf(`COALESCE((
		SELECT COALESCE(family.canonical_work_id, (
			SELECT MIN(canonical.work_id) FROM work_edition AS canonical
			WHERE canonical.logical_work_id = family_edition.logical_work_id AND canonical.is_canonical = 1
		))
		FROM work_edition AS family_edition
		INNER JOIN logical_work AS family ON family.id = family_edition.logical_work_id
		WHERE family_edition.work_id = %s
	), %s)`, workIDExpression, workIDExpression)
}

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// CanonicalWorkID returns the canonical work of a work's family.
func CanonicalWorkID(ctx context.Context, db queryer, workID int64) (int64, error) {
	var canonical int64
	err := db.QueryRowContext(ctx, "SELECT "+CanonicalWorkIDSQL("?"), workID, workID).Scan(&canonical)
	return canonical, err
}

// ConsolidateFamily moves the personal state each account keeps on an edition
// of the logical work onto the family's canonical work: listening marks,
// ratings and notes, personal tags, favorite list membership, the Resume
// cursor, and listening sessions. Conflicts merge: the later mark, rating, and
// cursor win, notes are joined, the work keeps the tags of both, a tag or a
// list on both keeps one entry dated by the earlier one, and the favorite flag
// follows the moved memberships. A family without a
// canonical work in the library keeps each edition's state where it is.
func ConsolidateFamily(ctx context.Context, db *sqlutil.DB, logicalWorkID int64) error {
	// A read decides whether anything moves, so a family that holds nothing
	// on its editions never takes a write transaction.
	_, members, err := familyStateToMove(ctx, db, logicalWorkID)
	if err != nil || len(members) == 0 {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	canonical, members, err := familyStateToMove(ctx, tx, logicalWorkID)
	if err != nil || len(members) == 0 {
		return err
	}
	for _, member := range members {
		if err := moveWorkState(ctx, tx, member, canonical); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type stateReader interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// familyStateToMove returns the family's canonical work and the editions
// that still hold personal state.
func familyStateToMove(ctx context.Context, reader stateReader, logicalWorkID int64) (int64, []int64, error) {
	var canonical sql.NullInt64
	err := reader.QueryRowContext(ctx, `
		SELECT COALESCE(family.canonical_work_id, (
			SELECT MIN(work_id) FROM work_edition WHERE logical_work_id = family.id AND is_canonical = 1
		))
		FROM logical_work AS family WHERE family.id = ?
	`, logicalWorkID).Scan(&canonical)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !canonical.Valid {
		return 0, nil, nil
	}
	if err != nil {
		return 0, nil, err
	}
	members, err := familyEditionsHoldingState(ctx, reader, logicalWorkID, canonical.Int64)
	return canonical.Int64, members, err
}

// ConsolidateSplitFamilies consolidates every family whose personal state
// lies on an edition other than its canonical work, as data written before
// state moved with the canonical work, or a family that changed while its
// consolidation could not run, leaves it.
func ConsolidateSplitFamilies(ctx context.Context, db *sqlutil.DB) error {
	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT edition.logical_work_id FROM work_edition AS edition
		WHERE edition.work_id <> `+CanonicalWorkIDSQL("edition.work_id")+` AND (`+workHoldsStateSQL("edition.work_id")+`)
		ORDER BY edition.logical_work_id
	`)
	if err != nil {
		return err
	}
	families := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		families = append(families, id)
	}
	if err := errors.Join(rows.Err(), rows.Close()); err != nil {
		return err
	}
	for _, id := range families {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := ConsolidateFamily(ctx, db, id); err != nil {
			return err
		}
	}
	return nil
}

func workHoldsStateSQL(workIDExpression string) string {
	parts := []string{}
	for _, table := range []string{"user_work_state", "user_work_tag", "favorite_list_item", "favorite_list_smart_exclusion", "user_work_playback_cursor", "user_listening_session", "user_listening_day", "user_listening_import"} {
		parts = append(parts, fmt.Sprintf("EXISTS (SELECT 1 FROM %s WHERE %s.work_id = %s)", table, table, workIDExpression))
	}
	return strings.Join(parts, " OR ")
}

func familyEditionsHoldingState(ctx context.Context, reader stateReader, logicalWorkID, canonical int64) ([]int64, error) {
	rows, err := reader.QueryContext(ctx, `
		SELECT edition.work_id FROM work_edition AS edition
		WHERE edition.logical_work_id = ? AND edition.work_id <> ? AND (`+workHoldsStateSQL("edition.work_id")+`)
		ORDER BY edition.work_id
	`, logicalWorkID, canonical)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	members := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		members = append(members, id)
	}
	return members, rows.Err()
}

type workStateRow struct {
	userID       int64
	status       string
	rating       sql.NullInt64
	note         string
	lastPlayedAt sql.NullString
	createdAt    string
	updatedAt    string
}

func moveWorkState(ctx context.Context, tx *sql.Tx, from, to int64) error {
	if err := moveUserWorkState(ctx, tx, from, to); err != nil {
		return err
	}
	if err := moveFavoriteMemberships(ctx, tx, from, to); err != nil {
		return err
	}
	if err := moveUserWorkTags(ctx, tx, from, to); err != nil {
		return err
	}
	if err := movePlaybackCursor(ctx, tx, from, to); err != nil {
		return err
	}
	if err := moveListening(ctx, tx, from, to); err != nil {
		return err
	}
	return refreshFavoriteFlags(ctx, tx, to)
}

func loadWorkStateRows(ctx context.Context, tx *sql.Tx, workID int64) (map[int64]workStateRow, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT user_id, listening_status, rating, note, last_played_at, created_at, updated_at
		FROM user_work_state WHERE work_id = ?
	`, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	states := map[int64]workStateRow{}
	for rows.Next() {
		var row workStateRow
		if err := rows.Scan(&row.userID, &row.status, &row.rating, &row.note, &row.lastPlayedAt, &row.createdAt, &row.updatedAt); err != nil {
			return nil, err
		}
		states[row.userID] = row
	}
	return states, rows.Err()
}

func moveUserWorkState(ctx context.Context, tx *sql.Tx, from, to int64) error {
	sources, err := loadWorkStateRows(ctx, tx, from)
	if err != nil || len(sources) == 0 {
		return err
	}
	targets, err := loadWorkStateRows(ctx, tx, to)
	if err != nil {
		return err
	}
	for userID, source := range sources {
		merged := source
		if target, ok := targets[userID]; ok {
			merged = mergeWorkState(target, source)
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_work_state (user_id, work_id, listening_status, favorite, rating, note, last_played_at, created_at, updated_at)
			VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, work_id) DO UPDATE SET
				listening_status = excluded.listening_status, rating = excluded.rating, note = excluded.note,
				last_played_at = excluded.last_played_at, created_at = excluded.created_at, updated_at = excluded.updated_at
		`, userID, to, merged.status, merged.rating, merged.note, merged.lastPlayedAt, merged.createdAt, merged.updatedAt); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM user_work_state WHERE work_id = ?`, from)
	return err
}

// mergeWorkState keeps the mark and rating of the row changed later, joins
// two notes, and spans both rows' dates. A row changed after it was created
// keeps even a cleared mark or rating, so clearing one is never undone by the
// other row; only a row never changed since its creation takes the other's.
func mergeWorkState(target, source workStateRow) workStateRow {
	later, earlier := target, source
	if source.updatedAt > target.updatedAt {
		later, earlier = source, target
	}
	merged := target
	merged.status, merged.rating = later.status, later.rating
	if later.updatedAt <= later.createdAt {
		if merged.status == "none" {
			merged.status = earlier.status
		}
		if !merged.rating.Valid {
			merged.rating = earlier.rating
		}
	}
	switch first, second := strings.TrimSpace(target.note), strings.TrimSpace(source.note); {
	case first == "":
		merged.note = source.note
	case second == "" || first == second:
		merged.note = target.note
	default:
		merged.note = target.note + "\n\n" + source.note
	}
	if !merged.lastPlayedAt.Valid || source.lastPlayedAt.Valid && source.lastPlayedAt.String > merged.lastPlayedAt.String {
		merged.lastPlayedAt = source.lastPlayedAt
	}
	merged.createdAt = min(target.createdAt, source.createdAt)
	merged.updatedAt = max(target.updatedAt, source.updatedAt)
	return merged
}

func moveFavoriteMemberships(ctx context.Context, tx *sql.Tx, from, to int64) error {
	for _, statement := range []string{
		// A list holding both keeps one membership, dated by the earlier.
		`UPDATE favorite_list_item
			SET created_at = MIN(created_at, (SELECT source.created_at FROM favorite_list_item AS source
					WHERE source.list_id = favorite_list_item.list_id AND source.work_id = ?1)),
				note = CASE WHEN note <> '' THEN note ELSE (SELECT source.note FROM favorite_list_item AS source
					WHERE source.list_id = favorite_list_item.list_id AND source.work_id = ?1) END
			WHERE work_id = ?2 AND list_id IN (SELECT list_id FROM favorite_list_item WHERE work_id = ?1)`,
		`UPDATE favorite_list_item SET work_id = ?2
			WHERE work_id = ?1 AND list_id NOT IN (SELECT list_id FROM favorite_list_item WHERE work_id = ?2)`,
		`DELETE FROM favorite_list_item WHERE work_id = ?1`,
		`INSERT INTO favorite_list_smart_exclusion (list_id, work_id, created_at)
			SELECT list_id, ?2, created_at FROM favorite_list_smart_exclusion WHERE work_id = ?1
			ON CONFLICT(list_id, work_id) DO NOTHING`,
		`DELETE FROM favorite_list_smart_exclusion WHERE work_id = ?1`,
	} {
		if _, err := tx.ExecContext(ctx, statement, from, to); err != nil {
			return err
		}
	}
	return nil
}

// moveUserWorkTags gives the canonical work the personal tags of both works;
// a tag on both keeps the earlier tagging date.
func moveUserWorkTags(ctx context.Context, tx *sql.Tx, from, to int64) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_work_tag (user_id, work_id, user_tag_id, created_at)
		SELECT user_id, ?2, user_tag_id, created_at FROM user_work_tag WHERE work_id = ?1
		ON CONFLICT(user_id, work_id, user_tag_id) DO UPDATE SET created_at = MIN(user_work_tag.created_at, excluded.created_at)
	`, from, to); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM user_work_tag WHERE work_id = ?1`, from)
	return err
}

// moveListening moves listening sessions and adds an edition's daily and
// imported listening to the canonical work's.
func moveListening(ctx context.Context, tx *sql.Tx, from, to int64) error {
	for _, statement := range []string{
		`UPDATE user_listening_session SET work_id = ?2 WHERE work_id = ?1`,
		`INSERT INTO user_listening_day (user_id, work_id, day, listened_seconds, listen_count)
			SELECT user_id, ?2, day, listened_seconds, listen_count FROM user_listening_day WHERE work_id = ?1
			ON CONFLICT(user_id, work_id, day) DO UPDATE SET
				listened_seconds = user_listening_day.listened_seconds + excluded.listened_seconds,
				listen_count = user_listening_day.listen_count + excluded.listen_count`,
		`DELETE FROM user_listening_day WHERE work_id = ?1`,
		`INSERT INTO user_listening_import (user_id, work_id, listened_seconds, listen_count, last_played_at)
			SELECT user_id, ?2, listened_seconds, listen_count, last_played_at FROM user_listening_import WHERE work_id = ?1
			ON CONFLICT(user_id, work_id) DO UPDATE SET
				listened_seconds = user_listening_import.listened_seconds + excluded.listened_seconds,
				listen_count = user_listening_import.listen_count + excluded.listen_count,
				last_played_at = MAX(user_listening_import.last_played_at, excluded.last_played_at)`,
		`DELETE FROM user_listening_import WHERE work_id = ?1`,
	} {
		if _, err := tx.ExecContext(ctx, statement, from, to); err != nil {
			return err
		}
	}
	return nil
}

// movePlaybackCursor keeps, per account, the cursor played last.
func movePlaybackCursor(ctx context.Context, tx *sql.Tx, from, to int64) error {
	const playedAt = `COALESCE(user_work_playback_cursor.last_played_at, user_work_playback_cursor.updated_at)`
	for _, statement := range []string{
		`DELETE FROM user_work_playback_cursor
			WHERE work_id = ?2 AND EXISTS (
				SELECT 1 FROM user_work_playback_cursor AS source
				WHERE source.user_id = user_work_playback_cursor.user_id AND source.work_id = ?1
					AND COALESCE(source.last_played_at, source.updated_at) > ` + playedAt + `
			)`,
		`DELETE FROM user_work_playback_cursor
			WHERE work_id = ?1 AND EXISTS (
				SELECT 1 FROM user_work_playback_cursor AS target
				WHERE target.user_id = user_work_playback_cursor.user_id AND target.work_id = ?2
			)`,
		`UPDATE user_work_playback_cursor SET work_id = ?2 WHERE work_id = ?1`,
	} {
		if _, err := tx.ExecContext(ctx, statement, from, to); err != nil {
			return err
		}
	}
	return nil
}

// refreshFavoriteFlags sets user_work_state.favorite for the work to whether
// the account holds it in a user or smart list.
func refreshFavoriteFlags(ctx context.Context, tx *sql.Tx, workID int64) error {
	const listed = `EXISTS (
		SELECT 1 FROM favorite_list_item AS item
		INNER JOIN favorite_list AS list ON list.id = item.list_id
		WHERE list.user_id = %s AND list.kind IN ('user', 'smart') AND item.work_id = ?1
	)`
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
		SELECT DISTINCT list.user_id, ?1, 'none', 1
		FROM favorite_list_item AS item
		INNER JOIN favorite_list AS list ON list.id = item.list_id
		WHERE item.work_id = ?1 AND list.kind IN ('user', 'smart')
		ON CONFLICT(user_id, work_id) DO NOTHING
	`, workID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE user_work_state SET favorite = `+fmt.Sprintf(listed, "user_work_state.user_id")+`
		WHERE work_id = ?1`, workID)
	return err
}
