package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
)

// Circle reads keep SQL projection, availability aggregation, and catalog
// presentation together behind the HTTP composition layer.

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
	defer func() { _ = rows.Close() }()
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
	defer func() { _ = remoteRows.Close() }()
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
