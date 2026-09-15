package library

import (
	"context"
	"strings"
)

// MaintenanceOptions composes a trusted metadata predicate with the Library's
// existing family search and source availability rules. Predicates come from
// application composition, never from request text.
type MaintenanceOptions struct {
	ListOptions
	MetadataWhere   string
	MetadataArgs    []any
	IncludeNoSource bool
	Reason          string
}

type MaintenancePage struct {
	RawPage
	NoSource map[int64]bool
}

func (s *Store) ListMaintenance(ctx context.Context, options MaintenanceOptions) (MaintenancePage, error) {
	where, args := listWhere("", "all", options.Query, options.UserID, options.DemoOnly)
	// A family without a chosen canonical edition still has one maintenance row.
	where += ` AND work.id = COALESCE((SELECT COALESCE(logical.canonical_work_id,
		(SELECT MIN(sibling.work_id) FROM work_edition AS sibling WHERE sibling.logical_work_id = logical.id))
		FROM work_edition AS edition JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE edition.work_id = work.id), work.id)`
	reasons := []string{}
	if options.IncludeNoSource && options.Reason != "metadata" {
		reasons = append(reasons, "("+noSourceWhereClause()+")")
	}
	if options.MetadataWhere != "" && options.Reason != "no_source" {
		reasons = append(reasons, "("+options.MetadataWhere+")")
		args = append(args, options.MetadataArgs...)
	}
	if len(reasons) == 0 {
		reasons = append(reasons, "0")
	}
	where += " AND (" + strings.Join(reasons, " OR ") + ")"
	page := MaintenancePage{RawPage: RawPage{Page: options.Page, PageSize: options.PageSize}, NoSource: map[int64]bool{}}
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM work WHERE "+where, args...).Scan(&page.Total); err != nil {
		return page, err
	}
	works, err := s.ListMatching(ctx, options.UserID, where, args, options.Page, options.PageSize, false)
	if err != nil {
		return page, err
	}
	page.Works = works
	if len(works) == 0 || !options.IncludeNoSource {
		return page, nil
	}
	ids := make([]any, len(works))
	marks := make([]string, len(works))
	for i, work := range works {
		ids[i], marks[i] = work.ID, "?"
	}
	rows, err := s.db.QueryContext(ctx, "SELECT work.id FROM work WHERE work.id IN ("+strings.Join(marks, ",")+") AND "+noSourceWhereClause(), ids...)
	if err != nil {
		return page, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return page, err
		}
		page.NoSource[id] = true
	}
	return page, rows.Err()
}
