package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// Circle reads keep SQL projection, availability aggregation, and catalog
// presentation together behind the HTTP composition layer.

func (s *Server) loadCircleWorks(ctx context.Context, userID int64, partyID int64) ([]circleCatalogWork, error) {
	works, _, err := s.loadCircleWorksPage(ctx, userID, partyID, circleWorksQuery{Page: 1, PageSize: 100, Availability: "all"})
	return works, err
}

// circleCatalogLogicalPage selects the logical works before any per-work
// enrichment. Keeping this query separate prevents the detail endpoint from
// doing the expensive enrichment queries for works that are outside the page.
func (s *Server) circleCatalogLogicalPage(ctx context.Context, partyID int64, worksQuery circleWorksQuery) ([]string, int, error) {
	demoCatalogWhere := ""
	if s.cfg.IsDemo() {
		demoCatalogWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("catalog_work")
	}
	query := `WITH projected_codes AS (
		SELECT DISTINCT
			UPPER(COALESCE(catalog_logical.canonical_code, catalog.primary_code)) AS logical_code,
			COALESCE(catalog.release_date, '') AS release_date,
			LOWER(COALESCE(catalog.primary_code, '') || ' ' || COALESCE(catalog.title, '') || ' ' ||
				COALESCE(catalog.release_date, '') || ' ' || COALESCE(catalog.catalog_status, '') || ' ' ||
				COALESCE(catalog_work.title, '') || ' ' || COALESCE(canonical_work.title, '')) AS search_text,
			COALESCE(canonical_work.title, catalog_work.title, catalog.title, '') AS sort_title,
			COALESCE(canonical_work.rating_average, catalog_work.rating_average) AS rating,
			COALESCE(canonical_work.sales_count, catalog_work.sales_count) AS sales
		FROM ` + circleCatalogProjection + ` AS catalog
		LEFT JOIN work AS catalog_work ON UPPER(catalog_work.primary_code) = UPPER(catalog.primary_code)
		LEFT JOIN work_edition AS catalog_edition ON catalog_edition.work_id = catalog_work.id
		LEFT JOIN logical_work AS catalog_logical ON catalog_logical.id = catalog_edition.logical_work_id
		LEFT JOIN work AS canonical_work ON canonical_work.id = catalog_logical.canonical_work_id
		WHERE catalog.party_id = ?` + demoCatalogWhere + `)`
	args := []any{partyID}

	if worksQuery.Availability != "" && worksQuery.Availability != "all" {
		demoWorkWhere := ""
		if s.cfg.IsDemo() {
			demoWorkWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("work")
		}
		demoRemoteWorkWhere := ""
		if s.cfg.IsDemo() {
			demoRemoteWorkWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("remote_work")
		}
		demoPresenceWorkWhere := ""
		if s.cfg.IsDemo() {
			demoPresenceWorkWhere = " AND " + contentpolicy.DemoEligibleWorkSQL("presence_work")
		}
		query += `, availability_codes AS (
			SELECT UPPER(COALESCE(logical.canonical_code, work.primary_code)) AS logical_code,
				MAX(CASE WHEN location.location_type = 'local' THEN 1 ELSE 0 END) AS local_available,
				MAX(CASE WHEN location.location_type = 'local' THEN 0 ELSE 1 END) AS remote_available
			FROM work_primary_circle AS relation
			INNER JOIN work ON work.id = relation.work_id
			INNER JOIN media_item AS item ON item.work_id = work.id
			INNER JOIN media_file_location AS location ON location.media_item_id = item.id
			LEFT JOIN work_edition AS edition ON edition.work_id = work.id
			LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			WHERE relation.party_id = ? AND location.availability = 'available'` + demoWorkWhere + `
			GROUP BY logical_code
			UNION ALL
			SELECT UPPER(COALESCE(remote_logical.canonical_code, remote_catalog.primary_code)), 0, 1
			FROM ` + circleCatalogProjection + ` AS remote_catalog
			INNER JOIN metadata_provider AS remote_provider ON remote_provider.id = remote_catalog.provider_id
			INNER JOIN file_source AS remote_source ON remote_provider.code = 'kikoeru_source_' || remote_source.code
			LEFT JOIN work AS remote_work ON UPPER(remote_work.primary_code) = UPPER(remote_catalog.primary_code)
			LEFT JOIN work_edition AS remote_edition ON remote_edition.work_id = remote_work.id
			LEFT JOIN logical_work AS remote_logical ON remote_logical.id = remote_edition.logical_work_id
			WHERE remote_catalog.party_id = ?
				AND remote_source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
				AND remote_source.enabled = 1` + demoRemoteWorkWhere + `
			UNION ALL
			SELECT UPPER(COALESCE(presence_logical.canonical_code, presence_work.primary_code)), 0, 1
			FROM work_primary_circle AS presence_relation
			INNER JOIN work AS presence_work ON presence_work.id = presence_relation.work_id
			INNER JOIN work_source_presence AS presence ON presence.work_id = presence_work.id
			INNER JOIN file_source AS presence_source ON presence_source.id = presence.file_source_id
			LEFT JOIN work_edition AS presence_edition ON presence_edition.work_id = presence_work.id
			LEFT JOIN logical_work AS presence_logical ON presence_logical.id = presence_edition.logical_work_id
			WHERE presence_relation.party_id = ? AND presence.presence_type = 'source'
				AND presence.availability = 'available' AND presence_source.enabled = 1` + demoPresenceWorkWhere + `
		), availability AS (
			SELECT logical_code, MAX(local_available) AS local_available, MAX(remote_available) AS remote_available
			FROM availability_codes GROUP BY logical_code
		)`
		args = append(args, partyID, partyID, partyID)
	}
	query += `, logical_candidates AS (
		SELECT logical_code, MAX(release_date) AS release_date, MAX(search_text) AS search_text,
			MAX(sort_title) AS sort_title, MAX(rating) AS rating, MAX(sales) AS sales
		FROM projected_codes GROUP BY logical_code
	)
	SELECT candidates.logical_code
	FROM logical_candidates AS candidates`
	if worksQuery.Availability != "" && worksQuery.Availability != "all" {
		query += ` LEFT JOIN availability ON availability.logical_code = candidates.logical_code`
	}
	where := []string{}
	if worksQuery.Query != "" {
		where = append(where, "candidates.search_text LIKE ? ESCAPE '\\'")
		needle := strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(strings.ToLower(worksQuery.Query))
		args = append(args, "%"+needle+"%")
	}
	if worksQuery.Series != "" {
		where = append(where, `EXISTS (
			SELECT 1
			FROM party_series_work AS series_work
			INNER JOIN party_series AS series ON series.id = series_work.series_id
			LEFT JOIN work AS series_work_record ON UPPER(series_work_record.primary_code) = UPPER(series_work.primary_code)
			LEFT JOIN work_edition AS series_edition ON series_edition.work_id = series_work_record.id
			LEFT JOIN logical_work AS series_logical ON series_logical.id = series_edition.logical_work_id
			WHERE series.party_id = ? AND UPPER(series.title_id) = UPPER(?)
				AND UPPER(COALESCE(series_logical.canonical_code, series_work.primary_code)) = candidates.logical_code
		)`)
		args = append(args, partyID, worksQuery.Series)
	}
	switch worksQuery.Availability {
	case "available":
		where = append(where, "(COALESCE(availability.local_available, 0) = 1 OR COALESCE(availability.remote_available, 0) = 1)")
	case "unavailable":
		where = append(where, "COALESCE(availability.local_available, 0) = 0 AND COALESCE(availability.remote_available, 0) = 0")
	case "local":
		where = append(where, "COALESCE(availability.local_available, 0) = 1")
	case "remote":
		where = append(where, "COALESCE(availability.remote_available, 0) = 1")
	}
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	countQuery := "SELECT COUNT(*) FROM (" + query + ") AS filtered"
	var total int
	if err := s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	page := worksQuery.Page
	if page < 1 {
		page = 1
	}
	pageSize := worksQuery.PageSize
	if pageSize < 1 || pageSize > 100 {
		pageSize = 24
	}
	pageQuery := query + " ORDER BY " + circleWorksOrderBy(worksQuery.Sort, worksQuery.Direction) + " LIMIT ? OFFSET ?"
	pageArgs := append(append([]any{}, args...), pageSize, (page-1)*pageSize)
	rows, err := s.db.QueryContext(ctx, pageQuery, pageArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, 0, err
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return codes, total, nil
}

func (s *Server) loadCircleWorksPage(ctx context.Context, userID int64, partyID int64, worksQuery circleWorksQuery) ([]circleCatalogWork, int, error) {
	if worksQuery.Page < 1 {
		worksQuery.Page = 1
	}
	if worksQuery.PageSize < 1 || worksQuery.PageSize > 100 {
		worksQuery.PageSize = 24
	}
	logicalCodes, total, err := s.circleCatalogLogicalPage(ctx, partyID, worksQuery)
	if err != nil || len(logicalCodes) == 0 {
		return []circleCatalogWork{}, total, err
	}
	selectedParts := make([]string, 0, len(logicalCodes))
	selectedArgs := make([]any, 0, len(logicalCodes)+5)
	for _, code := range logicalCodes {
		selectedParts = append(selectedParts, "SELECT ? AS logical_code")
		selectedArgs = append(selectedArgs, code)
	}
	selectedLogicalCodes := strings.Join(selectedParts, " UNION ALL ")
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
			`+selectedLogicalCodes+`
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
	`, append([]any{partyID}, append(selectedArgs, partyID, partyID, partyID, userID)...)...)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = rows.Close() }()
	// Enrichment issues further queries, so the cursor must release its pooled
	// connection first. Concurrent requests that each held a cursor while
	// waiting for a second connection could otherwise exhaust the pool.
	catalogRows := []circleCatalogWorkRow{}
	for rows.Next() {
		row, err := scanCircleCatalogWorkRow(rows)
		if err != nil {
			return nil, 0, err
		}
		catalogRows = append(catalogRows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := rows.Close(); err != nil {
		return nil, 0, err
	}
	works := []circleCatalogWork{}
	seen := map[string]int{}
	for _, row := range catalogRows {
		item, include, err := s.buildCircleCatalogWork(ctx, row, userID, partyID)
		if err != nil {
			return nil, 0, err
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
		return nil, 0, err
	}
	worksWithLyrics, err := s.loadWorksWithLyrics(ctx, workIDs)
	if err != nil {
		return nil, 0, err
	}
	titles, err := s.loadWorkTitles(ctx, workIDs)
	if err != nil {
		return nil, 0, err
	}
	// The enrichment query reads the page's editions in its own order; the
	// page keeps the order its logical works were selected in.
	position := make(map[string]int, len(logicalCodes))
	for index, code := range logicalCodes {
		position[strings.ToUpper(code)] = index
	}
	sort.SliceStable(works, func(left, right int) bool {
		leftIndex, leftKnown := position[strings.ToUpper(works[left].PrimaryCode)]
		rightIndex, rightKnown := position[strings.ToUpper(works[right].PrimaryCode)]
		if leftKnown != rightKnown {
			return leftKnown
		}
		return leftKnown && leftIndex < rightIndex
	})
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
	return works, total, nil
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
