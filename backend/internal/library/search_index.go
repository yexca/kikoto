package library

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/searchtext"
)

// The work_search FTS5 table holds one folded document per work. Triggers
// queue changed works in work_search_dirty, and RefreshSearchIndex rebuilds
// those documents in bounded transactions before a search reads the index.

const (
	searchIndexBatchSize = 200
	// searchIndexFieldSeparator joins multiple values in one column. Fold
	// collapses every control character in stored values and query needles,
	// so a needle can never match across two values.
	searchIndexFieldSeparator = "\n"
	// A search that finds queued documents waits only briefly for the write
	// lock. A long-running writer then leaves the search on the previous index
	// state instead of stalling the page, and a later search drains the queue.
	searchIndexOpportunisticBusyTimeout = 250 * time.Millisecond
)

var searchIndexOverrideFields = []string{"title", "circle", "series", "voice_actors"}

type searchDocument struct {
	code, title, circle, voiceActor, tag []string
}

// RefreshSearchIndex rebuilds every queued search document. It waits for the
// database write lock like any other writer and is intended for startup
// warm-up and tests.
func (s *Store) RefreshSearchIndex(ctx context.Context) error {
	return refreshSearchIndex(ctx, s.db, 0)
}

// PrepareSearch brings the search index up to date before queryText is
// evaluated. Queries without index-backed clauses skip the work entirely. When
// the write lock is held elsewhere the search proceeds on the existing index;
// only works changed since the last refresh may be missing from the result.
func (s *Store) PrepareSearch(ctx context.Context, queryText string) {
	if !searchUsesIndex(queryText) {
		return
	}
	if err := refreshSearchIndex(ctx, s.db, searchIndexOpportunisticBusyTimeout); err != nil && ctx.Err() == nil {
		slog.Warn("search index refresh deferred", "error", err)
	}
}

func searchUsesIndex(queryText string) bool {
	for _, clause := range ParseSearchClauses(queryText) {
		switch clause.Kind {
		case "text", "circle", "voice_actor", "tag", "exclude_tag":
			return true
		}
	}
	return false
}

