// Package metadatatags owns shared tag concepts, independently of provider
// snapshots, file availability, and personal user tags.
package metadatatags

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const Namespace = "metadata"

var ErrHidden = errors.New("metadata tag is hidden")

var ErrInvalid = errors.New("invalid metadata tag change")

type Querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}
type Name struct {
	Language string `json:"language"`
	Name     string `json:"name"`
	Source   string `json:"source"`
}
type Tag struct {
	ResolvedHidden   bool    `json:"resolvedHidden"`
	ID               int64   `json:"id"`
	Key              string  `json:"key"`
	DisplayName      string  `json:"displayName"`
	GenreID          *int64  `json:"dlsiteGenreId"`
	MergedInto       *int64  `json:"mergedIntoTagId"`
	Hidden           bool    `json:"hidden"`
	Source           string  `json:"source"`
	WorkCount        int     `json:"workCount"`
	PendingWorkCount int     `json:"pendingWorkCount"`
	Names            []Name  `json:"names"`
	MergedFrom       []int64 `json:"mergedFromTagIds"`
}
type EffectiveTag struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"displayName"`
	Source      string `json:"source"`
}
type Override struct {
	TagID  int64  `json:"tagId"`
	Action string `json:"action"`
}

func ensureTx(ctx context.Context, tx *sql.Tx, key, name string, genre any) (int64, error) {
	if _, err := tx.ExecContext(ctx, "INSERT INTO tag(namespace, normalized_name, display_name, language) VALUES ('metadata', ?, ?, '') ON CONFLICT(namespace, normalized_name, language) DO NOTHING", key, name); err != nil {
		return 0, err
	}
	var id int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM tag WHERE namespace = 'metadata' AND normalized_name = ? AND language = ''", key).Scan(&id); err != nil {
		return 0, err
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO metadata_tag(tag_id, dlsite_genre_id) VALUES (?, ?) ON CONFLICT(tag_id) DO NOTHING", id, genre)
	return id, err
}
func EnsureGenreTx(ctx context.Context, tx *sql.Tx, genreID int64) (int64, error) {
	if genreID <= 0 {
		return 0, ErrInvalid
	}
	var name string
	err := tx.QueryRowContext(ctx, "SELECT name FROM dlsite_genre_name WHERE genre_id=? AND TRIM(name)<>'' ORDER BY CASE WHEN language='ja-jp' THEN 0 ELSE 1 END,language LIMIT 1", genreID).Scan(&name)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	id, err := ensureTx(ctx, tx, "dlsite-genre:"+strconv.FormatInt(genreID, 10), name, genreID)
	if err != nil {
		return 0, err
	}
	priorities, err := PreferredLanguages(ctx, tx)
	if err != nil {
		return 0, err
	}
	return id, RefreshNamesTx(ctx, tx, priorities, id)
}

// Older imported names without ids keep a stable concept until a provider id
// can be learned. Known genre ids always take precedence over name matching.
func EnsureLegacyTx(ctx context.Context, tx *sql.Tx, name string) (int64, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return 0, ErrInvalid
	}
	var genre int64
	err := tx.QueryRowContext(ctx, "SELECT genre_id FROM dlsite_genre_name WHERE LOWER(TRIM(name)) = LOWER(?) ORDER BY genre_id LIMIT 1", name).Scan(&genre)
	if err == nil {
		return EnsureGenreTx(ctx, tx, genre)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	hash := sha256.Sum256([]byte(strings.ToLower(name)))
	return ensureTx(ctx, tx, "dlsite-name:"+hex.EncodeToString(hash[:]), name, nil)
}
func nullableUser(id int64) any {
	if id > 0 {
		return id
	}
	return nil
}
func CreateTx(ctx context.Context, tx *sql.Tx, name string, userID int64) (int64, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 512 {
		return 0, ErrInvalid
	}
	if id, err := FindByName(ctx, tx, name); err == nil {
		resolved, hidden, err := resolve(ctx, tx, id)
		if err == nil && hidden {
			return 0, ErrHidden
		}
		return resolved.ID, err
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx, "INSERT INTO tag(namespace,normalized_name,display_name,language,is_user_defined) VALUES ('metadata',?,?, '',1)", "custom:"+hex.EncodeToString(token[:]), name)
	if err != nil {
		return 0, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO metadata_tag(tag_id,created_by_user_id) VALUES (?,?)", id, nullableUser(userID)); err != nil {
		return 0, err
	}
	return id, SetNameTx(ctx, tx, id, "", name, userID)
}
func SetNameTx(ctx context.Context, tx *sql.Tx, id int64, language, name string, userID int64) error {
	language = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(language), "_", "-"))
	switch language {
	case "", "ja-jp", "zh-cn", "zh-tw", "en-us", "ko-kr":
	default:
		return ErrInvalid
	}
	name = strings.TrimSpace(name)
	if len(name) > 512 {
		return ErrInvalid
	}
	var exists bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM metadata_tag WHERE tag_id=?)", id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return sql.ErrNoRows
	}
	if name == "" {
		_, err := tx.ExecContext(ctx, "DELETE FROM metadata_tag_name WHERE tag_id=? AND language=?", id, language)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO metadata_tag_name(tag_id,language,name,updated_by_user_id) VALUES (?,?,?,?)
 ON CONFLICT(tag_id,language) DO UPDATE SET name=excluded.name,updated_by_user_id=excluded.updated_by_user_id,updated_at=CURRENT_TIMESTAMP`, id, language, name, nullableUser(userID))
	return err
}
func MergeTx(ctx context.Context, tx *sql.Tx, source, target int64) error {
	if source <= 0 || target < 0 || source == target {
		return ErrInvalid
	}
	seen := map[int64]bool{source: true}
	for current := target; current > 0; {
		if seen[current] {
			return ErrInvalid
		}
		seen[current] = true
		var next sql.NullInt64
		if err := tx.QueryRowContext(ctx, "SELECT merged_into_tag_id FROM metadata_tag WHERE tag_id=?", current).Scan(&next); err != nil {
			return err
		}
		current = next.Int64
	}
	result, err := tx.ExecContext(ctx, "UPDATE metadata_tag SET merged_into_tag_id=?,updated_at=CURRENT_TIMESTAMP WHERE tag_id=?", nullableUser(target), source)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 0 {
		return sql.ErrNoRows
	}
	return err
}
func closeRows(rows *sql.Rows) error {
	err := rows.Err()
	other := rows.Close()
	if err != nil {
		return err
	}
	return other
}

