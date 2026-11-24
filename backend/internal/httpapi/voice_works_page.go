package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/searchtext"
)

// voiceWorksQuery selects one page of a voice actor's works.
type voiceWorksQuery struct {
	Page     int
	PageSize int
	Query    string
	// Availability is all, available, local, remote, or missing.
	Availability string
	// Sort is release, code, title, rating, or sales; empty sorts by release.
	Sort string
	// Direction is asc or desc; empty sorts descending.
	Direction string
}

type voiceWorksPage struct {
	PersonID int64           `json:"personId"`
	Works    []voiceWorkView `json:"works"`
	Page     int             `json:"page"`
	PageSize int             `json:"pageSize"`
	Total    int             `json:"total"`
}

// voiceWorkView is one work of a voice actor: a known work carrying every
// remote observation of it, or a remote catalog work no local credit names.
// Exactly one of Known and Remote is set, and the view serializes as that
// work's own shape.
type voiceWorkView struct {
	Known  *voiceKnownWork
	Remote *voiceRemoteWork
	// RemoteObservations belongs to a remote catalog work; a known work keeps
	// its own.
	RemoteObservations []voiceRemoteObservation
}

func (view voiceWorkView) MarshalJSON() ([]byte, error) {
	if view.Known != nil {
		return json.Marshal(view.Known)
	}
	return json.Marshal(struct {
		*voiceRemoteWork
		RemoteObservations []voiceRemoteObservation `json:"remoteObservations"`
	}{view.Remote, view.RemoteObservations})
}

func parseVoiceWorksQuery(r *http.Request) voiceWorksQuery {
	pageSize := queryInt(r, "pageSize", 24)
	if pageSize > 100 {
		pageSize = 24
	}
	availability := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("availability")))
	switch availability {
	case "available", "local", "remote", "missing":
	default:
		availability = "all"
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 200 {
		query = query[:200]
	}
	sortKey, direction := normalizeCircleWorksSort(r.URL.Query().Get("sort"), r.URL.Query().Get("direction"))
	return voiceWorksQuery{
		Page:         queryInt(r, "page", 1),
		PageSize:     pageSize,
		Query:        query,
		Availability: availability,
		Sort:         sortKey,
		Direction:    direction,
	}
}

// loadVoiceWorksPage selects one page of the voice actor's logical works in
// SQL, then enriches only the works on that page. A page past the end
// resolves to the last page.
func (s *Server) loadVoiceWorksPage(ctx context.Context, userID, personID int64, worksQuery voiceWorksQuery) (voiceWorksPage, error) {
	entries, page, total, err := s.voiceWorksLogicalPage(ctx, userID, personID, worksQuery)
	if err != nil {
		return voiceWorksPage{}, err
	}
	works, err := s.loadVoiceWorkViews(ctx, userID, personID, entries)
	if err != nil {
		return voiceWorksPage{}, err
	}
	return voiceWorksPage{
		PersonID: personID, Works: works, Page: page,
		PageSize: min(max(worksQuery.PageSize, 1), 100), Total: total,
	}, nil
}

// voiceWorksPageEntry is one logical work selected for a page: its code and
// the works crediting the voice actor that belong to it. A remote catalog
// work no local credit names has no work ids.
type voiceWorksPageEntry struct {
	Code    string
	WorkIDs []int64
}

// voiceSourceStatusRankSQL ranks an availability column the way
// voiceSourceStatusPriority ranks its status, so the strongest observation of
// a source wins.
func voiceSourceStatusRankSQL(column string) string {
	return `CASE LOWER(TRIM(` + column + `))
		WHEN 'available' THEN 6 WHEN 'disabled' THEN 5 WHEN 'error' THEN 4
		WHEN 'unavailable' THEN 3 WHEN 'missing' THEN 2 WHEN 'not_found' THEN 2 ELSE 1 END`
}

