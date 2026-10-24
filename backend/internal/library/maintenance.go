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

// MaintenanceCounts holds the number of families each maintenance view lists.
type MaintenanceCounts struct {
	Catalog  int
	All      int
	Custom   int
	Metadata int
	NoSource int
}

// CountMaintenanceViews counts the families of the catalog, all, custom,
// metadata, and no-source views in one scan, evaluating each family's
// metadata and source predicates once. Reason and search in options are
// ignored; a predicate options leave out counts nothing, so its view and its
// share of the all view are zero.
func (s *Store) CountMaintenanceViews(ctx context.Context, options MaintenanceOptions) (MaintenanceCounts, error) {
	where, args := maintenanceFamilyWhere(ListOptions{UserID: options.UserID, DemoOnly: options.DemoOnly})
	noSource := "0"
	if options.IncludeNoSource {
		noSource = noSourceWhereClause()
	}
	metadata, metadataArgs := "0", []any(nil)
	if options.MetadataWhere != "" {
		metadata, metadataArgs = options.MetadataWhere, options.MetadataArgs
	}
	var counts MaintenanceCounts
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(NOT custom), 0), COALESCE(SUM(NOT custom AND (no_source OR metadata)), 0),
		COALESCE(SUM(custom), 0), COALESCE(SUM(NOT custom AND metadata), 0), COALESCE(SUM(NOT custom AND no_source), 0)
		FROM (SELECT `+customWorkPredicate+` AS custom,
			CASE WHEN `+customWorkPredicate+` THEN 0 ELSE (`+noSource+`) END AS no_source,
			CASE WHEN `+customWorkPredicate+` THEN 0 ELSE (`+metadata+`) END AS metadata
			FROM work WHERE `+where+`)`, append(append([]any{}, metadataArgs...), args...)...).Scan(
		&counts.Catalog, &counts.All, &counts.Custom, &counts.Metadata, &counts.NoSource)
	return counts, err
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
	where, args := maintenanceFamilyWhere(options.ListOptions)
	// Custom works have their own view; the translation view lists every
	// family, and every other view lists catalog works.
	switch options.Reason {
	case "custom":
		where += " AND " + customWorkPredicate
	case "translation":
	default:
		where += " AND NOT " + customWorkPredicate
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

const customWorkPredicate = "work.primary_code LIKE '" + workcode.CustomPrefix + "%'"

// maintenanceFamilyWhere selects one representative row per family, matching
// the Library's search, before any view narrows it.
func maintenanceFamilyWhere(options ListOptions) (string, []any) {
	where, args := listWhere("", "all", options.Query, options.UserID, options.DemoOnly)
	// A family without a chosen canonical edition still has one maintenance row.
	where += ` AND work.id = COALESCE((SELECT COALESCE(logical.canonical_work_id,
		(SELECT MIN(sibling.work_id) FROM work_edition AS sibling WHERE sibling.logical_work_id = logical.id))
		FROM work_edition AS edition JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE edition.work_id = work.id), work.id)`
	return where, args
}