func loadNames(ctx context.Context, q Querier, id, genre int64) ([]Name, error) {
	rows, err := q.QueryContext(ctx, `SELECT language,name,'manual' FROM metadata_tag_name WHERE tag_id=?
 UNION ALL SELECT language,name,'dlsite' FROM dlsite_genre_name WHERE genre_id=? ORDER BY 3 DESC,1`, id, genre)
	if err != nil {
		return nil, err
	}
	result := []Name{}
	for rows.Next() {
		var n Name
		if err := rows.Scan(&n.Language, &n.Name, &n.Source); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result = append(result, n)
	}
	return result, closeRows(rows)
}
func languageName(names []Name, language string) string {
	find := func(source, lang string) string {
		for _, n := range names {
			if n.Language == lang && n.Source == source && strings.TrimSpace(n.Name) != "" {
				return n.Name
			}
		}
		return ""
	}
	for _, value := range []struct{ source, language string }{{"manual", language}, {"manual", ""}, {"dlsite", language}} {
		if name := find(value.source, value.language); name != "" {
			return name
		}
	}
	return ""
}

func displayName(names []Name, priorities []string, fallback string) string {
	// "origin" concerns edition titles; tag dictionaries fall back to Japanese
	// only after all explicitly preferred languages.
	for _, lang := range append(append([]string{}, priorities...), "ja-jp") {
		if lang == "origin" {
			continue
		}
		if name := languageName(names, lang); name != "" {
			return name
		}
	}
	if name := languageName(names, ""); name != "" {
		return name
	}
	for _, n := range names {
		if strings.TrimSpace(n.Name) != "" {
			return n.Name
		}
	}
	return fallback
}
func RefreshNamesTx(ctx context.Context, tx *sql.Tx, priorities []string, ids ...int64) error {
	query := "SELECT tag.id,tag.display_name,concept.dlsite_genre_id FROM metadata_tag AS concept INNER JOIN tag ON tag.id=concept.tag_id"
	args := []any{}
	if len(ids) > 0 {
		query += " WHERE tag.id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + ")"
		for _, id := range ids {
			args = append(args, id)
		}
	}
	rows, err := tx.QueryContext(ctx, query+" ORDER BY tag.id", args...)
	if err != nil {
		return err
	}
	type item struct {
		id    int64
		name  string
		genre sql.NullInt64
	}
	items := []item{}
	for rows.Next() {
		var i item
		if err := rows.Scan(&i.id, &i.name, &i.genre); err != nil {
			_ = rows.Close()
			return err
		}
		items = append(items, i)
	}
	if err := closeRows(rows); err != nil {
		return err
	}
	for _, i := range items {
		names, err := loadNames(ctx, tx, i.id, i.genre.Int64)
		if err != nil {
			return err
		}
		name := displayName(names, priorities, i.name)
		if _, err := tx.ExecContext(ctx, "UPDATE tag SET display_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND display_name<>?", name, i.id, name); err != nil {
			return err
		}
	}
	return nil
}
func Load(ctx context.Context, q Querier, id int64) (Tag, error) {
	var t Tag
	var genre, merged sql.NullInt64
	var custom bool
	err := q.QueryRowContext(ctx, `SELECT tag.id,tag.normalized_name,tag.display_name,concept.dlsite_genre_id,concept.merged_into_tag_id,concept.hidden,tag.is_user_defined,
 (SELECT COUNT(DISTINCT work_id) FROM work_tag WHERE tag_id=tag.id)
 FROM metadata_tag AS concept INNER JOIN tag ON tag.id=concept.tag_id WHERE tag.id=?`, id).Scan(&t.ID, &t.Key, &t.DisplayName, &genre, &merged, &t.Hidden, &custom, &t.WorkCount)
	if err != nil {
		return t, err
	}
	if genre.Valid {
		t.GenreID = &genre.Int64
	}
	if merged.Valid {
		t.MergedInto = &merged.Int64
	}
	_, t.ResolvedHidden, err = resolve(ctx, q, id)
	if err != nil {
		return t, err
	}
	t.Source = "dlsite"
	if custom {
		t.Source = "manual"
	}
	t.Names, err = loadNames(ctx, q, id, genre.Int64)
	if err != nil {
		return t, err
	}
	if err := q.QueryRowContext(ctx, "SELECT COUNT(*) FROM work_metadata_tag_dirty").Scan(&t.PendingWorkCount); err != nil {
		return t, err
	}
	t.MergedFrom = []int64{}
	rows, err := q.QueryContext(ctx, "SELECT tag_id FROM metadata_tag WHERE merged_into_tag_id=? ORDER BY tag_id", id)
	if err != nil {
		return t, err
	}
	for rows.Next() {
		var source int64
		if err := rows.Scan(&source); err != nil {
			_ = rows.Close()
			return t, err
		}
		t.MergedFrom = append(t.MergedFrom, source)
	}
	return t, closeRows(rows)
}
func Overrides(ctx context.Context, q Querier, workID int64) ([]Override, error) {
	rows, err := q.QueryContext(ctx, "SELECT tag_id,action FROM work_tag_override WHERE work_id=? ORDER BY tag_id", workID)
	if err != nil {
		return nil, err
	}
	result := []Override{}
	for rows.Next() {
		var o Override
		if err := rows.Scan(&o.TagID, &o.Action); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result = append(result, o)
	}
	return result, closeRows(rows)
}
func SetOverridesTx(ctx context.Context, tx *sql.Tx, workID int64, values []Override, userID int64) error {
	if len(values) > 256 {
		return ErrInvalid
	}
	seen := map[int64]bool{}
	for _, v := range values {
		if v.TagID <= 0 || seen[v.TagID] || (v.Action != "add" && v.Action != "remove") {
			return ErrInvalid
		}
		seen[v.TagID] = true
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM metadata_tag WHERE tag_id=?)", v.TagID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrInvalid
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_tag_override WHERE work_id=?", workID); err != nil {
		return err
	}
	for _, v := range values {
		if _, err := tx.ExecContext(ctx, "INSERT INTO work_tag_override(work_id,tag_id,action,updated_by_user_id) VALUES (?,?,?,?)", workID, v.TagID, v.Action, nullableUser(userID)); err != nil {
			return err
		}
	}
	return nil
}

func resolve(ctx context.Context, q Querier, id int64) (EffectiveTag, bool, error) {
	seen := map[int64]bool{}
	for id > 0 {
		if seen[id] {
			return EffectiveTag{}, false, fmt.Errorf("metadata tag merge cycle")
		}
		seen[id] = true
		var name string
		var next sql.NullInt64
		var h bool
		if err := q.QueryRowContext(ctx, "SELECT tag.display_name,concept.merged_into_tag_id,concept.hidden FROM metadata_tag AS concept INNER JOIN tag ON tag.id=concept.tag_id WHERE tag.id=?", id).Scan(&name, &next, &h); err != nil {
			return EffectiveTag{}, false, err
		}
		if !next.Valid {
			return EffectiveTag{ID: id, DisplayName: name}, h, nil
		}
		id = next.Int64
	}
	return EffectiveTag{}, false, ErrInvalid
}
