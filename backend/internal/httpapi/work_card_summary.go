package httpapi

import (
	"context"
	"strings"
)

func (s *Server) loadAvailableNonOriginEditions(ctx context.Context, workIDs []int64) (map[int64]bool, error) {
	result := map[int64]bool{}
	workIDs = uniquePositiveInt64s(workIDs)
	if len(workIDs) == 0 {
		return result, nil
	}
	query, args := int64InQuery(`
		SELECT current.work_id
		FROM work_edition AS current
		INNER JOIN work_edition AS sibling
			ON sibling.logical_work_id = current.logical_work_id
			AND sibling.is_canonical = 0
		WHERE current.work_id IN (%s)
			AND (
				EXISTS (
					SELECT 1
					FROM media_item AS item
					INNER JOIN media_file_location AS location ON location.media_item_id = item.id
					INNER JOIN file_source AS source ON source.id = location.file_source_id
					WHERE item.work_id = sibling.work_id
						AND location.availability = 'available'
						AND source.enabled = 1
				)
				OR EXISTS (
					SELECT 1
					FROM work_source_presence AS presence
					INNER JOIN file_source AS source ON source.id = presence.file_source_id
					WHERE presence.work_id = sibling.work_id
						AND presence.availability = 'available'
						AND source.enabled = 1
				)
			)
		GROUP BY current.work_id
	`, workIDs)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		if err := rows.Scan(&workID); err != nil {
			return nil, err
		}
		result[workID] = true
	}
	return result, rows.Err()
}

func (s *Server) enrichTrackedPresenceForkState(ctx context.Context, code string, items []sourcePresenceItem) {
	sourceIDs := []int64{}
	for index := range items {
		if strings.EqualFold(items[index].Type, "tracked") && items[index].FileSourceID > 0 {
			sourceIDs = append(sourceIDs, items[index].FileSourceID)
		}
	}
	sourceIDs = uniquePositiveInt64s(sourceIDs)
	if len(sourceIDs) == 0 {
		return
	}
	familyWorkIDs, err := s.familyWorkIDsForCode(ctx, code)
	if err != nil || len(familyWorkIDs) == 0 {
		return
	}
	workQuery, workArgs := int64InQuery("item.work_id IN (%s)", familyWorkIDs)
	sourceQuery, sourceArgs := int64InQuery("location.file_source_id IN (%s)", sourceIDs)
	args := append(workArgs, sourceArgs...)
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT location.file_source_id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE `+workQuery+`
			AND `+sourceQuery+`
			AND location.location_type = 'remote_stream'
			AND location.availability = 'available'
	`, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	forked := map[int64]bool{}
	for rows.Next() {
		var sourceID int64
		if err := rows.Scan(&sourceID); err != nil {
			return
		}
		forked[sourceID] = true
	}
	if err := rows.Err(); err != nil {
		return
	}
	for index := range items {
		if !strings.EqualFold(items[index].Type, "tracked") || items[index].FileSourceID <= 0 {
			continue
		}
		value := forked[items[index].FileSourceID]
		items[index].Forked = &value
	}
}

func uniquePositiveInt64s(values []int64) []int64 {
	result := make([]int64, 0, len(values))
	seen := map[int64]struct{}{}
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
