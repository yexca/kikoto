package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
)

// Circle reads keep SQL projection, availability aggregation, and catalog
// presentation behind the HTTP composition layer. This file loads one
// circle's detail and series; circle_summaries.go builds the circle list,
// circle_stats.go counts a circle's works and sources, and
// circle_works_page.go pages a circle's catalog works.

var errCircleNotVisible = errors.New("circle not visible")

func (s *Server) loadCircleDetail(ctx context.Context, userID int64, externalID string) (circleDetail, error) {
	return s.loadCircleDetailWithWorksQuery(ctx, userID, externalID, circleWorksQuery{Page: 1, PageSize: 100, Availability: "all", Legacy: true})
}

func (s *Server) loadCircleDetailWithWorksQuery(ctx context.Context, userID int64, externalID string, worksQuery circleWorksQuery) (circleDetail, error) {
	partyID, err := s.findCircle(ctx, externalID)
	if err != nil {
		return circleDetail{}, err
	}
	visible, err := s.circlePartyVisible(ctx, partyID)
	if err != nil {
		return circleDetail{}, err
	}
	if !visible {
		return circleDetail{}, errCircleNotVisible
	}
	if s.cfg.IsDemo() {
		eligible, err := s.demoCircleEligible(ctx, partyID)
		if err != nil {
			return circleDetail{}, err
		}
		if !eligible {
			return circleDetail{}, errCircleNotVisible
		}
	}
	summary, err := s.loadCircleSummary(ctx, userID, partyID)
	if err != nil {
		return circleDetail{}, err
	}
	works, worksTotal, err := s.loadCircleWorksPage(ctx, userID, partyID, worksQuery)
	if err != nil {
		return circleDetail{}, err
	}
	availableWorks, err := s.loadCircleAvailableWorks(ctx, partyID)
	if err != nil {
		return circleDetail{}, err
	}
	series, err := s.loadCircleSeries(ctx, partyID)
	if err != nil {
		return circleDetail{}, err
	}
	var refresh *creatorRefreshRun
	if latest, ok, err := s.latestCircleCatalogSyncRun(ctx, externalID, false); err != nil {
		return circleDetail{}, err
	} else if ok {
		refresh = &latest
	}
	hasMore := worksQuery.Page*worksQuery.PageSize < worksTotal
	return circleDetail{
		circleSummary:  summary,
		AvailableWorks: availableWorks,
		Works:          works,
		WorksMeta: circleWorksMeta{
			Page:      worksQuery.Page,
			PageSize:  worksQuery.PageSize,
			Loaded:    len(works),
			Total:     worksTotal,
			HasMore:   hasMore,
			Truncated: worksQuery.Legacy && hasMore,
		},
		Series:  series,
		Refresh: refresh,
	}, nil
}

func (s *Server) circlePartyVisible(ctx context.Context, partyID int64) (bool, error) {
	var visible bool
	query := "SELECT " + circlePartyVisibilityPredicate("party.id") + " FROM party WHERE party.id = ?"
	err := s.db.QueryRowContext(ctx, query, partyID).Scan(&visible)
	return visible, err
}

func (s *Server) demoCircleEligible(ctx context.Context, partyID int64) (bool, error) {
	if !s.cfg.IsDemo() {
		return true, nil
	}
	var eligible bool
	err := s.db.QueryRowContext(ctx, `
		SELECT
			EXISTS (
				SELECT 1
				FROM work_party AS relation
				INNER JOIN work AS demo_work ON demo_work.id = relation.work_id
				WHERE relation.party_id = ?
					AND relation.role = 'circle'
					AND `+contentpolicy.DemoEligibleWorkSQL("demo_work")+`
			)
			OR EXISTS (
				SELECT 1
				FROM `+circleCatalogProjection+` AS catalog
				INNER JOIN work AS demo_work ON UPPER(demo_work.primary_code) = UPPER(catalog.primary_code)
				WHERE catalog.party_id = ?
					AND `+contentpolicy.DemoEligibleWorkSQL("demo_work")+`
			)
	`, partyID, partyID).Scan(&eligible)
	return eligible, err
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func (s *Server) loadCircleSeries(ctx context.Context, partyID int64) ([]circleSeries, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			series.id,
			series.title_id,
			series.name,
			series.url,
			series.declared_works,
			COUNT(series_work.primary_code),
			COALESCE(SUM(CASE WHEN local_presence.primary_code IS NOT NULL THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN remote_presence.primary_code IS NOT NULL THEN 1 ELSE 0 END), 0),
			GROUP_CONCAT(series_work.primary_code, ',')
		FROM party_series AS series
		LEFT JOIN party_series_work AS series_work ON series_work.series_id = series.id
		LEFT JOIN (
			SELECT DISTINCT UPPER(work.primary_code) AS primary_code
			FROM work
			INNER JOIN media_item AS item ON item.work_id = work.id
			INNER JOIN media_file_location AS location ON location.media_item_id = item.id
			WHERE location.location_type IN ('local', 'cache')
				AND location.availability = 'available'
		) AS local_presence ON local_presence.primary_code = UPPER(series_work.primary_code)
		LEFT JOIN (
			SELECT DISTINCT UPPER(code.primary_code) AS primary_code
			FROM (
				SELECT item.primary_code
				FROM `+circleCatalogProjection+` AS item
				INNER JOIN metadata_provider AS provider ON provider.id = item.provider_id
				WHERE item.party_id = ? AND provider.code != 'dlsite'
				UNION
				SELECT work.primary_code
				FROM work_source_presence AS presence
				INNER JOIN work ON work.id = presence.work_id
				WHERE presence.availability = 'available'
			) AS code
		) AS remote_presence ON remote_presence.primary_code = UPPER(series_work.primary_code)
		WHERE series.party_id = ?
		GROUP BY series.id
		ORDER BY series.last_seen_at DESC, series.id DESC
	`, partyID, partyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []circleSeries{}
	for rows.Next() {
		var item circleSeries
		var seriesID int64
		var codes sql.NullString
		if err := rows.Scan(&seriesID, &item.TitleID, &item.Name, &item.URL, &item.DeclaredWorks, &item.Works, &item.LocalWorks, &item.RemoteWorks, &codes); err != nil {
			return nil, err
		}
		item.WorkCodes = splitCatalogCodes(codes.String)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Demo eligibility queries per code, so release the cursor's pooled
	// connection before filtering.
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range items {
		item := &items[index]
		if s.cfg.IsDemo() {
			filteredCodes := make([]string, 0, len(item.WorkCodes))
			for _, code := range item.WorkCodes {
				eligible, err := s.demoWorkCodeEligible(ctx, code)
				if err != nil {
					return nil, err
				}
				if eligible {
					filteredCodes = append(filteredCodes, code)
				}
			}
			item.WorkCodes = filteredCodes
			item.Works = len(filteredCodes)
			item.DeclaredWorks = item.Works
			item.LocalWorks = min(item.LocalWorks, item.Works)
			item.RemoteWorks = min(item.RemoteWorks, item.Works-item.LocalWorks)
		}
		item.MissingWorks = maxInt(0, item.Works-item.LocalWorks-item.RemoteWorks)
	}
	return items, nil
}

func splitCatalogCodes(raw string) []string {
	codes := []string{}
	seen := map[string]bool{}
	for _, value := range strings.Split(raw, ",") {
		code := strings.ToUpper(strings.TrimSpace(value))
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
	}
	return codes
}
