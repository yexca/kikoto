package library

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type MediaSelection struct {
	WorkID          int64
	Code            string
	TranslationKind string
}

type Availability struct {
	TrackCount         int64
	AvailableLocations int64
	LocationTypes      string
}

type ManualOverrideRow struct {
	FieldName string
	ValueJSON string
	AssetPath string
}

type Progress struct {
	WorkID          *int64
	MediaWorkID     *int64
	MediaItemID     *int64
	FileSourceID    *int64
	LocationID      *int64
	LocationType    string
	Title           string
	PositionSeconds float64
	DurationSeconds *float64
	LastPlayedAt    *string
	Completed       bool
}

func (s *Store) LoadMediaSelections(ctx context.Context, workIDs []int64) (map[int64]MediaSelection, error) {
	result := map[int64]MediaSelection{}
	query, args := int64InQuery(`
		SELECT current.work_id, edition.work_id, edition.primary_code, edition.translation_kind
		FROM work_edition AS current
		INNER JOIN work_edition AS edition ON edition.logical_work_id = current.logical_work_id
		WHERE current.work_id IN (%s)
			AND EXISTS (SELECT 1 FROM media_item WHERE media_item.work_id = edition.work_id)
		ORDER BY current.work_id,
			EXISTS (
				SELECT 1
				FROM media_item AS local_item
				INNER JOIN media_file_location AS local_location ON local_location.media_item_id = local_item.id
				WHERE local_item.work_id = edition.work_id
					AND local_location.location_type = 'local'
					AND local_location.availability = 'available'
			) DESC,
			edition.is_canonical DESC,
			edition.primary_code ASC
	`, workIDs)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var currentID int64
		var selection MediaSelection
		if err := rows.Scan(&currentID, &selection.WorkID, &selection.Code, &selection.TranslationKind); err != nil {
			return nil, err
		}
		if _, exists := result[currentID]; !exists {
			result[currentID] = selection
		}
	}
	return result, rows.Err()
}

func (s *Store) LoadFallbackMediaSelections(ctx context.Context, codes []string) (map[string]MediaSelection, error) {
	result := map[string]MediaSelection{}
	values := uniqueUpperStrings(codes)
	if len(values) == 0 {
		return result, nil
	}
	query, args := stringInQuery(`
		SELECT work.id, work.primary_code, COALESCE(edition.translation_kind, 'unknown')
		FROM work
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		WHERE UPPER(work.primary_code) IN (%s)
			AND EXISTS (SELECT 1 FROM media_item WHERE media_item.work_id = work.id)
	`, values)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item MediaSelection
		if err := rows.Scan(&item.WorkID, &item.Code, &item.TranslationKind); err != nil {
			return nil, err
		}
		result[strings.ToUpper(strings.TrimSpace(item.Code))] = item
	}
	return result, rows.Err()
}

func (s *Store) LoadAvailability(ctx context.Context, workIDs []int64) (map[int64]Availability, error) {
	result := map[int64]Availability{}
	query, args := int64InQuery(`
		SELECT work.id,
			(SELECT COUNT(*) FROM media_item WHERE media_item.work_id = work.id AND (media_item.kind = 'audio' OR (media_item.kind = 'video' AND COALESCE(media_item.has_audio, 1) = 1))),
			(SELECT COUNT(*) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND (media_item.kind = 'audio' OR (media_item.kind = 'video' AND COALESCE(media_item.has_audio, 1) = 1)) AND media_file_location.availability = 'available'),
			COALESCE((SELECT GROUP_CONCAT(DISTINCT media_file_location.location_type) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND media_file_location.availability = 'available'), '')
		FROM work WHERE work.id IN (%s)
	`, uniqueInt64s(workIDs))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var item Availability
		if err := rows.Scan(&workID, &item.TrackCount, &item.AvailableLocations, &item.LocationTypes); err != nil {
			return nil, err
		}
		result[workID] = item
	}
	return result, rows.Err()
}

func (s *Store) LoadSeries(ctx context.Context, codes []string) (map[string]string, error) {
	values := uniqueUpperStrings(codes)
	result := map[string]string{}
	query, args := stringInQuery(`
		SELECT series_work.primary_code, series.title_id
		FROM party_series_work AS series_work
		INNER JOIN party_series AS series ON series.id = series_work.series_id
		WHERE UPPER(series_work.primary_code) IN (%s)
		ORDER BY series_work.primary_code, series.last_seen_at DESC, series.id DESC
	`, values)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var code, titleID string
		if err := rows.Scan(&code, &titleID); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if _, exists := result[code]; !exists {
			result[code] = titleID
		}
	}
	return result, rows.Err()
}

