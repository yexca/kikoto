package library

import (
	"context"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workcode"
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
	// FilterWhere narrows any view by a further trusted predicate over `work`.
	FilterWhere string
	FilterArgs  []any
}

type MaintenancePage struct {
	RawPage
	// NoSource marks the page's no-source families, only when the options
	// include the no-source reason.
	NoSource map[int64]bool
	// SourceTiers ranks every family on the page: "local" when the Library
	// counts it as local, "remote" when only another source or location is
	// available, and "none" when nothing is.
	SourceTiers map[int64]string
}

// Source tiers in display order: local and remote are healthy, none is not.
const (
	SourceTierLocal  = "local"
	SourceTierRemote = "remote"
	SourceTierNone   = "none"
)

// CountMaintenance counts the families one maintenance view lists, without
// loading them.
func (s *Store) CountMaintenance(ctx context.Context, options MaintenanceOptions) (int, error) {
	s.PrepareSearch(ctx, options.Query)
	where, args := maintenanceWhere(options)
	var total int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM work WHERE "+where, args...).Scan(&total)
	return total, err
}

func (s *Store) ListMaintenance(ctx context.Context, options MaintenanceOptions) (MaintenancePage, error) {
	s.PrepareSearch(ctx, options.Query)
	where, args := maintenanceWhere(options)
	page := MaintenancePage{RawPage: RawPage{Page: options.Page, PageSize: options.PageSize}, NoSource: map[int64]bool{}, SourceTiers: map[int64]string{}}
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM work WHERE "+where, args...).Scan(&page.Total); err != nil {
		return page, err
	}
	works, err := s.ListMatching(ctx, options.UserID, where, args, options.Page, options.PageSize, false)
	if err != nil {
		return page, err
	}
	page.Works = works
	if len(works) == 0 {
		return page, nil
	}
	ids := make([]any, len(works))
	marks := make([]string, len(works))
	for i, work := range works {
		ids[i], marks[i] = work.ID, "?"
	}
	rows, err := s.db.QueryContext(ctx, "SELECT work.id, "+localPresenceWhereClause()+", ("+noSourceWhereClause()+")"+
		" FROM work WHERE work.id IN ("+strings.Join(marks, ",")+")", ids...)
	if err != nil {
		return page, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var local, none bool
		if err := rows.Scan(&id, &local, &none); err != nil {
			return page, err
		}
		switch {
		case local:
			page.SourceTiers[id] = SourceTierLocal
		case none:
			page.SourceTiers[id] = SourceTierNone
		default:
			page.SourceTiers[id] = SourceTierRemote
		}
		page.NoSource[id] = none && options.IncludeNoSource
	}
	return page, rows.Err()
}

// maintenanceWhere selects the families of one maintenance view: one row per
// family, narrowed by the view's reason, search, and further filter.
func maintenanceWhere(options MaintenanceOptions) (string, []any) {
	where, args := listWhere("", "all", options.Query, options.UserID, options.DemoOnly)
	// A family without a chosen canonical edition still has one maintenance row.
	where += ` AND work.id = COALESCE((SELECT COALESCE(logical.canonical_work_id,
		(SELECT MIN(sibling.work_id) FROM work_edition AS sibling WHERE sibling.logical_work_id = logical.id))
		FROM work_edition AS edition JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE edition.work_id = work.id), work.id)`
	// Custom works have their own view; the translation view lists every
	// family, and every other view lists catalog works.
	customWork := "work.primary_code LIKE '" + workcode.CustomPrefix + "%'"
	switch options.Reason {
	case "custom":
		where += " AND " + customWork
	case "translation":
	default:
		where += " AND NOT " + customWork
	}
	// Catalog, custom, and translation list persisted families, including those without pending issues.
	if options.Reason != "catalog" && options.Reason != "custom" && options.Reason != "translation" {
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
	}
	if options.FilterWhere != "" {
		where += " AND (" + options.FilterWhere + ")"
		args = append(args, options.FilterArgs...)
	}
	return where, args
}
