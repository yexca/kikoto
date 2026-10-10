package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"net"
	"strconv"
	"strings"
	"time"
)

func (s *Server) loadVoiceSummaries(ctx context.Context, userID int64) ([]voiceSummary, error) {
	rows, err := s.db.QueryContext(ctx, voiceSummaryQuery("", s.cfg.IsDemo())+" ORDER BY known_works DESC, person.display_name ASC", userID)
	if err != nil {
		return nil, err
	}
	summaries := []voiceSummary{}
	for rows.Next() {
		item, err := scanVoiceSummaryRow(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		summaries = append(summaries, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	tagsByPerson, err := s.loadVoiceUserTagsBatch(ctx, userID)
	if err != nil {
		return nil, err
	}
	for index := range summaries {
		tags := tagsByPerson[summaries[index].PersonID]
		if tags == nil {
			tags = []voiceUserTag{}
		}
		summaries[index].UserTags = tags
	}
	if err := s.fillVoiceCatalogSyncStates(ctx, summaries); err != nil {
		return nil, err
	}
	personIDs := make([]int64, 0, len(summaries))
	for _, summary := range summaries {
		personIDs = append(personIDs, summary.PersonID)
	}
	latestByPerson, err := s.loadVoiceLatestWorks(ctx, personIDs)
	if err != nil {
		return nil, err
	}
	for index := range summaries {
		summaries[index].LatestWork = latestByPerson[summaries[index].PersonID]
	}
	return summaries, nil
}

func (s *Server) loadVoiceSummary(ctx context.Context, userID int64, personID int64) (voiceSummary, error) {
	row := s.db.QueryRowContext(ctx, voiceSummaryQuery("WHERE person.id = ?", s.cfg.IsDemo()), userID, personID)
	item, err := s.scanVoiceSummary(ctx, row, userID)
	if err != nil {
		return voiceSummary{}, err
	}
	syncedItems := []voiceSummary{item}
	if err := s.fillVoiceCatalogSyncStates(ctx, syncedItems); err != nil {
		return voiceSummary{}, err
	}
	item = syncedItems[0]
	latestByPerson, err := s.loadVoiceLatestWorks(ctx, []int64{personID})
	if err != nil {
		return voiceSummary{}, err
	}
	item.LatestWork = latestByPerson[personID]
	s.presentVoiceLatestWorkCover(ctx, item.LatestWork)
	return item, nil
}

// presentVoiceLatestWorkCover prefers the Library cover and otherwise shows
// the catalog's remote cover through the address visibility rule.
func (s *Server) presentVoiceLatestWorkCover(ctx context.Context, latest *creatorLatestWork) {
	if latest == nil {
		return
	}
	if coverURL := s.coverURL(latest.PrimaryCode); coverURL != "" {
		latest.CoverURL = coverURL
		return
	}
	latest.CoverURL = s.visibleRemoteImageURL(ctx, latest.CoverSourceID, latest.CoverURL)
}

type voiceCatalogSyncProjection struct {
	Exists        bool
	Queries       []string
	LastSuccessAt string
	LastAttemptAt string
	LastStatus    string
	Complete      bool
}

func (s *Server) fillVoiceCatalogSyncStates(ctx context.Context, summaries []voiceSummary) error {
	if len(summaries) == 0 {
		return nil
	}
	personIDs := make([]int64, 0, len(summaries))
	for _, summary := range summaries {
		personIDs = append(personIDs, summary.PersonID)
	}
	projections, err := s.loadVoiceCatalogSyncProjections(ctx, personIDs)
	if err != nil {
		return err
	}
	freshnessDays := s.catalogFreshnessDays(ctx)
	now := time.Now().UTC()
	for index := range summaries {
		setVoiceCatalogSyncState(&summaries[index], projections[summaries[index].PersonID], freshnessDays, now)
	}
	return nil
}

func (s *Server) loadVoiceCatalogSyncProjections(ctx context.Context, personIDs []int64) (map[int64]voiceCatalogSyncProjection, error) {
	projections := map[int64]voiceCatalogSyncProjection{}
	if len(personIDs) == 0 {
		return projections, nil
	}
	err := s.queryInt64Batches(ctx, `
		SELECT person_id, query_json, last_success_at, last_attempt_at, last_status, complete
		FROM voice_catalog_refresh_state
		WHERE person_id IN (%s)
	`, personIDs, nil, func(rows *sql.Rows) error {
		var personID int64
		var queryJSON string
		var lastSuccess, lastAttempt sql.NullString
		var lastStatus string
		var complete int
		if err := rows.Scan(&personID, &queryJSON, &lastSuccess, &lastAttempt, &lastStatus, &complete); err != nil {
			return err
		}
		projection := voiceCatalogSyncProjection{
			Exists:        true,
			LastStatus:    lastStatus,
			Complete:      complete != 0,
			LastSuccessAt: voiceCatalogStringValue(lastSuccess),
			LastAttemptAt: voiceCatalogStringValue(lastAttempt),
			Queries:       []string{},
		}
		_ = json.Unmarshal([]byte(queryJSON), &projection.Queries)
		if projection.Queries == nil {
			projection.Queries = []string{}
		}
		projections[personID] = projection
		return nil
	})
	return projections, err
}

func setVoiceCatalogSyncState(item *voiceSummary, projection voiceCatalogSyncProjection, freshnessDays int, now time.Time) {
	if projection.LastSuccessAt != "" {
		lastSuccessAt := projection.LastSuccessAt
		item.LastSyncedAt = &lastSuccessAt
	} else {
		item.LastSyncedAt = nil
	}
	item.SyncState, item.SyncReason = catalogFreshnessState(projection.LastSuccessAt, projection.LastAttemptAt, freshnessDays, now)
	if item.SyncState == catalogSyncNever {
		return
	}
	if !projection.Complete {
		item.SyncState = catalogSyncAttention
		item.SyncReason = "incomplete"
		return
	}
	if !equalVoiceCatalogQuerySets(projection.Queries, voiceCatalogQueryValues(item.DisplayName, item.Aliases)) {
		item.SyncState = catalogSyncAttention
		item.SyncReason = "aliases_changed"
	}
}

func voiceSummaryQuery(where string, demo bool) string {
	creditDemoWhere := ""
	catalogDemoWhere := ""
	if demo {
		creditDemoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
		catalogDemoWhere = `
			AND EXISTS (
				SELECT 1
				FROM work AS demo_work
				WHERE (demo_work.id = catalog.work_id OR UPPER(demo_work.primary_code) = UPPER(catalog.primary_code))
					AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
			)
		`
	}
	return `
		WITH credited_roots AS (
			SELECT
				credit.person_id,
				UPPER(COALESCE(logical.canonical_code, work.primary_code)) AS logical_code,
				MAX(work.updated_at) AS last_seen_at
			FROM work_credit AS credit
			INNER JOIN work ON work.id = credit.work_id
			LEFT JOIN work_edition AS edition ON edition.work_id = work.id
			LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			WHERE credit.role = 'voice_actor'
				` + creditDemoWhere + `
			GROUP BY credit.person_id, UPPER(COALESCE(logical.canonical_code, work.primary_code))
		), catalog_roots AS (
			SELECT
				catalog.person_id,
				UPPER(catalog.primary_code) AS logical_code,
				MAX(catalog.updated_at) AS last_seen_at
			FROM voice_catalog_item AS catalog
			WHERE 1 = 1
				` + catalogDemoWhere + `
			GROUP BY catalog.person_id, UPPER(catalog.primary_code)
		), voice_work_roots AS (
			SELECT person_id, logical_code, MAX(last_seen_at) AS last_seen_at
			FROM (
				SELECT person_id, logical_code, last_seen_at FROM credited_roots
				UNION ALL
				SELECT person_id, logical_code, last_seen_at FROM catalog_roots
			)
			GROUP BY person_id, logical_code
		), work_location_flags AS (
			SELECT
				UPPER(COALESCE(logical.canonical_code, work.primary_code)) AS logical_code,
				MAX(CASE WHEN location.location_type = 'local' AND location.availability = 'available' THEN 1 ELSE 0 END) AS has_local,
				MAX(CASE WHEN location.location_type IN ('remote_stream', 'remote_download') AND location.availability = 'available' THEN 1 ELSE 0 END) AS has_remote,
				MAX(CASE WHEN location.location_type = 'cache' AND location.availability = 'available' THEN 1 ELSE 0 END) AS has_cache
			FROM work
			LEFT JOIN work_edition AS availability_edition ON availability_edition.work_id = work.id
			LEFT JOIN logical_work AS logical ON logical.id = availability_edition.logical_work_id
			LEFT JOIN media_item AS item ON item.work_id = work.id
			LEFT JOIN media_file_location AS location ON location.media_item_id = item.id
			GROUP BY UPPER(COALESCE(logical.canonical_code, work.primary_code))
		), work_presence_flags AS (
			SELECT
				UPPER(COALESCE(logical.canonical_code, work.primary_code)) AS logical_code,
				MAX(CASE WHEN presence.availability = 'available' AND source.enabled = 1 THEN 1 ELSE 0 END) AS has_remote
			FROM work_source_presence AS presence
			INNER JOIN work ON work.id = presence.work_id
			INNER JOIN file_source AS source ON source.id = presence.file_source_id
			LEFT JOIN work_edition AS edition ON edition.work_id = work.id
			LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			WHERE presence.presence_type = 'source'
			GROUP BY UPPER(COALESCE(logical.canonical_code, work.primary_code))
		), catalog_location_flags AS (
			SELECT
				catalog.person_id,
				UPPER(catalog.primary_code) AS logical_code,
				MAX(CASE WHEN catalog_source.availability = 'available' AND source.enabled = 1 THEN 1 ELSE 0 END) AS has_remote
			FROM voice_catalog_item AS catalog
			LEFT JOIN voice_catalog_source AS catalog_source ON catalog_source.catalog_item_id = catalog.id
			LEFT JOIN metadata_provider AS provider ON provider.id = catalog_source.provider_id
			LEFT JOIN file_source AS source ON provider.code = 'kikoeru_source_' || source.code
			GROUP BY catalog.person_id, UPPER(catalog.primary_code)
		)
		SELECT
			person.id,
			person.display_name,
			COALESCE((
				SELECT GROUP_CONCAT(alias.alias, char(31))
				FROM person_alias AS alias
				WHERE alias.person_id = person.id
			), '') AS aliases,
			COUNT(DISTINCT roots.logical_code) AS known_works,
			COUNT(DISTINCT CASE WHEN locations.has_local = 1 THEN roots.logical_code END) AS local_works,
			COUNT(DISTINCT CASE WHEN locations.has_remote = 1 OR presence.has_remote = 1 OR catalog_flags.has_remote = 1 THEN roots.logical_code END) AS remote_works,
			COUNT(DISTINCT CASE WHEN locations.has_cache = 1 THEN roots.logical_code END) AS cached_works,
			COUNT(DISTINCT CASE
				WHEN locations.has_local = 1 OR locations.has_remote = 1 OR locations.has_cache = 1
					OR presence.has_remote = 1 OR catalog_flags.has_remote = 1
				THEN roots.logical_code
			END) AS playable_works,
			MAX(roots.last_seen_at) AS last_seen_at,
			state.rating,
			COALESCE(state.note, '') AS note,
			COALESCE(state.favorite, 0) AS favorite
		FROM person
		INNER JOIN voice_work_roots AS roots ON roots.person_id = person.id
		LEFT JOIN work_location_flags AS locations ON locations.logical_code = roots.logical_code
		LEFT JOIN work_presence_flags AS presence ON presence.logical_code = roots.logical_code
		LEFT JOIN catalog_location_flags AS catalog_flags
			ON catalog_flags.person_id = person.id AND catalog_flags.logical_code = roots.logical_code
		LEFT JOIN user_person_state AS state ON state.person_id = person.id AND state.user_id = ?
		` + where + `
		GROUP BY person.id, person.display_name, state.rating, state.note, state.favorite
	`
}

type voiceSummaryScanner interface {
	Scan(dest ...any) error
}

func (s *Server) scanVoiceSummary(ctx context.Context, scanner voiceSummaryScanner, userID int64) (voiceSummary, error) {
	item, err := scanVoiceSummaryRow(scanner)
	if err != nil {
		return voiceSummary{}, err
	}
	tags, err := s.loadVoiceUserTags(ctx, userID, item.PersonID)
	if err != nil {
		return voiceSummary{}, err
	}
	item.UserTags = tags
	return item, nil
}

func scanVoiceSummaryRow(scanner voiceSummaryScanner) (voiceSummary, error) {
	var item voiceSummary
	var aliasesRaw string
	var lastSeen sql.NullString
	var rating sql.NullInt64
	var favorite int
	if err := scanner.Scan(
		&item.PersonID,
		&item.DisplayName,
		&aliasesRaw,
		&item.KnownWorks,
		&item.LocalWorks,
		&item.RemoteWorks,
		&item.CachedWorks,
		&item.PlayableWorks,
		&lastSeen,
		&rating,
		&item.Note,
		&favorite,
	); err != nil {
		return voiceSummary{}, err
	}
	item.Aliases = splitAliases(aliasesRaw)
	item.LastSeenAt = sqlutil.String(lastSeen)
	if rating.Valid {
		value := int(rating.Int64)
		item.Rating = &value
	}
	item.Favorite = favorite != 0
	item.SourceSummaries = voiceSourceSummaries(item.LocalWorks, item.RemoteWorks, item.CachedWorks)
	return item, nil
}

func filterVoiceSummaries(items []voiceSummary, query string, filter string, tagFilter string) []voiceSummary {
	needle := strings.ToLower(strings.TrimSpace(query))
	filter = strings.ToLower(strings.TrimSpace(filter))
	filtered := make([]voiceSummary, 0, len(items))
	for _, item := range items {
		if !voiceSummaryMatchesQuery(item, needle) {
			continue
		}
		if tagFilter != "" && !voiceSummaryHasTag(item, tagFilter) {
			continue
		}
		if voiceSummaryMatchesFilter(item, filter) {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func voiceSummaryMatchesQuery(item voiceSummary, needle string) bool {
	if needle == "" || strings.Contains(strings.ToLower(item.DisplayName), needle) || strings.Contains(strconv.FormatInt(item.PersonID, 10), needle) {
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

func voiceSummaryHasTag(item voiceSummary, tagFilter string) bool {
	for _, tag := range item.UserTags {
		if tag.Name == tagFilter {
			return true
		}
	}
	return false
}

func voiceSummaryMatchesFilter(item voiceSummary, filter string) bool {
	switch filter {
	case "favorite":
		return item.Favorite
	case "tagged":
		return len(item.UserTags) > 0
	case "available":
		return item.PlayableWorks > 0
	case "local":
		return item.LocalWorks > 0
	case "remote":
		return item.RemoteWorks > 0
	case "missing":
		return item.PlayableWorks == 0
	default:
		return true
	}
}

func (s *Server) loadVoiceLatestWorks(ctx context.Context, personIDs []int64) (map[int64]*creatorLatestWork, error) {
	result := map[int64]*creatorLatestWork{}
	if len(personIDs) == 0 {
		return result, nil
	}
	creditDemoWhere := ""
	catalogDemoWhere := ""
	if s.cfg.IsDemo() {
		creditDemoWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
		catalogDemoWhere = `
			AND EXISTS (
				SELECT 1
				FROM work AS demo_work
				WHERE (demo_work.id = catalog.work_id OR UPPER(demo_work.primary_code) = UPPER(catalog.primary_code))
					AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
			)
		`
	}
	err := s.queryInt64Batches(ctx, `
		WITH selected_people AS (SELECT id FROM person WHERE id IN (%s)), candidates AS (
			SELECT
				catalog.person_id,
				UPPER(catalog.primary_code) AS primary_code,
				COALESCE(NULLIF(work.title, ''), NULLIF(catalog.title, ''), UPPER(catalog.primary_code)) AS title,
				COALESCE(work.release_date, catalog.release_date) AS release_date,
				catalog.cover_url,
				COALESCE((
					SELECT file_source.id
					FROM voice_catalog_source AS catalog_source
					INNER JOIN metadata_provider AS provider ON provider.id = catalog_source.provider_id
					INNER JOIN file_source ON provider.code = 'kikoeru_source_' || file_source.code
					WHERE catalog_source.catalog_item_id = catalog.id
					ORDER BY file_source.id
					LIMIT 1
				), 0) AS cover_source_id
			FROM voice_catalog_item AS catalog
			INNER JOIN selected_people ON selected_people.id = catalog.person_id
			LEFT JOIN work ON work.id = catalog.work_id
			WHERE 1 = 1
				`+catalogDemoWhere+`
			UNION ALL
			SELECT
				credit.person_id,
				UPPER(COALESCE(logical.canonical_code, work.primary_code)) AS primary_code,
				work.title,
				work.release_date,
				'' AS cover_url,
				0 AS cover_source_id
			FROM work_credit AS credit
			INNER JOIN selected_people ON selected_people.id = credit.person_id
			INNER JOIN work ON work.id = credit.work_id
			LEFT JOIN work_edition AS edition ON edition.work_id = work.id
			LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			WHERE credit.role = 'voice_actor'
				`+creditDemoWhere+`
				AND NOT EXISTS (
					SELECT 1
					FROM voice_catalog_item AS catalog
					WHERE catalog.person_id = credit.person_id
						AND UPPER(catalog.primary_code) = UPPER(COALESCE(logical.canonical_code, work.primary_code))
				)
		), ranked AS (
			SELECT *,
				ROW_NUMBER() OVER (
					PARTITION BY person_id
					ORDER BY COALESCE(work.release_date, '') DESC, UPPER(work.primary_code) DESC
				) AS position
			FROM candidates AS work
		)
		SELECT person_id, primary_code, title, release_date, cover_url, cover_source_id
		FROM ranked
		WHERE position = 1
	`, personIDs, nil, func(rows *sql.Rows) error {
		var personID int64
		var item creatorLatestWork
		var releaseDate sql.NullString
		if err := rows.Scan(&personID, &item.PrimaryCode, &item.Title, &releaseDate, &item.CoverURL, &item.CoverSourceID); err != nil {
			return err
		}
		item.ReleaseDate = sqlutil.String(releaseDate)
		result[personID] = &item
		return nil
	})
	return result, err
}

func (s *Server) loadVoiceUserTagsBatch(ctx context.Context, userID int64) (map[int64][]voiceUserTag, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT assignment.person_id, tag.id, tag.name, tag.color
		FROM user_person_tag_assignment AS assignment
		INNER JOIN user_person_tag AS tag ON tag.id = assignment.user_person_tag_id
		WHERE assignment.user_id = ?
		ORDER BY assignment.person_id, tag.name, tag.id
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64][]voiceUserTag{}
	for rows.Next() {
		var personID int64
		var tag voiceUserTag
		if err := rows.Scan(&personID, &tag.ID, &tag.Name, &tag.Color); err != nil {
			return nil, err
		}
		result[personID] = append(result[personID], tag)
	}
	return result, rows.Err()
}

func (s *Server) loadVoiceKnownWorks(ctx context.Context, userID int64, personID int64) ([]voiceKnownWork, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			work.id,
			work.primary_code,
			work.title,
			work.release_date,
			work.age_rating,
			work.rating_average,
			work.sales_count,
			work.regular_price,
			work.current_price,
			work.price_currency,
			work.is_permanently_free,
			`+latestSnapshotCardColumnsAnyProviderSQL+`,
			(
				SELECT primary_circle.display_name || '|' || primary_circle.external_id
				FROM work_primary_circle AS primary_circle
				WHERE primary_circle.work_id = work.id
			) AS party_link,
			COALESCE(user_work_state.listening_status, 'none') AS listening_status,
			COALESCE(user_work_state.favorite, 0) AS favorite,
			EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = work.id AND location.location_type = 'local' AND location.availability = 'available'
			) AS has_local,
			EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = work.id AND location.location_type IN ('remote_stream', 'remote_download') AND location.availability = 'available'
			) AS has_remote,
			EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = work.id AND location.location_type = 'cache' AND location.availability = 'available'
			) AS has_cache,
			COALESCE((
				SELECT series.title_id
				FROM party_series_work AS series_work
				INNER JOIN party_series AS series ON series.id = series_work.series_id
				WHERE UPPER(series_work.primary_code) = UPPER(work.primary_code)
				ORDER BY series.last_seen_at DESC, series.id DESC
				LIMIT 1
			), '') AS series_title_id
		FROM work_credit AS credit
		INNER JOIN work ON work.id = credit.work_id
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id
			AND user_work_state.user_id = ?
		WHERE credit.person_id = ?
			AND credit.role = 'voice_actor'
		ORDER BY COALESCE(work.release_date, '') DESC, work.primary_code DESC
	`, userID, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Close the cursor before enrichment queries so this request never holds
	// one pooled connection while waiting for another.
	workRows := []voiceWorkRow{}
	for rows.Next() {
		row, err := scanVoiceWorkRow(rows)
		if err != nil {
			return nil, err
		}
		workRows = append(workRows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	works := []voiceKnownWork{}
	seen := map[string]int{}
	for _, row := range workRows {
		item, include, err := s.buildVoiceKnownWork(ctx, userID, row)
		if err != nil {
			return nil, err
		}
		if !include {
			continue
		}
		key := strings.ToUpper(strings.TrimSpace(item.PrimaryCode))
		if index, ok := seen[key]; ok {
			mergeVoiceKnownWork(&works[index], item)
			continue
		}
		seen[key] = len(works)
		works = append(works, item)
	}
	workIDs := make([]int64, 0, len(works))
	for _, work := range works {
		workIDs = append(workIDs, work.WorkID)
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
		if title, ok := titles[works[index].WorkID]; ok {
			works[index].Title = title.Title
		}
		works[index].UserTags = tagsByWork[works[index].WorkID]
		works[index].HasLyrics = worksWithLyrics[works[index].WorkID]
	}
	return works, nil
}

func (s *Server) buildVoiceKnownWork(ctx context.Context, userID int64, row voiceWorkRow) (voiceKnownWork, bool, error) {
	displayCode, displayWorkID, remoteCode, err := s.voiceKnownWorkIdentity(ctx, row)
	if err != nil {
		return voiceKnownWork{}, false, err
	}
	if s.cfg.IsDemo() {
		eligible, err := s.demoWorkEligible(ctx, displayWorkID)
		if err != nil {
			return voiceKnownWork{}, false, err
		}
		if !eligible {
			return voiceKnownWork{}, false, nil
		}
	}
	metadata := dlsiteCardMetadata(row.CardSummary, row.Snapshot)
	if tags, projected, err := s.loadProjectedDLsiteTags(ctx, displayWorkID); err != nil {
		return voiceKnownWork{}, false, err
	} else {
		metadata.Tags = presentProjectedTags(metadata.Tags, tags, projected)
	}
	sourceTags, remoteObservations, err := s.workSourceStateByCode(ctx, displayCode)
	if err != nil {
		return voiceKnownWork{}, false, err
	}
	progress, err := s.workProgressSummary(ctx, userID, displayWorkID)
	if err != nil {
		return voiceKnownWork{}, false, err
	}
	item, err := s.newVoiceKnownWork(ctx, row, displayCode, displayWorkID, remoteCode, metadata, sourceTags, remoteObservations, progress)
	if err != nil {
		return voiceKnownWork{}, false, err
	}
	return item, true, nil
}

func (s *Server) voiceKnownWorkIdentity(ctx context.Context, row voiceWorkRow) (string, int64, string, error) {
	ref, err := s.canonicalWorkForCode(ctx, row.PrimaryCode)
	if err != nil {
		return "", 0, "", err
	}
	displayCode, displayWorkID, remoteCode := row.PrimaryCode, row.ID, ""
	if ref.Known && ref.Code != "" {
		displayCode = ref.Code
		if !strings.EqualFold(row.PrimaryCode, ref.Code) {
			remoteCode = row.PrimaryCode
		}
		if ref.WorkID > 0 {
			displayWorkID = ref.WorkID
		}
	}
	return displayCode, displayWorkID, remoteCode, nil
}

func (s *Server) newVoiceKnownWork(
	ctx context.Context,
	row voiceWorkRow,
	displayCode string,
	displayWorkID int64,
	remoteCode string,
	metadata dlsiteSnapshotMetadata,
	sourceTags []circleSourceStat,
	remoteObservations []voiceRemoteObservation,
	progress workProgressSummary,
) (voiceKnownWork, error) {
	if row.CircleLink.Valid {
		if name, externalID := parsePartyLink(row.CircleLink.String); name != "" {
			metadata.Circle, metadata.CircleExternalID = name, externalID
		}
	}
	releaseDate := sqlutil.String(row.ReleaseDate)
	updatedAt := ""
	if releaseDate != nil {
		updatedAt = *releaseDate
	}
	item := voiceKnownWork{
		WorkID: displayWorkID, PrimaryCode: displayCode, RemoteCode: remoteCode, Title: row.Title,
		ReleaseDate: releaseDate, UpdatedAt: updatedAt, CoverURL: s.coverURL(displayCode), DLsiteURL: s.dlsiteURL(displayCode),
		Circle: metadata.Circle, CircleExternalID: metadata.CircleExternalID, AgeRating: row.AgeRating, Rating: row.Rating,
		RatingCount: metadata.RatingCount, Sales: row.Sales, RegularPrice: row.RegularPrice, Price: row.Price,
		PriceCurrency: row.PriceCurrency, PermanentlyFree: row.PermanentlyFree, Tags: metadata.Tags,
		VoiceActors: metadata.VoiceActors, Series: metadata.Series, SeriesTitleID: row.SeriesTitleID,
		ListeningMark: row.ListeningStatus, Favorite: row.Favorite,
		Local: row.HasLocal || sourceStatsContain(sourceTags, "local"), Remote: row.HasRemote || sourceStatsContain(sourceTags, "remote"),
		Cache: row.HasCache || sourceStatsContain(sourceTags, "cache"), SourceTags: sourceTags,
		RemoteObservations: remoteObservations, Progress: progress,
	}
	voiceCredits, err := s.voiceCreditsForWork(ctx, displayWorkID)
	if err != nil {
		return voiceKnownWork{}, err
	}
	item.VoiceCredits = voiceCredits
	if err := s.applyManualOverridesToVoiceWork(ctx, &item); err != nil {
		return voiceKnownWork{}, err
	}
	return item, nil
}

func mergeVoiceKnownWork(target *voiceKnownWork, item voiceKnownWork) {
	mergeVoiceKnownWorkIdentity(target, item)
	mergeVoiceKnownWorkMetadata(target, item)
	mergeVoiceKnownWorkState(target, item)
}

func mergeVoiceKnownWorkIdentity(target *voiceKnownWork, item voiceKnownWork) {
	if target.Title == "" || strings.EqualFold(target.Title, target.PrimaryCode) {
		target.Title = item.Title
	}
	if target.RemoteCode == "" {
		target.RemoteCode = item.RemoteCode
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

func mergeVoiceKnownWorkMetadata(target *voiceKnownWork, item voiceKnownWork) {
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
	if len(target.Tags) == 0 {
		target.Tags = item.Tags
	}
	if len(target.UserTags) == 0 {
		target.UserTags = item.UserTags
	}
	if target.Series == "" {
		target.Series = item.Series
		target.SeriesTitleID = item.SeriesTitleID
	}
}

func mergeVoiceKnownWorkState(target *voiceKnownWork, item voiceKnownWork) {
	if target.ListeningMark == "" || target.ListeningMark == "none" {
		target.ListeningMark = item.ListeningMark
	}
	target.Favorite = target.Favorite || item.Favorite
	target.Local = target.Local || item.Local
	target.Remote = target.Remote || item.Remote
	target.Cache = target.Cache || item.Cache
	target.SourceTags = mergeVoiceSourceStats(target.SourceTags, item.SourceTags)
	target.RemoteObservations = mergeVoiceRemoteObservations(target.RemoteObservations, item.RemoteObservations)
	if target.Progress.MediaItemID == nil {
		target.Progress = item.Progress
	}
}

func mergeVoiceRemoteObservations(left []voiceRemoteObservation, right []voiceRemoteObservation) []voiceRemoteObservation {
	result := append([]voiceRemoteObservation{}, left...)
	seen := map[string]int{}
	for index, item := range result {
		seen[voiceRemoteObservationKey(item)] = index
	}
	for _, item := range right {
		key := voiceRemoteObservationKey(item)
		if index, ok := seen[key]; ok {
			if voiceSourceStatusPriority(item.Status) > voiceSourceStatusPriority(result[index].Status) {
				result[index] = item
			}
			continue
		}
		seen[key] = len(result)
		result = append(result, item)
	}
	return result
}

func voiceRemoteObservationKey(item voiceRemoteObservation) string {
	return fmt.Sprintf("%d:%s", item.SourceID, strings.ToUpper(strings.TrimSpace(item.RemoteCode)))
}

func sourceStatsContain(items []circleSourceStat, key string) bool {
	for _, item := range items {
		if item.Status != "available" && item.Count <= 0 {
			continue
		}
		if item.Key == key || (key == "remote" && strings.HasPrefix(item.Key, "source:")) {
			return true
		}
	}
	return false
}

func mergeVoiceSourceStats(left []circleSourceStat, right []circleSourceStat) []circleSourceStat {
	result := append([]circleSourceStat{}, left...)
	seen := map[string]int{}
	for index, item := range result {
		seen[circleSourceStatKey(item)] = index
	}
	for _, item := range right {
		key := circleSourceStatKey(item)
		if index, ok := seen[key]; ok {
			if voiceSourceStatusPriority(item.Status) > voiceSourceStatusPriority(result[index].Status) {
				result[index].Status = item.Status
			}
			if item.Count > result[index].Count {
				result[index].Count = item.Count
			}
			continue
		}
		seen[key] = len(result)
		result = append(result, item)
	}
	return result
}

func voiceRemoteSourceErrorStatus(err error, ctxErr error) (string, string) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctxErr, context.DeadlineExceeded) {
		return "timeout", "Remote source timed out."
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout", "Remote source timed out."
	}
	var syntaxErr *json.SyntaxError
	if errors.As(err, &syntaxErr) {
		return "invalid_response", "Remote source returned an invalid response."
	}
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) {
		return "invalid_response", "Remote source returned an invalid response."
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "api url is not configured"):
		return "misconfigured", "Remote source API endpoint is not configured."
	case strings.Contains(message, "connection refused"),
		strings.Contains(message, "no such host"),
		strings.Contains(message, "network is unreachable"),
		strings.Contains(message, "server misbehaving"):
		return "unavailable", "Remote source is unavailable."
	case strings.Contains(message, "remote source returned http"):
		return "unavailable", "Remote source is unavailable."
	default:
		return "error", "Remote source is unavailable."
	}
}