func (s *Store) LoadManualOverrides(ctx context.Context, workIDs []int64) (map[int64][]ManualOverrideRow, error) {
	result := map[int64][]ManualOverrideRow{}
	query, args := int64InQuery(`SELECT work_id, field_name, value_json, asset_path FROM work_manual_override WHERE work_id IN (%s) ORDER BY work_id, field_name`, uniqueInt64s(workIDs))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var row ManualOverrideRow
		if err := rows.Scan(&workID, &row.FieldName, &row.ValueJSON, &row.AssetPath); err != nil {
			return nil, err
		}
		result[workID] = append(result[workID], row)
	}
	return result, rows.Err()
}

func (s *Store) LoadProgress(ctx context.Context, userID int64, workIDs []int64) (map[int64]Progress, error) {
	result := map[int64]Progress{}
	query, args := int64InQuery(`
		SELECT requested_work.id, playback_cursor.work_id, media_item.work_id, media_item.id,
			playback_cursor.file_source_id, playback_cursor.location_id,
			playback_cursor.location_type, media_item.title,
			playback_cursor.position_seconds, playback_cursor.duration_seconds,
			playback_cursor.last_played_at, playback_cursor.completed
		FROM work AS requested_work
		LEFT JOIN work_edition AS requested_edition ON requested_edition.work_id = requested_work.id
		LEFT JOIN logical_work AS requested_logical ON requested_logical.id = requested_edition.logical_work_id
		INNER JOIN user_work_playback_cursor AS playback_cursor
			ON playback_cursor.work_id = COALESCE(
				requested_logical.canonical_work_id,
				(
					SELECT canonical_edition.work_id
					FROM work_edition AS canonical_edition
					WHERE canonical_edition.logical_work_id = requested_edition.logical_work_id
						AND canonical_edition.is_canonical = 1
					ORDER BY canonical_edition.work_id ASC
					LIMIT 1
				),
				requested_work.id
			)
			AND playback_cursor.user_id = ?
		INNER JOIN media_item ON media_item.id = playback_cursor.media_item_id
		WHERE requested_work.id IN (%s)
			AND (media_item.kind = 'audio' OR (media_item.kind = 'video' AND COALESCE(media_item.has_audio, 1) = 1))
		ORDER BY requested_work.id
	`, uniqueInt64s(workIDs))
	args = append([]any{userID}, args...)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var requestedWorkID int64
		var workID, mediaWorkID, mediaItemID, fileSourceID, locationID sql.NullInt64
		var locationType sql.NullString
		var title sql.NullString
		var position, duration sql.NullFloat64
		var lastPlayedAt sql.NullString
		var completed sql.NullBool
		if err := rows.Scan(
			&requestedWorkID, &workID, &mediaWorkID, &mediaItemID, &fileSourceID, &locationID,
			&locationType, &title, &position, &duration, &lastPlayedAt, &completed,
		); err != nil {
			return nil, err
		}
		result[requestedWorkID] = Progress{
			WorkID: nullableInt64(workID), MediaWorkID: nullableInt64(mediaWorkID), MediaItemID: nullableInt64(mediaItemID),
			FileSourceID: nullableInt64(fileSourceID), LocationID: nullableInt64(locationID),
			LocationType: locationType.String, Title: title.String,
			PositionSeconds: position.Float64, DurationSeconds: nullableFloat64(duration),
			LastPlayedAt: nullableString(lastPlayedAt), Completed: completed.Valid && completed.Bool,
		}
	}
	return result, rows.Err()
}

func int64InQuery(format string, values []int64) (string, []any) {
	values = uniqueInt64s(values)
	args := make([]any, len(values))
	for index, value := range values {
		args[index] = value
	}
	return fmt.Sprintf(format, placeholders(len(values))), args
}

func stringInQuery(format string, values []string) (string, []any) {
	args := make([]any, len(values))
	for index, value := range values {
		args[index] = value
	}
	return fmt.Sprintf(format, placeholders(len(values))), args
}

func placeholders(count int) string {
	if count <= 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func uniqueInt64s(values []int64) []int64 {
	result := []int64{}
	seen := map[int64]bool{}
	for _, value := range values {
		if value <= 0 || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func uniqueUpperStrings(values []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.ToUpper(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func nullableFloat64(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}
