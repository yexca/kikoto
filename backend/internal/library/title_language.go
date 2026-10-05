package library

import (
	"context"
	"database/sql"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metadatatitles"
)

// work_title_language holds each work's display title for every language that
// title selection can stop at. Triggers queue changed families in
// work_title_language_dirty, and the search index worker rebuilds them in
// bounded batches. The rows depend on stored editions and manual titles only,
// so a viewer's language preference changes the sort without a rebuild.

const titleLanguageBatchSize = 200

// TitleSortExpression is the SQL sort key of a title sort for a viewer's
// metadata language priority: the first stored title in that priority, then
// the work row's own title while the work is still queued. Languages come
// from the normalized supported set, so the literals are never user text.
func TitleSortExpression(languages []string) string {
	terms := []string{}
	for _, language := range dlsite.NormalizeMetadataPriority(languages) {
		terms = append(terms, `(SELECT sort_title.title FROM work_title_language AS sort_title WHERE sort_title.work_id = work.id AND sort_title.language = '`+language+`')`)
	}
	terms = append(terms, "work.title")
	return "COALESCE(" + strings.Join(terms, ", ") + ")"
}

// RefreshTitleLanguages rebuilds every queued language title. It is intended
// for tests; the search index worker drains the queue in production.
func (s *Store) RefreshTitleLanguages(ctx context.Context) error {
	return refreshTitleLanguages(ctx, s.db)
}

func refreshTitleLanguages(ctx context.Context, db *sql.DB) error {
	for {
		refreshed, err := refreshTitleLanguageBatch(ctx, db, titleLanguageBatchSize)
		if err != nil || refreshed < titleLanguageBatchSize {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
	}
}

func refreshTitleLanguageBatch(ctx context.Context, db *sql.DB, limit int) (int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	ids, err := queryInt64s(ctx, tx, `SELECT work_id FROM work_title_language_dirty ORDER BY work_id LIMIT ?`, limit)
	if err != nil || len(ids) == 0 {
		return 0, err
	}
	inputs, err := metadatatitles.LoadInputs(ctx, tx, ids, false)
	if err != nil {
		return 0, err
	}
	placeholders, idArgs := int64Placeholders(ids)
	if _, err := tx.ExecContext(ctx, `DELETE FROM work_title_language WHERE work_id IN (`+placeholders+`)`, idArgs...); err != nil {
		return 0, err
	}
	insert, err := tx.PrepareContext(ctx, `INSERT INTO work_title_language (work_id, language, title) VALUES (?, ?, ?)`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = insert.Close() }()
	for _, id := range ids {
		input, exists := inputs[id]
		if !exists {
			continue
		}
		for language, title := range metadatatitles.LanguageTitles(input) {
			if _, err := insert.ExecContext(ctx, id, language, title); err != nil {
				return 0, err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM work_title_language_dirty WHERE work_id IN (`+placeholders+`)`, idArgs...); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(ids), nil
}
