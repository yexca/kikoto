package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// Circle reads keep SQL projection, availability aggregation, and catalog
// presentation together behind the HTTP composition layer.

func (s *Server) loadCircleSummaries(ctx context.Context, userID int64) ([]circleSummary, error) {
	demoWhere := ""
	if s.cfg.IsDemo() {
		demoWhere = `
			AND (
				EXISTS (
					SELECT 1
					FROM work_party AS demo_relation
					INNER JOIN work AS demo_work ON demo_work.id = demo_relation.work_id
					WHERE demo_relation.party_id = party.id
						AND demo_relation.role = 'circle'
						AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
				)
				OR EXISTS (
					SELECT 1
					FROM ` + circleCatalogProjection + ` AS demo_catalog
					INNER JOIN work AS demo_work ON UPPER(demo_work.primary_code) = UPPER(demo_catalog.primary_code)
					WHERE demo_catalog.party_id = party.id
						AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
				)
			)
		`
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			party.id,
			external.external_id,
			party.display_name,
			state.rating,
			COALESCE(state.note, ''),
			COALESCE(state.favorite, 0),
			(
				SELECT refresh.last_success_at
				FROM party_catalog_refresh_state AS refresh
				WHERE refresh.party_id = party.id AND refresh.provider_code = 'dlsite'
			) AS last_synced_at,
			(
				SELECT refresh.last_attempt_at
				FROM party_catalog_refresh_state AS refresh
				WHERE refresh.party_id = party.id AND refresh.provider_code = 'dlsite'
			) AS last_attempt_at
		FROM party
		INNER JOIN party_external_id AS external ON external.party_id = party.id
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		LEFT JOIN user_party_state AS state ON state.party_id = party.id AND state.user_id = ?
		WHERE party.party_type IN ('circle', 'brand', 'maker')
			AND provider.code = 'dlsite'
			AND external.id_type = 'maker_id'
			AND external.id = (
				SELECT chosen.id FROM party_external_id AS chosen
				WHERE chosen.party_id = party.id AND chosen.provider_id = provider.id AND chosen.id_type = 'maker_id'
				ORDER BY chosen.is_primary DESC, chosen.id LIMIT 1
			)
			AND `+circlePartyVisibilityPredicate("party.id")+`
			`+demoWhere+`
		ORDER BY party.display_name ASC
	`, userID)
	if err != nil {
		return nil, err
	}

	items := []circleSummary{}
	partyIDs := []int64{}
	for rows.Next() {
		var item circleSummary
		var rating sql.NullInt64
		var favorite int
		var lastSynced, lastAttempt sql.NullString
		if err := rows.Scan(&item.ID, &item.ExternalID, &item.DisplayName, &rating, &item.Note, &favorite, &lastSynced, &lastAttempt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		item.Rating = nullableIntPointer(rating)
		item.Favorite = favorite != 0
		item.LastSyncedAt = sqlutil.String(lastSynced)
		item.lastAttemptAt = sqlutil.String(lastAttempt)
		item.Aliases = []string{}
		item.UserTags = []voiceUserTag{}
		item.SourceSummaries = []circleSourceStat{}
		items = append(items, item)
		partyIDs = append(partyIDs, item.ID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := s.fillCircleStatsBatch(ctx, items, partyIDs); err != nil {
		return nil, err
	}
	tagsByParty, err := s.loadCircleUserTagsBatch(ctx, userID, partyIDs)
	if err != nil {
		return nil, err
	}
	latestByParty, err := s.loadCircleLatestWorks(ctx, partyIDs)
	if err != nil {
		return nil, err
	}
	aliasesByParty, err := s.loadCircleAliasesBatch(ctx)
	if err != nil {
		return nil, err
	}
	for index := range items {
		if aliases := aliasesByParty[items[index].ID]; aliases != nil {
			items[index].Aliases = aliases
		}
		if tags := tagsByParty[items[index].ID]; tags != nil {
			items[index].UserTags = tags
		}
		items[index].LatestWork = latestByParty[items[index].ID]
	}
	return items, nil
}

func (s *Server) circleSummaryPage(ctx context.Context, userID int64, query, filter string, page, pageSize int) (circleSummaryPage, error) {
	items, err := s.loadCircleSummaries(ctx, userID)
	if err != nil {
		return circleSummaryPage{}, err
	}
	items = filterCircleSummaries(items, query, filter)
	catalogWorks := 0
	availableWorks := 0
	for _, item := range items {
		catalogWorks += item.CatalogWorks
		availableWorks += item.PlayableWorks
	}
	page, start, end := creatorPageBounds(page, pageSize, len(items))
	pageItems := items[start:end]
	for index := range pageItems {
		if pageItems[index].LatestWork != nil {
			pageItems[index].LatestWork.CoverURL = s.coverURL(pageItems[index].LatestWork.PrimaryCode)
		}
	}
	return circleSummaryPage{
		Circles: pageItems, Page: page, PageSize: minInt(pageSize, 100), Total: len(items),
		CatalogWorks: catalogWorks, AvailableWorks: availableWorks,
	}, nil
}

var errCircleNotVisible = errors.New("circle not visible")

func (s *Server) loadCircleDetail(ctx context.Context, userID int64, externalID string) (circleDetail, error) {
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
	works, err := s.loadCircleWorks(ctx, userID, partyID)
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
	if latest, ok, err := s.latestCircleFollowRun(ctx, externalID, false); err != nil {
		return circleDetail{}, err
	} else if ok {
		refresh = &latest
	}
	return circleDetail{
		circleSummary:  summary,
		AvailableWorks: availableWorks,
		Works:          works,
		Series:         series,
		Refresh:        refresh,
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

func (s *Server) loadCircleSummary(ctx context.Context, userID int64, partyID int64) (circleSummary, error) {
	var item circleSummary
	var rating sql.NullInt64
	var favorite int
	var lastSynced, lastAttempt sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			party.id,
			external.external_id,
			party.display_name,
			state.rating,
			COALESCE(state.note, ''),
			COALESCE(state.favorite, 0),
			(
				SELECT refresh.last_success_at
				FROM party_catalog_refresh_state AS refresh
				WHERE refresh.party_id = party.id AND refresh.provider_code = 'dlsite'
			) AS last_synced_at,
			(
				SELECT refresh.last_attempt_at
				FROM party_catalog_refresh_state AS refresh
				WHERE refresh.party_id = party.id AND refresh.provider_code = 'dlsite'
			) AS last_attempt_at
		FROM party
		INNER JOIN party_external_id AS external ON external.party_id = party.id
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		LEFT JOIN user_party_state AS state ON state.party_id = party.id AND state.user_id = ?
		WHERE party.id = ? AND provider.code = 'dlsite' AND external.id_type = 'maker_id' ORDER BY external.is_primary DESC,external.id LIMIT 1
	`, userID, partyID).Scan(&item.ID, &item.ExternalID, &item.DisplayName, &rating, &item.Note, &favorite, &lastSynced, &lastAttempt); err != nil {
		return circleSummary{}, err
	}
	item.Rating = nullableIntPointer(rating)
	item.Favorite = favorite != 0
	item.LastSyncedAt = sqlutil.String(lastSynced)
	item.lastAttemptAt = sqlutil.String(lastAttempt)
	aliases, err := s.loadCircleAliases(ctx, partyID)
	if err != nil {
		return circleSummary{}, err
	}
	item.Aliases = aliases
	tags, err := s.loadCircleUserTags(ctx, userID, item.ID)
	if err != nil {
		return circleSummary{}, err
	}
	item.UserTags = tags
	if err := s.fillCircleStats(ctx, userID, &item); err != nil {
		return circleSummary{}, err
	}
	latestByParty, err := s.loadCircleLatestWorks(ctx, []int64{item.ID})
	if err != nil {
		return circleSummary{}, err
	}
	item.LatestWork = latestByParty[item.ID]
	if item.LatestWork != nil {
		item.LatestWork.CoverURL = s.coverURL(item.LatestWork.PrimaryCode)
	}
	return item, nil
}