// voiceWorksLogicalPage selects the page's logical works before any per-work
// enrichment, so filtering, ordering, and counting never load a work outside
// the page.
//
// A logical work is the canonical code of a work crediting the voice actor,
// or the code of a remote catalog work. Its family is every edition of that
// work Kikoto holds. The availability filter reads the family's available
// media locations and source presence and the catalog's source rows; the
// search reads the family's Library search documents and the catalog row.
func (s *Server) voiceWorksLogicalPage(ctx context.Context, userID, personID int64, worksQuery voiceWorksQuery) ([]voiceWorksPageEntry, int, int, error) {
	creditedDemoWhere, catalogDemoWhere := "", ""
	if s.cfg.IsDemo() {
		creditedDemoWhere = `
			WHERE EXISTS (
				SELECT 1 FROM work AS demo_work
				WHERE demo_work.id = resolved.display_work_id AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
			)`
		catalogDemoWhere = `
			AND EXISTS (
				SELECT 1 FROM work AS demo_work
				WHERE (demo_work.id = item.work_id OR UPPER(demo_work.primary_code) = UPPER(item.primary_code))
					AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
			)`
	}
	// An edition newest by release date, then by code, speaks for its work.
	firstCredited := func(column, where string) string {
		return `(SELECT edition.` + column + ` FROM credited AS edition
			WHERE edition.logical_code = known.logical_code` + where + `
			ORDER BY edition.release_date DESC, edition.primary_code DESC LIMIT 1)`
	}
	kikoeruSource := `provider.code = 'kikoeru_source_' || source.code
		AND source.source_type IN ('` + sourceTypeKikoeruCompatible + `', '` + sourceTypeKikoeruCompatible178 + `')`
	query := `WITH credited_identity AS (
		SELECT
			work.id AS work_id,
			work.primary_code,
			COALESCE(work.release_date, '') AS release_date,
			work.rating_average AS rating,
			work.sales_count AS sales,
			COALESCE((
				SELECT edition.logical_work_id FROM work_edition AS edition
				WHERE UPPER(edition.primary_code) = UPPER(work.primary_code)
				LIMIT 1
			), (
				SELECT alias.logical_work_id FROM work_code_alias AS alias
				WHERE UPPER(alias.primary_code) = UPPER(work.primary_code)
				ORDER BY CASE WHEN alias.source_work_id IS NOT NULL THEN 0 ELSE 1 END, alias.id
				LIMIT 1
			)) AS logical_work_id
		FROM work_credit AS credit
		INNER JOIN work ON work.id = credit.work_id
		WHERE credit.person_id = ? AND credit.role = 'voice_actor'
	), credited AS MATERIALIZED (
		SELECT * FROM (
			SELECT
				identity.work_id, identity.primary_code, identity.release_date, identity.rating, identity.sales,
				identity.logical_work_id,
				UPPER(TRIM(COALESCE(logical.canonical_code, identity.primary_code))) AS logical_code,
				COALESCE(logical.canonical_work_id, (
					SELECT canonical.id FROM work AS canonical WHERE canonical.primary_code = logical.canonical_code
				), identity.work_id) AS display_work_id
			FROM credited_identity AS identity
			LEFT JOIN logical_work AS logical ON logical.id = identity.logical_work_id
		) AS resolved` + creditedDemoWhere + `
	), known AS (
		SELECT logical_code, GROUP_CONCAT(work_id) AS work_ids, MAX(release_date) AS release_date
		FROM credited
		GROUP BY logical_code
	), catalog AS MATERIALIZED (
		SELECT
			item.id AS item_id,
			UPPER(TRIM(item.primary_code)) AS logical_code,
			item.work_id,
			item.title,
			item.circle,
			item.tags_json,
			COALESCE(item.release_date, '') AS release_date,
			item.rating_average AS rating,
			item.sales_count AS sales
		FROM voice_catalog_item AS item
		WHERE item.person_id = ? AND TRIM(item.primary_code) <> ''
			AND EXISTS (
				SELECT 1
				FROM voice_catalog_source AS catalog_source
				INNER JOIN metadata_provider AS provider ON provider.id = catalog_source.provider_id
				INNER JOIN file_source AS source ON ` + kikoeruSource + `
				WHERE catalog_source.catalog_item_id = item.id
			)` + catalogDemoWhere + `
	), candidates AS (
		SELECT
			known.logical_code,
			known.work_ids,
			known.release_date,
			COALESCE((
				SELECT ` + library.TitleSortExpression(s.viewerMetadataLanguages(ctx)) + `
				FROM work WHERE work.id = ` + firstCredited("display_work_id", "") + `
			), '') AS sort_title,
			` + firstCredited("rating", " AND edition.rating IS NOT NULL") + ` AS rating,
			` + firstCredited("sales", " AND edition.sales IS NOT NULL") + ` AS sales
		FROM known
		UNION ALL
		SELECT
			catalog.logical_code,
			'',
			MAX(catalog.release_date),
			MAX(COALESCE(NULLIF(catalog.title, ''), catalog.logical_code)),
			MAX(catalog.rating),
			MAX(catalog.sales)
		FROM catalog
		WHERE catalog.logical_code NOT IN (SELECT logical_code FROM known)
		GROUP BY catalog.logical_code
	), family AS MATERIALIZED (
		SELECT logical_code, work_id FROM credited
		UNION
		SELECT logical_code, display_work_id FROM credited
		UNION
		SELECT credited.logical_code, sibling.work_id
		FROM credited
		INNER JOIN work_edition AS sibling ON sibling.logical_work_id = credited.logical_work_id
		UNION
		SELECT logical_code, work_id FROM catalog WHERE work_id IS NOT NULL
		UNION
		SELECT catalog.logical_code, catalog_work.id
		FROM catalog
		INNER JOIN work AS catalog_work ON catalog_work.primary_code = catalog.logical_code
		UNION
		SELECT catalog.logical_code, sibling.work_id
		FROM catalog
		INNER JOIN work_edition AS own ON UPPER(own.primary_code) = catalog.logical_code
		INNER JOIN work_edition AS sibling ON sibling.logical_work_id = own.logical_work_id
	)`
	args := []any{personID, personID}

	filtered := worksQuery.Availability != "" && worksQuery.Availability != "all"
	if filtered {
		query += `, location_flags AS (
			SELECT
				family.logical_code,
				MAX(CASE WHEN location.location_type = 'local' AND location.availability = 'available' THEN 1 ELSE 0 END) AS has_local,
				MAX(CASE WHEN location.location_type IN ('remote_stream', 'remote_download') AND location.availability = 'available' THEN 1 ELSE 0 END) AS has_remote,
				MAX(CASE WHEN location.location_type = 'cache' AND location.availability = 'available' THEN 1 ELSE 0 END) AS has_cache
			FROM family
			INNER JOIN media_item AS item ON item.work_id = family.work_id
			INNER JOIN media_file_location AS location ON location.media_item_id = item.id
			GROUP BY family.logical_code
		), observations AS (
			SELECT family.logical_code, presence.file_source_id AS source_id,
				` + voiceSourceStatusRankSQL("presence.availability") + ` AS status_rank
			FROM family
			INNER JOIN work_source_presence AS presence ON presence.work_id = family.work_id
			WHERE presence.presence_type = ?
			UNION ALL
			SELECT catalog.logical_code, source.id,
				CASE
					WHEN source.enabled = 0 THEN 5
					WHEN TRIM(COALESCE(NULLIF(TRIM(endpoint.api_url), ''), endpoint.base_url, '')) = '' THEN 3
					WHEN ` + voiceSourceStatusRankSQL("catalog_source.availability") + ` = 1
						AND TRIM(catalog_source.last_seen_at) <> '' THEN 6
					ELSE ` + voiceSourceStatusRankSQL("catalog_source.availability") + `
				END
			FROM catalog
			-- CROSS JOIN keeps the voice actor's catalog rows as the outer loop.
			CROSS JOIN voice_catalog_source AS catalog_source ON catalog_source.catalog_item_id = catalog.item_id
			INNER JOIN metadata_provider AS provider ON provider.id = catalog_source.provider_id
			INNER JOIN file_source AS source ON ` + kikoeruSource + `
			LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		), source_state AS (
			SELECT logical_code, source_id, MAX(status_rank) AS status_rank
			FROM observations
			GROUP BY logical_code, source_id
		), observation_flags AS (
			SELECT
				logical_code,
				MAX(CASE WHEN status_rank = 6 THEN 1 ELSE 0 END) AS has_remote,
				MAX(CASE WHEN status_rank IN (2, 3) THEN 1 ELSE 0 END) AS has_missing
			FROM source_state
			GROUP BY logical_code
		)`
		args = append(args, sourcePresenceTypeRemoteSource)
	}
	query += `
	SELECT candidates.logical_code, candidates.work_ids
	FROM candidates`
	where := []string{}
	if filtered {
		query += `
		LEFT JOIN location_flags ON location_flags.logical_code = candidates.logical_code
		LEFT JOIN observation_flags ON observation_flags.logical_code = candidates.logical_code`
		local := "COALESCE(location_flags.has_local, 0) = 1"
		remote := "(COALESCE(location_flags.has_remote, 0) = 1 OR COALESCE(observation_flags.has_remote, 0) = 1)"
		available := "(" + local + " OR " + remote + " OR COALESCE(location_flags.has_cache, 0) = 1)"
		switch worksQuery.Availability {
		case "available":
			where = append(where, available)
		case "local":
			where = append(where, local)
		case "remote":
			where = append(where, remote)
		case "missing":
			// A source that failed, or was never checked, is not a missing work.
			where = append(where, "NOT "+available+" AND COALESCE(observation_flags.has_missing, 0) = 1")
		}
	}
	if needle := searchtext.Fold(worksQuery.Query); needle != "" {
		if s.libraryStore != nil {
			s.libraryStore.PrepareTextSearch(ctx)
		}
		textWhere, textArgs := library.TextSearchWhereForUser(worksQuery.Query, userID)
		fold := func(expression string) string { return searchtext.SQLFoldFunction + "(" + expression + ")" }
		where = append(where, `(EXISTS (
				SELECT 1 FROM family
				INNER JOIN work ON work.id = family.work_id
				WHERE family.logical_code = candidates.logical_code AND `+textWhere+`
			) OR EXISTS (
				SELECT 1 FROM catalog
				WHERE catalog.logical_code = candidates.logical_code AND (
					instr(`+fold("catalog.logical_code || char(10) || catalog.title || char(10) || catalog.circle")+`, ?) > 0
					OR EXISTS (
						SELECT 1
						FROM json_each(CASE WHEN json_valid(catalog.tags_json) THEN catalog.tags_json ELSE '[]' END) AS tag
						WHERE instr(`+fold("tag.value")+`, ?) > 0
					)
				)
			))`)
		args = append(args, textArgs...)
		args = append(args, needle, needle)
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM ("+query+") AS filtered", args...).Scan(&total); err != nil {
		return nil, 0, 0, err
	}
	page, start, end := creatorPageBounds(worksQuery.Page, worksQuery.PageSize, total)
	if start >= end {
		return []voiceWorksPageEntry{}, page, total, nil
	}
	rows, err := s.db.QueryContext(ctx,
		query+" ORDER BY "+voiceWorksOrderBy(worksQuery.Sort, worksQuery.Direction)+" LIMIT ? OFFSET ?",
		append(append([]any{}, args...), end-start, start)...)
	if err != nil {
		return nil, 0, 0, err
	}
	defer func() { _ = rows.Close() }()
	entries := []voiceWorksPageEntry{}
	for rows.Next() {
		var entry voiceWorksPageEntry
		var workIDs string
		if err := rows.Scan(&entry.Code, &workIDs); err != nil {
			return nil, 0, 0, err
		}
		for _, value := range strings.Split(workIDs, ",") {
			if id, err := strconv.ParseInt(value, 10, 64); err == nil && id > 0 {
				entry.WorkIDs = append(entry.WorkIDs, id)
			}
		}
		entries = append(entries, entry)
	}
	return entries, page, total, rows.Err()
}

