package httpapi

import (
	"context"
	"database/sql"
	"fmt"
)

// Circle reads keep SQL projection, availability aggregation, and catalog
// presentation together behind the HTTP composition layer.

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
	defer func() { _ = rows.Close() }()
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
	defer func() { _ = rows.Close() }()
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
	defer func() { _ = rows.Close() }()
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