// loadCircleAvailableWorks counts unique catalog works with at least one
// available local, cached, remote, or tracked-source representation. The
// catalog may contain multiple editions and remote sources, so availability
// must be unioned by the logical work code rather than summed by source.
func (s *Server) loadCircleAvailableWorks(ctx context.Context, partyID int64) (int, error) {
	counts, err := s.loadCircleAvailableWorkCounts(ctx, []int64{partyID})
	return counts[partyID], err
}

func (s *Server) loadCircleAvailableWorkCounts(ctx context.Context, partyIDs []int64) (map[int64]int, error) {
	result := map[int64]int{}
	if len(partyIDs) == 0 {
		return result, nil
	}
	demoCatalogWhere := ""
	demoMediaWhere := ""
	demoPresenceWhere := ""
	demoRemoteCatalogWhere := ""
	if s.cfg.IsDemo() {
		demoCatalogWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("catalog_work")
		demoMediaWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("media_work")
		demoPresenceWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("presence_work")
		demoRemoteCatalogWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("remote_work")
	}

	err := s.queryInt64Batches(ctx, `
		WITH catalog_codes AS (
			SELECT DISTINCT catalog.party_id, UPPER(COALESCE(catalog_logical.canonical_code, catalog.primary_code)) AS code
			FROM `+circleCatalogProjection+` AS catalog
			LEFT JOIN work AS catalog_work ON UPPER(catalog_work.primary_code) = UPPER(catalog.primary_code)
			LEFT JOIN work_edition AS catalog_edition ON catalog_edition.work_id = catalog_work.id
			LEFT JOIN logical_work AS catalog_logical ON catalog_logical.id = catalog_edition.logical_work_id
			WHERE catalog.party_id IN (%s)
			`+demoCatalogWhere+`
		), available_media_codes AS (
			SELECT DISTINCT UPPER(COALESCE(media_logical.canonical_code, media_work.primary_code)) AS code
			FROM work AS media_work
			LEFT JOIN work_edition AS media_edition ON media_edition.work_id = media_work.id
			LEFT JOIN logical_work AS media_logical ON media_logical.id = media_edition.logical_work_id
			INNER JOIN media_item AS media_item ON media_item.work_id = media_work.id
			INNER JOIN media_file_location AS media_location ON media_location.media_item_id = media_item.id
			WHERE media_location.availability = 'available'
			`+demoMediaWhere+`
		), available_presence_codes AS (
			SELECT DISTINCT UPPER(COALESCE(presence_logical.canonical_code, presence_work.primary_code)) AS code
			FROM work AS presence_work
			LEFT JOIN work_edition AS presence_edition ON presence_edition.work_id = presence_work.id
			LEFT JOIN logical_work AS presence_logical ON presence_logical.id = presence_edition.logical_work_id
			INNER JOIN work_source_presence AS presence ON presence.work_id = presence_work.id
			INNER JOIN file_source AS presence_source ON presence_source.id = presence.file_source_id
			WHERE presence.presence_type = 'source'
				AND presence.availability = 'available'
				AND presence_source.enabled = 1
			`+demoPresenceWhere+`
		), available_remote_catalog_codes AS (
			SELECT DISTINCT remote_catalog.party_id, UPPER(COALESCE(remote_logical.canonical_code, remote_catalog.primary_code)) AS code
			FROM `+circleCatalogProjection+` AS remote_catalog
			INNER JOIN metadata_provider AS remote_provider ON remote_provider.id = remote_catalog.provider_id
			INNER JOIN file_source AS remote_source ON remote_provider.code = 'kikoeru_source_' || remote_source.code
			LEFT JOIN work AS remote_work ON UPPER(remote_work.primary_code) = UPPER(remote_catalog.primary_code)
			LEFT JOIN work_edition AS remote_edition ON remote_edition.work_id = remote_work.id
			LEFT JOIN logical_work AS remote_logical ON remote_logical.id = remote_edition.logical_work_id
			WHERE remote_catalog.party_id IN (SELECT party_id FROM catalog_codes)
				AND remote_source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
				AND remote_source.enabled = 1
			`+demoRemoteCatalogWhere+`
		)
		SELECT catalog.party_id, COUNT(*)
		FROM catalog_codes AS catalog
		WHERE catalog.code IN (SELECT code FROM available_media_codes)
			OR catalog.code IN (SELECT code FROM available_presence_codes)
			OR EXISTS (
				SELECT 1
				FROM available_remote_catalog_codes AS remote
				WHERE remote.party_id = catalog.party_id AND remote.code = catalog.code
		)
		GROUP BY catalog.party_id
	`, partyIDs, nil, func(rows *sql.Rows) error {
		var partyID int64
		var count int
		if err := rows.Scan(&partyID, &count); err != nil {
			return err
		}
		result[partyID] = count
		return nil
	})
	return result, err
}