// voiceWorksOrderBy orders the logical works by the chosen fact in either
// direction. Works that lack the fact stay last, and the code breaks ties so
// paging is stable.
func voiceWorksOrderBy(sortKey, direction string) string {
	sortKey, direction = normalizeCircleWorksSort(sortKey, direction)
	dir := "DESC"
	if direction == "asc" {
		dir = "ASC"
	}
	code := "candidates.logical_code " + dir
	switch sortKey {
	case "code":
		return code
	case "title":
		return "TRIM(candidates.sort_title) = '' ASC, candidates.sort_title COLLATE NOCASE " + dir + ", " + code
	case "rating":
		return "candidates.rating IS NULL ASC, candidates.rating " + dir + ", " + code
	case "sales":
		return "candidates.sales IS NULL ASC, candidates.sales " + dir + ", " + code
	default:
		return "candidates.release_date = '' ASC, candidates.release_date " + dir + ", " + code
	}
}

// loadVoiceWorkViews enriches the page's logical works and returns them in
// the order they were selected.
func (s *Server) loadVoiceWorkViews(ctx context.Context, userID, personID int64, entries []voiceWorksPageEntry) ([]voiceWorkView, error) {
	views := make([]voiceWorkView, 0, len(entries))
	if len(entries) == 0 {
		return views, nil
	}
	codes := make([]string, 0, len(entries))
	workIDs := []int64{}
	codeByWorkID := map[int64]string{}
	for _, entry := range entries {
		codes = append(codes, entry.Code)
		for _, id := range entry.WorkIDs {
			workIDs = append(workIDs, id)
			codeByWorkID[id] = entry.Code
		}
	}
	workRows, err := s.loadVoiceWorkRows(ctx, userID, personID, workIDs)
	if err != nil {
		return nil, err
	}
	known, knownCodes, err := s.buildVoiceKnownWorks(ctx, userID, workRows, func(row voiceWorkRow) string {
		return codeByWorkID[row.ID]
	})
	if err != nil {
		return nil, err
	}
	knownByCode := make(map[string]*voiceKnownWork, len(known))
	for index := range known {
		knownByCode[knownCodes[index]] = &known[index]
	}
	sets, err := s.loadVoiceCatalogMatchesForCodes(ctx, personID, codes)
	if err != nil {
		return nil, err
	}
	// A source whose last pass failed still contributes the rows it persisted
	// earlier.
	catalogByCode := map[string][]voiceRemoteWork{}
	for _, set := range sets {
		for _, work := range set.Works {
			code := voiceWorkCodeKey(work.PrimaryCode)
			catalogByCode[code] = append(catalogByCode[code], work)
		}
	}
	for _, code := range codes {
		if work, ok := knownByCode[code]; ok {
			views = append(views, knownVoiceWorkView(*work, catalogByCode[code]))
		} else if matches := catalogByCode[code]; len(matches) > 0 {
			views = append(views, remoteVoiceWorkView(matches))
		}
	}
	return views, nil
}

