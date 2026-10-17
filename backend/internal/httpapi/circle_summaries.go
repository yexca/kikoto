package httpapi

import (
	"context"
	"database/sql"
	"strings"

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
	latestByParty, coverByParty, err := s.loadCircleLatestWorks(ctx, partyIDs, savedCreatorCoverChoice("user_party_state", "party_id", userID))
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
		items[index].coverWork = coverByParty[items[index].ID]
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
		s.presentCircleCover(&pageItems[index])
	}
	return circleSummaryPage{
		Circles: pageItems, Page: page, PageSize: minInt(pageSize, 100), Total: len(items),
		CatalogWorks: catalogWorks, AvailableWorks: availableWorks,
	}, nil
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
	latestByParty, coverByParty, err := s.loadCircleLatestWorks(ctx, []int64{item.ID}, savedCreatorCoverChoice("user_party_state", "party_id", userID))
	if err != nil {
		return circleSummary{}, err
	}
	item.LatestWork = latestByParty[item.ID]
	item.coverWork = coverByParty[item.ID]
	s.presentCircleCover(&item)
	return item, nil
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

// loadCircleLatestWorks returns each circle's latest work and, for the circles
// the choice names, the chosen cover work while it is still one of the
// circle's works.
func (s *Server) loadCircleLatestWorks(ctx context.Context, partyIDs []int64, choice creatorCoverChoice) (map[int64]*creatorLatestWork, map[int64]*creatorLatestWork, error) {
	result := map[int64]*creatorLatestWork{}
	chosen := map[int64]*creatorLatestWork{}
	if len(partyIDs) == 0 {
		return result, chosen, nil
	}
	catalogDemoWhere := ""
	relationDemoWhere := ""
	if s.cfg.IsDemo() {
		catalogDemoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
		relationDemoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	err := s.queryInt64Batches(ctx, `
		WITH chosen AS (`+choice.sql+`), selected_parties AS (SELECT id FROM party WHERE id IN (%s)), candidates AS (
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
			) AS position,
			EXISTS (
				SELECT 1
				FROM chosen
				WHERE chosen.creator_id = candidates.party_id AND chosen.code = candidates.primary_code
			) AS chosen_cover
			FROM candidates
		)
		SELECT party_id, primary_code, title, release_date, position, chosen_cover
		FROM ranked
		WHERE position = 1 OR chosen_cover = 1
	`, partyIDs, choice.args, func(rows *sql.Rows) error {
		var partyID int64
		var item creatorLatestWork
		var releaseDate sql.NullString
		var position int
		var chosenCover bool
		if err := rows.Scan(&partyID, &item.PrimaryCode, &item.Title, &releaseDate, &position, &chosenCover); err != nil {
			return err
		}
		item.ReleaseDate = sqlutil.String(releaseDate)
		if position == 1 {
			latest := item
			result[partyID] = &latest
		}
		if chosenCover {
			chosen[partyID] = &item
		}
		return nil
	})
	return result, chosen, err
}

// presentCircleCover resolves the covers a summary shows from the Library's
// cached covers.
func (s *Server) presentCircleCover(item *circleSummary) {
	if item.LatestWork != nil {
		item.LatestWork.CoverURL = s.coverURL(item.LatestWork.PrimaryCode)
	}
	if item.coverWork != nil {
		item.coverWork.CoverURL = s.coverURL(item.coverWork.PrimaryCode)
	}
	item.Cover = newCreatorCover(item.coverWork, item.LatestWork)
}

// circleCoverWorkUsable reports whether a work can be saved as a circle's
// cover: it is one of the circle's works and has a cover to show.
func (s *Server) circleCoverWorkUsable(ctx context.Context, partyID int64, code string) (bool, error) {
	_, chosen, err := s.loadCircleLatestWorks(ctx, []int64{partyID}, proposedCreatorCoverChoice(partyID, code))
	if err != nil {
		return false, err
	}
	return chosen[partyID] != nil && s.coverURL(code) != "", nil
}