func (s *Server) fillCircleStats(ctx context.Context, userID int64, item *circleSummary) error {
	setCircleSyncState(item, s.catalogFreshnessDays(ctx), time.Now().UTC())
	demoWhere := ""
	if s.cfg.IsDemo() {
		demoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	var catalogWorks int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(DISTINCT COALESCE(logical.canonical_code, catalog.primary_code))
		FROM `+circleCatalogProjection+` AS catalog
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE catalog.party_id = ?
			`+demoWhere+`
	`, item.ID).Scan(&catalogWorks); err != nil {
		return err
	}
	item.CatalogWorks = catalogWorks
	stats, err := s.circleSourceStats(ctx, item.ID)
	if err != nil {
		return err
	}
	item.SourceSummaries = stats
	for _, stat := range stats {
		switch stat.Key {
		case "local":
			item.LocalWorks = stat.Count
		case "remote":
			item.RemoteWorks += stat.Count
		}
	}
	availableWorks, err := s.loadCircleAvailableWorks(ctx, item.ID)
	if err != nil {
		return err
	}
	item.PlayableWorks = availableWorks
	item.MissingWorks = catalogWorks - item.PlayableWorks
	if item.MissingWorks < 0 {
		item.MissingWorks = 0
	}
	return nil
}

func setCircleSyncState(item *circleSummary, freshnessDays int, now time.Time) {
	lastSuccessAt := ""
	if item.LastSyncedAt != nil {
		lastSuccessAt = *item.LastSyncedAt
	}
	lastAttemptAt := ""
	if item.lastAttemptAt != nil {
		lastAttemptAt = *item.lastAttemptAt
	}
	item.SyncState, item.SyncReason = catalogFreshnessState(lastSuccessAt, lastAttemptAt, freshnessDays, now)
}

func (s *Server) fillCircleStatsBatch(ctx context.Context, items []circleSummary, partyIDs []int64) error {
	if len(items) == 0 {
		return nil
	}
	byID := circleSummaryByID(items)
	catalogCounts, err := s.loadCircleCatalogCounts(ctx, partyIDs)
	if err != nil {
		return err
	}
	applyCircleSummaryCounts(byID, catalogCounts, func(item *circleSummary, count int) { item.CatalogWorks = count })
	localCounts, remoteCounts, err := s.loadCircleAvailabilityCounts(ctx, partyIDs)
	if err != nil {
		return err
	}
	availableCounts, err := s.loadCircleAvailableWorkCounts(ctx, partyIDs)
	if err != nil {
		return err
	}
	applyCircleSummaryCounts(byID, localCounts, func(item *circleSummary, count int) { item.LocalWorks = count })
	applyCircleSummaryCounts(byID, remoteCounts, func(item *circleSummary, count int) { item.RemoteWorks = count })
	finalizeCircleStatsBatch(items, availableCounts, s.catalogFreshnessDays(ctx), time.Now().UTC())
	return nil
}

func circleSummaryByID(items []circleSummary) map[int64]*circleSummary {
	byID := make(map[int64]*circleSummary, len(items))
	for index := range items {
		byID[items[index].ID] = &items[index]
	}
	return byID
}

func applyCircleSummaryCounts(byID map[int64]*circleSummary, counts map[int64]int, apply func(*circleSummary, int)) {
	for partyID, count := range counts {
		if item := byID[partyID]; item != nil {
			apply(item, count)
		}
	}
}

func finalizeCircleStatsBatch(items []circleSummary, availableCounts map[int64]int, freshnessDays int, now time.Time) {
	for index := range items {
		items[index].PlayableWorks = availableCounts[items[index].ID]
		items[index].MissingWorks = items[index].CatalogWorks - items[index].PlayableWorks
		if items[index].MissingWorks < 0 {
			items[index].MissingWorks = 0
		}
		setCircleSyncState(&items[index], freshnessDays, now)
		if items[index].LocalWorks > 0 {
			items[index].SourceSummaries = append(items[index].SourceSummaries, circleSourceStat{
				Key: "local", DisplayName: "Local", Status: "available", Count: items[index].LocalWorks,
			})
		}
		if items[index].RemoteWorks > 0 {
			items[index].SourceSummaries = append(items[index].SourceSummaries, circleSourceStat{
				Key: "remote", DisplayName: "Remote", Status: "available", Count: items[index].RemoteWorks,
			})
		}
	}
}

func filterCircleSummaries(items []circleSummary, query string, filter string) []circleSummary {
	needle := strings.ToLower(strings.TrimSpace(query))
	filter = strings.ToLower(strings.TrimSpace(filter))
	filtered := make([]circleSummary, 0, len(items))
	for _, item := range items {
		if !circleSummaryMatchesQuery(item, needle) {
			continue
		}
		if circleSummaryMatchesFilter(item, filter) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func circleSummaryMatchesQuery(item circleSummary, needle string) bool {
	if needle == "" || strings.Contains(strings.ToLower(item.ExternalID), needle) || strings.Contains(strings.ToLower(item.DisplayName), needle) {
		return true
	}
	for _, alias := range item.Aliases {
		if strings.Contains(strings.ToLower(alias), needle) {
			return true
		}
	}
	for _, tag := range item.UserTags {
		if strings.Contains(strings.ToLower(tag.Name), needle) {
			return true
		}
	}
	if item.LatestWork == nil {
		return false
	}
	return strings.Contains(strings.ToLower(item.LatestWork.PrimaryCode), needle) || strings.Contains(strings.ToLower(item.LatestWork.Title), needle)
}

func circleSummaryMatchesFilter(item circleSummary, filter string) bool {
	switch filter {
	case "favorite":
		return item.Favorite
	case "tagged":
		return len(item.UserTags) > 0
	case "available":
		return item.PlayableWorks > 0 || item.LocalWorks > 0 || item.RemoteWorks > 0
	case "local":
		return item.LocalWorks > 0
	case "remote":
		return item.RemoteWorks > 0
	case "missing":
		return item.MissingWorks > 0
	case "attention", "stale":
		return item.SyncState == catalogSyncAttention
	default:
		return true
	}
}

func (s *Server) loadCircleLatestWorks(ctx context.Context, partyIDs []int64) (map[int64]*creatorLatestWork, error) {
	result := map[int64]*creatorLatestWork{}
	if len(partyIDs) == 0 {
		return result, nil
	}
	catalogDemoWhere := ""
	relationDemoWhere := ""
	if s.cfg.IsDemo() {
		catalogDemoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
		relationDemoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	err := s.queryInt64Batches(ctx, `
		WITH selected_parties AS (SELECT id FROM party WHERE id IN (%s)), candidates AS (
			SELECT
				catalog.party_id,
				UPPER(COALESCE(logical.canonical_code, catalog.primary_code)) AS primary_code,
				COALESCE(NULLIF(canonical_work.title, ''), NULLIF(work.title, ''), NULLIF(catalog.title, ''), UPPER(catalog.primary_code)) AS title,
				COALESCE(canonical_work.release_date, work.release_date, catalog.release_date) AS release_date
			FROM `+circleCatalogProjection+` AS catalog
			INNER JOIN selected_parties ON selected_parties.id = catalog.party_id
			INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id AND provider.code = 'dlsite'
			LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
			LEFT JOIN work_edition AS edition ON edition.work_id = work.id
			LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			LEFT JOIN work AS canonical_work ON canonical_work.id = logical.canonical_work_id
			WHERE 1 = 1
				`+catalogDemoWhere+`
			UNION ALL
			SELECT
				relation.party_id,
				UPPER(work.primary_code),
				work.title,
				work.release_date
			FROM work_primary_circle AS relation
			INNER JOIN selected_parties ON selected_parties.id = relation.party_id
			INNER JOIN work ON work.id = relation.work_id
			WHERE relation.role = 'circle'
				`+relationDemoWhere+`
				AND NOT EXISTS (
					SELECT 1
					FROM `+circleCatalogProjection+` AS catalog
					INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id AND provider.code = 'dlsite'
					WHERE catalog.party_id = relation.party_id AND UPPER(catalog.primary_code) = UPPER(work.primary_code)
				)
		), ranked AS (
			SELECT *, ROW_NUMBER() OVER (
				PARTITION BY party_id
				ORDER BY COALESCE(release_date, '') DESC, primary_code DESC
			) AS position
			FROM candidates
		)
		SELECT party_id, primary_code, title, release_date
		FROM ranked
		WHERE position = 1
	`, partyIDs, nil, func(rows *sql.Rows) error {
		var partyID int64
		var item creatorLatestWork
		var releaseDate sql.NullString
		if err := rows.Scan(&partyID, &item.PrimaryCode, &item.Title, &releaseDate); err != nil {
			return err
		}
		item.ReleaseDate = sqlutil.String(releaseDate)
		result[partyID] = &item
		return nil
	})
	return result, err
}

func (s *Server) loadCircleCatalogCounts(ctx context.Context, partyIDs []int64) (map[int64]int, error) {
	demoWhere := ""
	if s.cfg.IsDemo() {
		demoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	result := map[int64]int{}
	err := s.queryInt64Batches(ctx, `
		SELECT catalog.party_id, COUNT(DISTINCT COALESCE(logical.canonical_code, catalog.primary_code))
		FROM `+circleCatalogProjection+` AS catalog
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE catalog.party_id IN (%s)
			`+demoWhere+`
		GROUP BY catalog.party_id
	`, partyIDs, nil, func(rows *sql.Rows) error {
		var partyID int64
		var count int
		if err := rows.Scan(&partyID, &count); err != nil {
			return err
		}
		result[partyID] = count
		return nil
	})
	return result, err
}

func (s *Server) loadCircleAvailabilityCounts(ctx context.Context, partyIDs []int64) (map[int64]int, map[int64]int, error) {
	demoWhere := circleAvailabilityDemoWhere(s.cfg.IsDemo())
	localCounts, remoteCounts, err := s.loadCircleMediaAvailabilityCounts(ctx, partyIDs, demoWhere)
	if err != nil {
		return nil, nil, err
	}
	catalogCounts, err := s.loadCircleCatalogAvailabilityCounts(ctx, partyIDs, demoWhere)
	if err != nil {
		return nil, nil, err
	}
	mergeCircleAvailabilityCounts(remoteCounts, catalogCounts)
	presenceCounts, err := s.loadCirclePresenceAvailabilityCounts(ctx, partyIDs, demoWhere)
	if err != nil {
		return nil, nil, err
	}
	mergeCircleAvailabilityCounts(remoteCounts, presenceCounts)
	return localCounts, remoteCounts, nil
}

func circleAvailabilityDemoWhere(isDemo bool) string {
	if !isDemo {
		return ""
	}
	return " AND " + contentpolicy.DemoEligibleWorkSQL("work")
}

func (s *Server) loadCircleMediaAvailabilityCounts(ctx context.Context, partyIDs []int64, demoWhere string) (map[int64]int, map[int64]int, error) {
	localCounts := map[int64]int{}
	remoteCounts := map[int64]int{}
	err := s.queryInt64Batches(ctx, `
		SELECT relation.party_id, location.location_type, COUNT(DISTINCT COALESCE(logical.canonical_code, work.primary_code))
		FROM work_primary_circle AS relation
		INNER JOIN work ON work.id = relation.work_id
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE relation.party_id IN (%s)
			AND location.availability = 'available'
			`+demoWhere+`
		GROUP BY relation.party_id, location.location_type
	`, partyIDs, nil, func(rows *sql.Rows) error {
		var partyID int64
		var locationType string
		var count int
		if err := rows.Scan(&partyID, &locationType, &count); err != nil {
			return err
		}
		if locationType == "local" {
			localCounts[partyID] += count
		} else {
			remoteCounts[partyID] += count
		}
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	return localCounts, remoteCounts, nil
}

func (s *Server) loadCircleCatalogAvailabilityCounts(ctx context.Context, partyIDs []int64, demoWhere string) (map[int64]int, error) {
	counts := map[int64]int{}
	err := s.queryInt64Batches(ctx, `
		SELECT catalog.party_id, COUNT(DISTINCT COALESCE(logical.canonical_code, catalog.primary_code))
		FROM `+circleCatalogProjection+` AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		INNER JOIN file_source AS source ON provider.code = 'kikoeru_source_' || source.code
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE catalog.party_id IN (%s)
			AND source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
			AND source.enabled = 1
			`+demoWhere+`
		GROUP BY catalog.party_id
	`, partyIDs, nil, func(rows *sql.Rows) error {
		var partyID int64
		var count int
		if err := rows.Scan(&partyID, &count); err != nil {
			return err
		}
		counts[partyID] = count
		return nil
	})
	if err != nil {
		return nil, err
	}
	return counts, nil
}

func (s *Server) loadCirclePresenceAvailabilityCounts(ctx context.Context, partyIDs []int64, demoWhere string) (map[int64]int, error) {
	counts := map[int64]int{}
	err := s.queryInt64Batches(ctx, `
		SELECT relation.party_id, COUNT(DISTINCT COALESCE(logical.canonical_code, work.primary_code))
		FROM work_primary_circle AS relation
		INNER JOIN work ON work.id = relation.work_id
		INNER JOIN work_source_presence AS presence ON presence.work_id = work.id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE relation.party_id IN (%s)
			AND presence.presence_type = 'source'
			AND presence.availability = 'available'
			AND source.enabled = 1
			`+demoWhere+`
		GROUP BY relation.party_id
	`, partyIDs, nil, func(rows *sql.Rows) error {
		var partyID int64
		var count int
		if err := rows.Scan(&partyID, &count); err != nil {
			return err
		}
		counts[partyID] = count
		return nil
	})
	if err != nil {
		return nil, err
	}
	return counts, nil
}

func mergeCircleAvailabilityCounts(target, candidate map[int64]int) {
	for partyID, count := range candidate {
		if count > target[partyID] {
			target[partyID] = count
		}
	}
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func (s *Server) circleSourceStats(ctx context.Context, partyID int64) ([]circleSourceStat, error) {
	combined, err := s.loadCircleMediaSourceStats(ctx, partyID)
	if err != nil {
		return nil, err
	}
	if err := s.mergeCircleCatalogSourceStats(ctx, partyID, combined); err != nil {
		return nil, err
	}
	return finalizeCircleSourceStats(combined), nil
}

func (s *Server) loadCircleMediaSourceStats(ctx context.Context, partyID int64) (map[string]circleSourceStat, error) {
	demoWhere := ""
	if s.cfg.IsDemo() {
		demoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, location.location_type, COUNT(DISTINCT COALESCE(logical.canonical_code, work.primary_code))
		FROM work_primary_circle AS relation
		INNER JOIN work ON work.id = relation.work_id
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE relation.party_id = ?
			AND location.availability = 'available'
			`+demoWhere+`
		GROUP BY source.id, source.display_name, location.location_type
		ORDER BY source.display_name ASC
	`, partyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	combined := map[string]circleSourceStat{}
	for rows.Next() {
		var sourceID int64
		var sourceName, locationType string
		var count int
		if err := rows.Scan(&sourceID, &sourceName, &locationType, &count); err != nil {
			return nil, err
		}
		key := "remote"
		display := sourceName
		if locationType == "local" {
			key = "local"
			display = "Local"
		}
		statKey := key
		if key == "remote" {
			statKey = fmt.Sprintf("source:%d", sourceID)
		}
		stat := combined[statKey]
		if stat.Key == "" {
			stat = circleSourceStat{Key: statKey, DisplayName: display, Status: "available"}
			if key == "remote" {
				stat.SourceID = &sourceID
			} else {
				stat.SourceID = nil
			}
		}
		stat.Count += count
		combined[statKey] = stat
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return combined, nil
}

func (s *Server) mergeCircleCatalogSourceStats(ctx context.Context, partyID int64, combined map[string]circleSourceStat) error {
	demoWhere := ""
	if s.cfg.IsDemo() {
		demoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	remoteRows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, COUNT(DISTINCT COALESCE(logical.canonical_code, catalog.primary_code))
		FROM `+circleCatalogProjection+` AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		INNER JOIN file_source AS source ON provider.code = 'kikoeru_source_' || source.code
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE catalog.party_id = ?
			AND source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
			AND source.enabled = 1
			`+demoWhere+`
		GROUP BY source.id, source.display_name
	`, partyID)
	if err != nil {
		return err
	}
	defer remoteRows.Close()
	for remoteRows.Next() {
		var sourceID int64
		var sourceName string
		var count int
		if err := remoteRows.Scan(&sourceID, &sourceName, &count); err != nil {
			return err
		}
		statKey := fmt.Sprintf("source:%d", sourceID)
		stat := combined[statKey]
		if stat.Key == "" {
			stat = circleSourceStat{Key: statKey, SourceID: &sourceID, DisplayName: sourceName, Status: "available"}
		}
		if count > stat.Count {
			stat.Count = count
		}
		combined[statKey] = stat
	}
	if err := remoteRows.Err(); err != nil {
		return err
	}
	return nil
}

func finalizeCircleSourceStats(combined map[string]circleSourceStat) []circleSourceStat {
	result := []circleSourceStat{}
	remoteTotal := 0
	for _, stat := range combined {
		if stat.SourceID != nil {
			remoteTotal += stat.Count
		}
		result = append(result, stat)
	}
	if remoteTotal > 0 {
		result = append([]circleSourceStat{{Key: "remote", DisplayName: "Remote", Status: "available", Count: remoteTotal}}, result...)
	}
	return result
}

func (s *Server) loadCircleWorks(ctx context.Context, userID int64, partyID int64) ([]circleCatalogWork, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH projected_codes AS (
			SELECT DISTINCT
				catalog.primary_code,
				UPPER(COALESCE(catalog_logical.canonical_code, catalog.primary_code)) AS logical_code,
				COALESCE(catalog.release_date, '') AS release_date
			FROM `+circleCatalogProjection+` AS catalog
			LEFT JOIN work AS catalog_work ON UPPER(catalog_work.primary_code) = UPPER(catalog.primary_code)
			LEFT JOIN work_edition AS catalog_edition ON catalog_edition.work_id = catalog_work.id
			LEFT JOIN logical_work AS catalog_logical ON catalog_logical.id = catalog_edition.logical_work_id
			WHERE catalog.party_id = ?
		), selected_logical_codes AS (
			SELECT logical_code
			FROM projected_codes
			GROUP BY logical_code
			ORDER BY MAX(release_date) DESC, logical_code DESC
			LIMIT 100
		)
		SELECT
			codes.primary_code,
			COALESCE(dlsite_catalog.title, remote_catalog.title, codes.primary_code),
			COALESCE(dlsite_catalog.release_date, remote_catalog.release_date),
			COALESCE(dlsite_catalog.url, remote_catalog.url, ''),
			COALESCE(dlsite_catalog.catalog_status, remote_catalog.catalog_status, 'catalog'),
			COALESCE(dlsite_catalog.dlsite_available, 1),
			work.id,
			COALESCE(work.age_rating, ''),
			work.rating_average,
			work.sales_count,
			work.regular_price,
			work.current_price,
			COALESCE(work.price_currency, ''),
			work.is_permanently_free,
			COALESCE((
				SELECT snapshot_json
				FROM metadata_snapshot
				WHERE metadata_snapshot.work_id = work.id
				ORDER BY fetched_at DESC, id DESC
				LIMIT 1
			), '') AS snapshot_json,
			COALESCE(user_work_state.listening_status, 'none'),
			COALESCE(user_work_state.favorite, 0),
			COALESCE((
				SELECT series.name || '|' || series.title_id
				FROM party_series_work AS series_work
				INNER JOIN party_series AS series ON series.id = series_work.series_id
				WHERE series.party_id = ?
					AND UPPER(series_work.primary_code) = UPPER(codes.primary_code)
				ORDER BY series.last_seen_at DESC, series.id DESC
				LIMIT 1
			), '')
		FROM (
			SELECT DISTINCT primary_code
			FROM projected_codes
			WHERE logical_code IN (SELECT logical_code FROM selected_logical_codes)
		) AS codes
		LEFT JOIN metadata_provider AS dlsite_provider ON dlsite_provider.code = 'dlsite'
		LEFT JOIN `+circleCatalogProjection+` AS dlsite_catalog
			ON dlsite_catalog.party_id = ?
			AND dlsite_catalog.provider_id = dlsite_provider.id
			AND UPPER(dlsite_catalog.primary_code) = UPPER(codes.primary_code)
		LEFT JOIN `+circleCatalogProjection+` AS remote_catalog
			ON remote_catalog.id = (
				SELECT catalog.id
				FROM `+circleCatalogProjection+` AS catalog
				INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
				WHERE catalog.party_id = ?
					AND UPPER(catalog.primary_code) = UPPER(codes.primary_code)
					AND provider.code != 'dlsite'
				ORDER BY catalog.last_seen_at DESC, catalog.id DESC
				LIMIT 1
			)
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(codes.primary_code)
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		ORDER BY COALESCE(dlsite_catalog.release_date, remote_catalog.release_date, '') DESC, codes.primary_code DESC
	`, partyID, partyID, partyID, partyID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Enrichment issues further queries, so the cursor must release its pooled
	// connection first. Concurrent requests that each held a cursor while
	// waiting for a second connection could otherwise exhaust the pool.
	catalogRows := []circleCatalogWorkRow{}
	for rows.Next() {
		row, err := scanCircleCatalogWorkRow(rows)
		if err != nil {
			return nil, err
		}
		catalogRows = append(catalogRows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	works := []circleCatalogWork{}
	seen := map[string]int{}
	for _, row := range catalogRows {
		item, include, err := s.buildCircleCatalogWork(ctx, row, userID, partyID)
		if err != nil {
			return nil, err
		}
		if !include {
			continue
		}
		key := strings.ToUpper(strings.TrimSpace(item.PrimaryCode))
		if index, ok := seen[key]; ok {
			mergeCircleCatalogWork(&works[index], item)
			continue
		}
		seen[key] = len(works)
		works = append(works, item)
	}
	workIDs := make([]int64, 0, len(works))
	for _, work := range works {
		if work.WorkID != nil {
			workIDs = append(workIDs, *work.WorkID)
		}
	}
	tagsByWork, err := s.loadWorkUserTagsBatch(ctx, userID, workIDs)
	if err != nil {
		return nil, err
	}
	worksWithLyrics, err := s.loadWorksWithLyrics(ctx, workIDs)
	if err != nil {
		return nil, err
	}
	titles, err := s.loadWorkTitles(ctx, workIDs)
	if err != nil {
		return nil, err
	}
	for index := range works {
		if works[index].WorkID != nil {
			if title, ok := titles[*works[index].WorkID]; ok {
				works[index].Title = title.Title
			}
			works[index].UserTags = tagsByWork[*works[index].WorkID]
			works[index].HasLyrics = worksWithLyrics[*works[index].WorkID]
		} else {
			works[index].UserTags = []workUserTag{}
		}
	}
	return works, nil
}

func (s *Server) buildCircleCatalogWork(ctx context.Context, row circleCatalogWorkRow, userID, partyID int64) (circleCatalogWork, bool, error) {
	item, metadata, err := s.readCircleCatalogWork(ctx, row)
	if err != nil {
		return circleCatalogWork{}, false, err
	}
	if s.cfg.IsDemo() {
		if item.WorkID == nil {
			return item, false, nil
		}
		eligible, err := s.demoWorkEligible(ctx, *item.WorkID)
		if err != nil {
			return item, false, err
		}
		if !eligible {
			return item, false, nil
		}
	}
	item.CoverURL = s.coverURL(item.PrimaryCode)
	item.DLsiteURL = firstNonEmpty(s.dlsiteURL(item.PrimaryCode), item.DLsiteURL)
	item.Circle, item.CircleExternalID = metadata.Circle, metadata.CircleExternalID
	if err := s.populateCircleCatalogWorkRelations(ctx, &item, userID, partyID); err != nil {
		return item, false, err
	}
	if err := s.applyManualOverridesToCircleWork(ctx, &item); err != nil {
		return item, false, err
	}
	return item, true, nil
}

// circleCatalogWorkRow is one scanned catalog row before any enrichment query.
type circleCatalogWorkRow struct {
	item            circleCatalogWork
	workID          sql.NullInt64
	dlsiteAvailable int
	favorite        int
	snapshot        string
	seriesLink      string
}

func scanCircleCatalogWorkRow(rows *sql.Rows) (circleCatalogWorkRow, error) {
	var row circleCatalogWorkRow
	item := &row.item
	var release sql.NullString
	var rating sql.NullFloat64
	var sales, regularPrice, currentPrice sql.NullInt64
	var permanentlyFree sql.NullBool
	if err := rows.Scan(&item.PrimaryCode, &item.Title, &release, &item.DLsiteURL, &item.CatalogStatus, &row.dlsiteAvailable, &row.workID, &item.AgeRating,
		&rating, &sales, &regularPrice, &currentPrice, &item.PriceCurrency, &permanentlyFree,
		&row.snapshot, &item.ListeningMark, &row.favorite, &row.seriesLink); err != nil {
		return row, err
	}
	item.Rating = sqlutil.Float64(rating)
	item.Sales = sqlutil.Int64(sales)
	item.RegularPrice = sqlutil.Int64(regularPrice)
	item.Price = sqlutil.Int64(currentPrice)
	if permanentlyFree.Valid {
		item.PermanentlyFree = &permanentlyFree.Bool
	}
	item.ReleaseDate = sqlutil.String(release)
	if item.ReleaseDate != nil {
		item.UpdatedAt = *item.ReleaseDate
	}
	return row, nil
}

func (s *Server) readCircleCatalogWork(ctx context.Context, row circleCatalogWorkRow) (circleCatalogWork, dlsiteSnapshotMetadata, error) {
	item := row.item
	originalCode := item.PrimaryCode
	ref, err := s.canonicalWorkForCode(ctx, item.PrimaryCode)
	if err != nil {
		return item, dlsiteSnapshotMetadata{}, err
	}
	if ref.Known && ref.Code != "" {
		item.PrimaryCode = ref.Code
		if !strings.EqualFold(originalCode, ref.Code) {
			item.RemoteCode = originalCode
		}
		if ref.WorkID > 0 {
			item.WorkID = &ref.WorkID
		}
	}
	item.Series, item.SeriesTitleID = parseSeriesLink(row.seriesLink)
	metadata := parseDLsiteSnapshot(row.snapshot)
	if ref.Known && ref.WorkID > 0 && !strings.EqualFold(originalCode, ref.Code) {
		if err := s.projectCircleCatalogWorkToCanonical(ctx, &item, &metadata, ref.WorkID); err != nil {
			return item, dlsiteSnapshotMetadata{}, err
		}
	}
	item.RatingCount, item.Tags, item.VoiceActors = metadata.RatingCount, metadata.Tags, metadata.VoiceActors
	if item.Series == "" {
		item.Series = metadata.Series
	}
	if item.WorkID == nil {
		item.WorkID = sqlutil.Int64(row.workID)
	}
	if item.WorkID != nil {
		if tags, projected, err := s.loadProjectedDLsiteTags(ctx, *item.WorkID); err != nil {
			return item, dlsiteSnapshotMetadata{}, err
		} else {
			item.Tags = presentProjectedTags(item.Tags, tags, projected)
		}
	}
	item.Favorite = row.favorite != 0
	item.DLsiteAvailable = row.dlsiteAvailable != 0
	return item, metadata, nil
}

func (s *Server) projectCircleCatalogWorkToCanonical(ctx context.Context, item *circleCatalogWork, metadata *dlsiteSnapshotMetadata, workID int64) error {
	var title, ageRating, snapshot string
	var release sql.NullString
	var rating sql.NullFloat64
	var sales, regularPrice, currentPrice sql.NullInt64
	var currency sql.NullString
	var permanentlyFree sql.NullBool
	err := s.db.QueryRowContext(ctx, `
		SELECT
			work.title,
			work.release_date,
			work.age_rating,
			work.rating_average,
			work.sales_count,
			work.regular_price,
			work.current_price,
			work.price_currency,
			work.is_permanently_free,
			COALESCE((
				SELECT snapshot_json
				FROM metadata_snapshot
				INNER JOIN metadata_provider AS provider ON provider.id = metadata_snapshot.provider_id
				WHERE metadata_snapshot.work_id = work.id AND provider.code = 'dlsite'
				ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC
				LIMIT 1
			), '')
		FROM work
		WHERE work.id = ?
	`, workID).Scan(&title, &release, &ageRating, &rating, &sales, &regularPrice, &currentPrice, &currency, &permanentlyFree, &snapshot)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if title != "" {
		item.Title = title
	}
	if release.Valid {
		item.ReleaseDate = &release.String
		item.UpdatedAt = release.String
	}
	if ageRating != "" {
		item.AgeRating = ageRating
	}
	item.Rating = sqlutil.Float64(rating)
	item.Sales = sqlutil.Int64(sales)
	item.RegularPrice = sqlutil.Int64(regularPrice)
	item.Price = sqlutil.Int64(currentPrice)
	if currency.Valid {
		item.PriceCurrency = currency.String
	}
	if permanentlyFree.Valid {
		item.PermanentlyFree = &permanentlyFree.Bool
	}
	if snapshot != "" {
		canonicalMetadata := parseDLsiteSnapshot(snapshot)
		if canonicalMetadata.Circle != "" {
			metadata.Circle = canonicalMetadata.Circle
			metadata.CircleExternalID = canonicalMetadata.CircleExternalID
		}
		if canonicalMetadata.RatingCount != nil {
			metadata.RatingCount = canonicalMetadata.RatingCount
		}
		if len(canonicalMetadata.Tags) > 0 {
			metadata.Tags = canonicalMetadata.Tags
		}
		if len(canonicalMetadata.VoiceActors) > 0 {
			metadata.VoiceActors = canonicalMetadata.VoiceActors
		}
		if metadata.Series == "" {
			metadata.Series = canonicalMetadata.Series
		}
	}
	if metadata.CircleExternalID == "" {
		_ = s.db.QueryRowContext(ctx, `
			SELECT display_name, external_id
			FROM work_primary_circle
			WHERE work_id = ?
		`, workID).Scan(&metadata.Circle, &metadata.CircleExternalID)
	}
	return nil
}

func (s *Server) populateCircleCatalogWorkRelations(ctx context.Context, item *circleCatalogWork, userID, partyID int64) error {
	tags, err := s.workSourceTags(ctx, partyID, item.PrimaryCode)
	if err != nil {
		return err
	}
	item.SourceTags = tags
	item.Local, item.Remote = circleCatalogSourceFlags(tags)
	if item.WorkID != nil {
		item.VoiceCredits, err = s.voiceCreditsForWork(ctx, *item.WorkID)
		if err != nil {
			return err
		}
		item.Progress, err = s.workProgressSummary(ctx, userID, *item.WorkID)
		if err != nil {
			return err
		}
	}
	return nil
}

func circleCatalogSourceFlags(tags []circleSourceStat) (bool, bool) {
	local, remote := false, false
	for _, tag := range tags {
		if tag.Key == "local" {
			local = true
		}
		if tag.Key == "remote" || strings.HasPrefix(tag.Key, "source:") {
			remote = true
		}
	}
	return local, remote
}

func mergeCircleCatalogWork(target *circleCatalogWork, item circleCatalogWork) {
	mergeCircleCatalogWorkIdentity(target, item)
	mergeCircleCatalogWorkMetadata(target, item)
	mergeCircleCatalogWorkState(target, item)
}

func mergeCircleCatalogWorkIdentity(target *circleCatalogWork, item circleCatalogWork) {
	if target.WorkID == nil {
		target.WorkID = item.WorkID
	}
	if target.RemoteCode == "" {
		target.RemoteCode = item.RemoteCode
	}
	if target.Title == "" || strings.EqualFold(target.Title, target.PrimaryCode) {
		target.Title = item.Title
	}
	if target.ReleaseDate == nil {
		target.ReleaseDate = item.ReleaseDate
	}
	if target.UpdatedAt == "" {
		target.UpdatedAt = item.UpdatedAt
	}
	if target.Circle == "" {
		target.Circle = item.Circle
		target.CircleExternalID = item.CircleExternalID
	}
	if target.AgeRating == "" {
		target.AgeRating = item.AgeRating
	}
}

func mergeCircleCatalogWorkMetadata(target *circleCatalogWork, item circleCatalogWork) {
	if len(target.Tags) == 0 {
		target.Tags = item.Tags
	}
	if len(target.UserTags) == 0 {
		target.UserTags = item.UserTags
	}
	if target.Rating == nil {
		target.Rating = item.Rating
	}
	if target.Sales == nil {
		target.Sales = item.Sales
	}
	target.HasLyrics = target.HasLyrics || item.HasLyrics
	if target.RegularPrice == nil {
		target.RegularPrice = item.RegularPrice
	}
	if target.Price == nil {
		target.Price = item.Price
	}
	if target.PriceCurrency == "" {
		target.PriceCurrency = item.PriceCurrency
	}
	if target.PermanentlyFree == nil {
		target.PermanentlyFree = item.PermanentlyFree
	}
	if target.Series == "" {
		target.Series = item.Series
		target.SeriesTitleID = item.SeriesTitleID
	}
}

func mergeCircleCatalogWorkState(target *circleCatalogWork, item circleCatalogWork) {
	if target.CatalogStatus != "imported" && item.CatalogStatus == "imported" {
		target.CatalogStatus = item.CatalogStatus
	}
	target.DLsiteAvailable = target.DLsiteAvailable || item.DLsiteAvailable
	if target.ListeningMark == "" || target.ListeningMark == "none" {
		target.ListeningMark = item.ListeningMark
	}
	target.Favorite = target.Favorite || item.Favorite
	target.Local = target.Local || item.Local
	target.Remote = target.Remote || item.Remote
	target.SourceTags = mergeCircleSourceStats(target.SourceTags, item.SourceTags)
	if target.Progress.MediaItemID == nil {
		target.Progress = item.Progress
	}
}

func mergeCircleSourceStats(left []circleSourceStat, right []circleSourceStat) []circleSourceStat {
	result := append([]circleSourceStat{}, left...)
	seen := map[string]int{}
	for index, item := range result {
		seen[circleSourceStatKey(item)] = index
	}
	for _, item := range right {
		key := circleSourceStatKey(item)
		if index, ok := seen[key]; ok {
			result[index].Count += item.Count
			continue
		}
		seen[key] = len(result)
		result = append(result, item)
	}
	return result
}

func circleSourceStatKey(item circleSourceStat) string {
	if item.SourceID != nil {
		return fmt.Sprintf("%s:%d", item.Key, *item.SourceID)
	}
	return item.Key
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

func (s *Server) workSourceTags(ctx context.Context, partyID int64, code string) ([]circleSourceStat, error) {
	// Keep the JSON contract stable for catalog-only works: an empty source
	// collection must encode as [] rather than null for frontend consumers.
	tags := workSourceTagAccumulator{items: []circleSourceStat{}, sourceIDs: map[int64]bool{}}
	if err := s.loadWorkMediaSourceTags(ctx, code, &tags); err != nil {
		return nil, err
	}
	if err := s.mergeWorkCatalogSourceTags(ctx, partyID, code, &tags); err != nil {
		return nil, err
	}
	if err := s.mergeWorkPresenceSourceTags(ctx, code, &tags); err != nil {
		return nil, err
	}
	if tags.hasRemote {
		tags.items = append([]circleSourceStat{{Key: "remote", DisplayName: "Remote", Status: "available", Count: 1}}, tags.items...)
	}
	return tags.items, nil
}

type workSourceTagAccumulator struct {
	items     []circleSourceStat
	sourceIDs map[int64]bool
	hasRemote bool
}

func (tags *workSourceTagAccumulator) addMedia(sourceID int64, sourceName, locationType string, count int) {
	if locationType == "local" {
		tags.items = append(tags.items, circleSourceStat{Key: "local", DisplayName: "Local", Status: "available", Count: count})
		return
	}
	tags.hasRemote = true
	tags.sourceIDs[sourceID] = true
	tags.items = append(tags.items, circleSourceStat{Key: fmt.Sprintf("source:%d", sourceID), SourceID: &sourceID, DisplayName: sourceName, Status: "available", Count: count})
}

func (tags *workSourceTagAccumulator) addRemoteIfMissing(sourceID int64, sourceName string, count int) {
	if tags.sourceIDs[sourceID] {
		return
	}
	tags.hasRemote = true
	tags.sourceIDs[sourceID] = true
	tags.items = append(tags.items, circleSourceStat{Key: fmt.Sprintf("source:%d", sourceID), SourceID: &sourceID, DisplayName: sourceName, Status: "available", Count: count})
}

func (s *Server) loadWorkMediaSourceTags(ctx context.Context, code string, tags *workSourceTagAccumulator) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, location.location_type, COUNT(*)
		FROM work
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE work.id IN (
				SELECT family_work.id
				FROM work AS family_work
				WHERE UPPER(family_work.primary_code) = UPPER(?)
				UNION
				SELECT sibling.work_id
				FROM work AS current_work
				INNER JOIN work_edition AS current_edition ON current_edition.work_id = current_work.id
				INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
				WHERE UPPER(current_work.primary_code) = UPPER(?)
			)
			AND location.availability = 'available'
		GROUP BY source.id, source.display_name, location.location_type
	`, code, code)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var sourceID int64
		var sourceName, locationType string
		var count int
		if err := rows.Scan(&sourceID, &sourceName, &locationType, &count); err != nil {
			return err
		}
		tags.addMedia(sourceID, sourceName, locationType, count)
	}
	return rows.Err()
}

func (s *Server) mergeWorkCatalogSourceTags(ctx context.Context, partyID int64, code string, tags *workSourceTagAccumulator) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, COUNT(*)
		FROM `+circleCatalogProjection+` AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		INNER JOIN file_source AS source ON provider.code = 'kikoeru_source_' || source.code
		WHERE catalog.party_id = ?
			AND UPPER(catalog.primary_code) IN (
				SELECT UPPER(?)
				UNION
				SELECT UPPER(sibling.primary_code)
				FROM work AS current_work
				INNER JOIN work_edition AS current_edition ON current_edition.work_id = current_work.id
				INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
				WHERE UPPER(current_work.primary_code) = UPPER(?)
			)
			AND source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
			AND source.enabled = 1
		GROUP BY source.id, source.display_name
	`, partyID, code, code)
	if err != nil {
		return err
	}
	defer rows.Close()
	return mergeRemoteSourceTagRows(rows, tags)
}

func (s *Server) mergeWorkPresenceSourceTags(ctx context.Context, code string, tags *workSourceTagAccumulator) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, COUNT(*)
		FROM work
		INNER JOIN work_source_presence AS presence ON presence.work_id = work.id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE work.id IN (
				SELECT family_work.id
				FROM work AS family_work
				WHERE UPPER(family_work.primary_code) = UPPER(?)
				UNION
				SELECT sibling.work_id
				FROM work AS current_work
				INNER JOIN work_edition AS current_edition ON current_edition.work_id = current_work.id
				INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
				WHERE UPPER(current_work.primary_code) = UPPER(?)
			)
			AND presence.presence_type = 'source'
			AND presence.availability = 'available'
			AND source.enabled = 1
		GROUP BY source.id, source.display_name
	`, code, code)
	if err != nil {
		return err
	}
	defer rows.Close()
	return mergeRemoteSourceTagRows(rows, tags)
}

func mergeRemoteSourceTagRows(rows *sql.Rows, tags *workSourceTagAccumulator) error {
	for rows.Next() {
		var sourceID int64
		var sourceName string
		var count int
		if err := rows.Scan(&sourceID, &sourceName, &count); err != nil {
			return err
		}
		tags.addRemoteIfMissing(sourceID, sourceName, count)
	}
	return rows.Err()
}