// knownVoiceWorkView folds the catalog rows of a known work into it: the work
// keeps its identity and gains every remote observation of it.
func knownVoiceWorkView(work voiceKnownWork, matches []voiceRemoteWork) voiceWorkView {
	preferredCodes := []string{work.RemoteCode}
	for _, observation := range work.RemoteObservations {
		if voiceSourceAvailabilityStatus(observation.Status) == "available" {
			preferredCodes = append(preferredCodes, observation.RemoteCode)
		}
	}
	preferredCodes = append(preferredCodes, work.PrimaryCode)
	observations := orderVoiceRemoteObservations(
		unionVoiceRemoteObservations(work.RemoteObservations, catalogRemoteObservations(matches)), preferredCodes,
	)
	if len(observations) > 0 {
		work.RemoteObservations = observations
		work.SourceTags = sourceTagsWithObservations(work.SourceTags, observations)
	}
	return voiceWorkView{Known: &work}
}

// remoteVoiceWorkView presents the catalog rows of a work no local credit
// names as one work, described by its first row.
func remoteVoiceWorkView(matches []voiceRemoteWork) voiceWorkView {
	work := matches[0]
	return voiceWorkView{
		Remote: &work,
		RemoteObservations: orderVoiceRemoteObservations(
			catalogRemoteObservations(matches), []string{work.RemoteCode, work.PrimaryCode},
		),
	}
}