func refreshSearchIndex(ctx context.Context, db *sql.DB, busyTimeout time.Duration) (err error) {
	var pending bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM work_search_dirty)`).Scan(&pending); err != nil || !pending {
		return err
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := conn.Close(); err == nil {
			err = closeErr
		}
	}()
	if busyTimeout > 0 {
		restore, err := overrideBusyTimeout(ctx, conn, busyTimeout)
		if err != nil {
			return err
		}
		defer restore()
	}
	for {
		refreshed, err := refreshSearchIndexBatch(ctx, conn)
		if err != nil {
			return err
		}
		if refreshed < searchIndexBatchSize {
			return nil
		}
	}
}

// overrideBusyTimeout shortens the lock wait on one pooled connection and
// returns a function that restores its previous value. A connection whose
// timeout cannot be restored is discarded rather than returned to the pool.
func overrideBusyTimeout(ctx context.Context, conn *sql.Conn, timeout time.Duration) (func(), error) {
	var previous int64
	if err := conn.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&previous); err != nil {
		return nil, err
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout = %d", timeout.Milliseconds())); err != nil {
		return nil, err
	}
	return func() {
		if _, err := conn.ExecContext(context.Background(), fmt.Sprintf("PRAGMA busy_timeout = %d", previous)); err != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}, nil
}

func refreshSearchIndexBatch(ctx context.Context, conn *sql.Conn) (int, error) {
	// Connections use _txlock=immediate, so the write lock is held before the
	// queue is read and no trigger can queue a work between the read and the
	// queue deletion below.
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	ids, err := queryInt64s(ctx, tx, `SELECT work_id FROM work_search_dirty ORDER BY work_id LIMIT ?`, searchIndexBatchSize)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	documents, err := loadSearchDocuments(ctx, tx, ids)
	if err != nil {
		return 0, err
	}
	placeholders, idArgs := int64Placeholders(ids)
	if _, err := tx.ExecContext(ctx, `DELETE FROM work_search WHERE rowid IN (`+placeholders+`)`, idArgs...); err != nil {
		return 0, err
	}
	insert, err := tx.PrepareContext(ctx, `INSERT INTO work_search (rowid, code, title, circle, voice_actor, tag) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = insert.Close() }()
	for _, id := range ids {
		document, ok := documents[id]
		if !ok {
			continue
		}
		if _, err := insert.ExecContext(ctx, id,
			joinSearchValues(document.code),
			joinSearchValues(document.title),
			joinSearchValues(document.circle),
			joinSearchValues(document.voiceActor),
			joinSearchValues(document.tag),
		); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM work_search_dirty WHERE work_id IN (`+placeholders+`)`, idArgs...); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(ids), nil
}

// loadSearchDocuments reads the searchable text owned by each existing work.
// Works deleted since they were queued have no document and are removed from
// the index by the caller.
func loadSearchDocuments(ctx context.Context, tx *sql.Tx, ids []int64) (map[int64]*searchDocument, error) {
	placeholders, idArgs := int64Placeholders(ids)
	documents := make(map[int64]*searchDocument, len(ids))
	rows, err := tx.QueryContext(ctx, `SELECT id, primary_code, title FROM work WHERE id IN (`+placeholders+`)`, idArgs...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var code, title string
		if err := rows.Scan(&id, &code, &title); err != nil {
			_ = rows.Close()
			return nil, err
		}
		documents[id] = &searchDocument{code: []string{code}, title: []string{title}}
	}
	if err := closeRows(rows); err != nil {
		return nil, err
	}
	fields := []struct {
		query string
		field func(*searchDocument) *[]string
	}{
		{`SELECT edition.work_id, alias.primary_code
			FROM work_edition AS edition
			INNER JOIN work_code_alias AS alias ON alias.logical_work_id = edition.logical_work_id
			WHERE edition.work_id IN (%s)`, func(d *searchDocument) *[]string { return &d.code }},
		{`SELECT relation.work_id, party.display_name
			FROM work_party AS relation
			INNER JOIN party ON party.id = relation.party_id
			WHERE relation.role = 'circle' AND relation.work_id IN (%s)`, func(d *searchDocument) *[]string { return &d.circle }},
		{`SELECT relation.work_id, external.external_id
			FROM work_party AS relation
			INNER JOIN party_external_id AS external ON external.party_id = relation.party_id
			WHERE relation.role = 'circle' AND relation.work_id IN (%s)`, func(d *searchDocument) *[]string { return &d.circle }},
		{`SELECT credit.work_id, person.display_name
			FROM work_credit AS credit
			INNER JOIN person ON person.id = credit.person_id
			WHERE credit.role = 'voice_actor' AND credit.work_id IN (%s)`, func(d *searchDocument) *[]string { return &d.voiceActor }},
		{`SELECT link.work_id, tag.display_name
			FROM work_tag AS link
			INNER JOIN tag ON tag.id = link.tag_id
			WHERE tag.namespace = 'dlsite' AND link.work_id IN (%s)`, func(d *searchDocument) *[]string { return &d.tag }},
	}
	for _, field := range fields {
		if err := appendSearchValues(ctx, tx, fmt.Sprintf(field.query, placeholders), idArgs, documents, field.field); err != nil {
			return nil, err
		}
	}
	if err := appendOverrideSearchValues(ctx, tx, placeholders, idArgs, documents); err != nil {
		return nil, err
	}
	return documents, nil
}

func appendSearchValues(ctx context.Context, tx *sql.Tx, query string, args []any, documents map[int64]*searchDocument, field func(*searchDocument) *[]string) error {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var value string
		if err := rows.Scan(&id, &value); err != nil {
			_ = rows.Close()
			return err
		}
		if document, ok := documents[id]; ok {
			values := field(document)
			*values = append(*values, value)
		}
	}
	return closeRows(rows)
}

// Manual overrides store JSON values such as a title string, a circle object,
// or a voice actor list. Only string leaves are indexed so JSON keys do not
// match every overridden work.
func appendOverrideSearchValues(ctx context.Context, tx *sql.Tx, placeholders string, idArgs []any, documents map[int64]*searchDocument) error {
	fieldPlaceholders := strings.TrimSuffix(strings.Repeat("?,", len(searchIndexOverrideFields)), ",")
	args := append([]any{}, idArgs...)
	for _, field := range searchIndexOverrideFields {
		args = append(args, field)
	}
	rows, err := tx.QueryContext(ctx, `SELECT work_id, field_name, value_json FROM work_manual_override
		WHERE work_id IN (`+placeholders+`) AND field_name IN (`+fieldPlaceholders+`)`, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var fieldName, valueJSON string
		if err := rows.Scan(&id, &fieldName, &valueJSON); err != nil {
			_ = rows.Close()
			return err
		}
		document, ok := documents[id]
		if !ok {
			continue
		}
		var target *[]string
		switch fieldName {
		case "circle":
			target = &document.circle
		case "voice_actors":
			target = &document.voiceActor
		default:
			target = &document.title
		}
		var value any
		if err := json.Unmarshal([]byte(valueJSON), &value); err != nil {
			*target = append(*target, valueJSON)
			continue
		}
		*target = appendJSONStrings(*target, value)
	}
	return closeRows(rows)
}

func appendJSONStrings(values []string, value any) []string {
	switch typed := value.(type) {
	case string:
		return append(values, typed)
	case []any:
		for _, item := range typed {
			values = appendJSONStrings(values, item)
		}
	case map[string]any:
		for _, item := range typed {
			values = appendJSONStrings(values, item)
		}
	}
	return values
}

func joinSearchValues(values []string) string {
	folded := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		value = searchtext.Fold(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		folded = append(folded, value)
	}
	return strings.Join(folded, searchIndexFieldSeparator)
}

func queryInt64s(ctx context.Context, tx *sql.Tx, query string, args ...any) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	values := []int64{}
	for rows.Next() {
		var value int64
		if err := rows.Scan(&value); err != nil {
			_ = rows.Close()
			return nil, err
		}
		values = append(values, value)
	}
	return values, closeRows(rows)
}

func closeRows(rows *sql.Rows) error {
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	return rows.Close()
}

func int64Placeholders(ids []int64) (string, []any) {
	args := make([]any, len(ids))
	for index, id := range ids {
		args[index] = id
	}
	return strings.TrimSuffix(strings.Repeat("?,", len(ids)), ","), args
}