// catalogRemoteObservations reads one observation per source and remote code
// from the catalog rows of a work.
func catalogRemoteObservations(works []voiceRemoteWork) []voiceRemoteObservation {
	observations := []voiceRemoteObservation{}
	seen := map[string]bool{}
	for _, work := range works {
		remoteCode := strings.TrimSpace(firstNonEmpty(work.RemoteCode, work.PrimaryCode))
		if work.SourceID <= 0 || remoteCode == "" {
			continue
		}
		observation := voiceRemoteObservation{
			SourceID: work.SourceID, SourceCode: work.SourceCode, SourceName: work.SourceName, RemoteCode: remoteCode,
		}
		key := voiceRemoteObservationKey(observation)
		if seen[key] {
			continue
		}
		seen[key] = true
		status := work.Availability
		if status == "" && work.RemotePlayable {
			status = "available"
		}
		observation.Status = voiceSourceAvailabilityStatus(status)
		observations = append(observations, observation)
	}
	return observations
}

// unionVoiceRemoteObservations keeps one observation per source and remote
// code. A later observation replaces an earlier one unless it reports a weaker
// status.
func unionVoiceRemoteObservations(groups ...[]voiceRemoteObservation) []voiceRemoteObservation {
	result := []voiceRemoteObservation{}
	indexes := map[string]int{}
	for _, group := range groups {
		for _, observation := range group {
			observation.RemoteCode = strings.TrimSpace(observation.RemoteCode)
			if observation.SourceID <= 0 || observation.RemoteCode == "" {
				continue
			}
			observation.Status = voiceSourceAvailabilityStatus(observation.Status)
			key := voiceRemoteObservationKey(observation)
			index, ok := indexes[key]
			if !ok {
				indexes[key] = len(result)
				result = append(result, observation)
				continue
			}
			if voiceSourceStatusPriority(observation.Status) >= voiceSourceStatusPriority(result[index].Status) {
				result[index] = observation
			}
		}
	}
	return result
}

// orderVoiceRemoteObservations moves the observations of the preferred remote
// codes first, in the order those codes are given.
func orderVoiceRemoteObservations(observations []voiceRemoteObservation, preferredCodes []string) []voiceRemoteObservation {
	preferred := make([]string, 0, len(preferredCodes))
	for _, code := range preferredCodes {
		if key := voiceWorkCodeKey(code); key != "" {
			preferred = append(preferred, key)
		}
	}
	rank := func(observation voiceRemoteObservation) int {
		key := voiceWorkCodeKey(observation.RemoteCode)
		for index, code := range preferred {
			if code == key {
				return index
			}
		}
		return len(preferred)
	}
	sort.SliceStable(observations, func(left, right int) bool {
		return rank(observations[left]) < rank(observations[right])
	})
	return observations
}

// sourceTagsWithObservations adds a source tag for every observed remote
// source and raises a tag whose observation reports a stronger status.
func sourceTagsWithObservations(tags []circleSourceStat, observations []voiceRemoteObservation) []circleSourceStat {
	result := make([]circleSourceStat, 0, len(tags)+len(observations))
	indexes := map[string]int{}
	place := func(tag circleSourceStat, replace func(existing circleSourceStat) bool) {
		key := tag.Key
		if tag.SourceID != nil && *tag.SourceID > 0 {
			key = "source:" + strconv.FormatInt(*tag.SourceID, 10)
		}
		index, ok := indexes[key]
		if !ok {
			indexes[key] = len(result)
			result = append(result, tag)
			return
		}
		if replace(result[index]) {
			result[index] = tag
		}
	}
	for _, tag := range tags {
		place(tag, func(circleSourceStat) bool { return true })
	}
	for _, observation := range observations {
		sourceID := observation.SourceID
		tag := circleSourceStat{
			Key:         "source:" + strconv.FormatInt(sourceID, 10),
			SourceID:    &sourceID,
			DisplayName: firstNonEmpty(observation.SourceName, observation.SourceCode, "Remote source"),
			Status:      voiceSourceAvailabilityStatus(observation.Status),
		}
		if tag.Status == "available" {
			tag.Count = 1
		}
		place(tag, func(existing circleSourceStat) bool {
			return voiceSourceStatusPriority(tag.Status) > voiceSourceStatusPriority(existing.Status)
		})
	}
	return result
}

func voiceWorkCodeKey(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}
