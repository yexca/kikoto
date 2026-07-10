package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type libraryMediaSelection struct {
	workID int64
	code   string
}

type libraryAvailability struct {
	trackCount         int64
	availableLocations int64
	locationTypes      string
}

func (s *Server) enrichLibraryWorkSummaries(ctx context.Context, userID int64, works []libraryWorkSummary) error {
	if len(works) == 0 {
		return nil
	}
	workIDs := make([]int64, 0, len(works))
	fallbackCodes := []string{}
	for index := range works {
		workIDs = append(workIDs, works[index].ID)
		fallbackCodes = append(fallbackCodes, works[index].fallbackEditionCodes...)
	}
	mediaSelections, err := s.loadLibraryMediaSelections(ctx, workIDs)
	if err != nil {
		return err
	}
	fallbackSelections, err := s.loadLibraryFallbackMediaSelections(ctx, fallbackCodes)
	if err != nil {
		return err
	}
	mediaWorkIDs := make([]int64, 0, len(works))
	for index := range works {
		selection, ok := mediaSelections[works[index].ID]
		if !ok {
			for _, code := range works[index].fallbackEditionCodes {
				if candidate, found := fallbackSelections[strings.ToUpper(strings.TrimSpace(code))]; found {
					selection = candidate
					ok = true
					break
				}
			}
		}
		if ok {
			works[index].mediaWorkID = selection.workID
			if !strings.EqualFold(selection.code, works[index].PrimaryCode) {
				works[index].MediaEditionCode = selection.code
				works[index].OfficialTranslation = true
			}
		}
		mediaWorkIDs = append(mediaWorkIDs, works[index].mediaWorkID)
	}
	availability, err := s.loadLibraryAvailability(ctx, mediaWorkIDs)
	if err != nil {
		return err
	}
	series, err := s.loadLibrarySeries(ctx, works)
	if err != nil {
		return err
	}
	overrides, err := s.loadLibraryManualOverrides(ctx, workIDs)
	if err != nil {
		return err
	}
	progress, err := s.loadLibraryProgress(ctx, userID, mediaWorkIDs)
	if err != nil {
		return err
	}
	for index := range works {
		if item, ok := availability[works[index].mediaWorkID]; ok && works[index].mediaWorkID != works[index].ID {
			works[index].TrackCount = item.trackCount
			works[index].AvailableLocations = item.availableLocations
			works[index].Availability = availabilityBadgesWithPresence(item.locationTypes, works[index].SourcePresence)
		}
		if titleID := series[strings.ToUpper(strings.TrimSpace(works[index].PrimaryCode))]; titleID != "" {
			works[index].SeriesTitleID = titleID
		}
		if item, ok := overrides[works[index].ID]; ok {
			applyManualOverridesToLibrarySummary(&works[index], item)
		}
		if item, ok := progress[works[index].mediaWorkID]; ok {
			works[index].Progress = item
		}
		if len(works[index].Availability) == 0 {
			works[index].Availability = availabilityBadgesWithPresence(works[index].availableLocationTypes, works[index].SourcePresence)
		}
	}
	return nil
}

func (s *Server) loadLibraryMediaSelections(ctx context.Context, workIDs []int64) (map[int64]libraryMediaSelection, error) {
	result := map[int64]libraryMediaSelection{}
	query, args := int64InQuery(`
		SELECT current.work_id, edition.work_id, edition.primary_code
		FROM work_edition AS current
		INNER JOIN work_edition AS edition ON edition.logical_work_id = current.logical_work_id
		WHERE current.work_id IN (%s)
			AND EXISTS (SELECT 1 FROM media_item WHERE media_item.work_id = edition.work_id)
		ORDER BY current.work_id, edition.is_canonical DESC, edition.primary_code ASC
	`, workIDs)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var currentID int64
		var selection libraryMediaSelection
		if err := rows.Scan(&currentID, &selection.workID, &selection.code); err != nil {
			return nil, err
		}
		if _, exists := result[currentID]; !exists {
			result[currentID] = selection
		}
	}
	return result, rows.Err()
}

func (s *Server) loadLibraryFallbackMediaSelections(ctx context.Context, codes []string) (map[string]libraryMediaSelection, error) {
	result := map[string]libraryMediaSelection{}
	values := uniqueUpperStrings(codes)
	if len(values) == 0 {
		return result, nil
	}
	query, args := stringInQuery(`
		SELECT work.id, work.primary_code
		FROM work
		WHERE UPPER(work.primary_code) IN (%s)
			AND EXISTS (SELECT 1 FROM media_item WHERE media_item.work_id = work.id)
	`, values)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item libraryMediaSelection
		if err := rows.Scan(&item.workID, &item.code); err != nil {
			return nil, err
		}
		result[strings.ToUpper(strings.TrimSpace(item.code))] = item
	}
	return result, rows.Err()
}

func (s *Server) loadLibraryAvailability(ctx context.Context, workIDs []int64) (map[int64]libraryAvailability, error) {
	result := map[int64]libraryAvailability{}
	query, args := int64InQuery(`
		SELECT
			work.id,
			(SELECT COUNT(*) FROM media_item WHERE media_item.work_id = work.id AND media_item.kind = 'audio'),
			(SELECT COUNT(*) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND media_item.kind = 'audio' AND media_file_location.availability = 'available'),
			COALESCE((SELECT GROUP_CONCAT(DISTINCT media_file_location.location_type) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND media_file_location.availability = 'available'), '')
		FROM work
		WHERE work.id IN (%s)
	`, uniqueInt64s(workIDs))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var item libraryAvailability
		if err := rows.Scan(&workID, &item.trackCount, &item.availableLocations, &item.locationTypes); err != nil {
			return nil, err
		}
		result[workID] = item
	}
	return result, rows.Err()
}

func (s *Server) loadLibrarySeries(ctx context.Context, works []libraryWorkSummary) (map[string]string, error) {
	codes := make([]string, 0, len(works))
	for _, work := range works {
		codes = append(codes, work.PrimaryCode)
	}
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

func (s *Server) loadLibraryManualOverrides(ctx context.Context, workIDs []int64) (map[int64]workManualOverrides, error) {
	result := map[int64]workManualOverrides{}
	query, args := int64InQuery(`
		SELECT work_id, field_name, value_json, asset_path
		FROM work_manual_override
		WHERE work_id IN (%s)
		ORDER BY work_id, field_name
	`, uniqueInt64s(workIDs))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var row manualOverrideRow
		if err := rows.Scan(&workID, &row.FieldName, &row.ValueJSON, &row.AssetPath); err != nil {
			return nil, err
		}
		item := result[workID]
		s.applyManualOverrideRow(&item, row)
		result[workID] = item
	}
	return result, rows.Err()
}

func (s *Server) loadLibraryProgress(ctx context.Context, userID int64, workIDs []int64) (map[int64]workProgressSummary, error) {
	result := map[int64]workProgressSummary{}
	query, args := int64InQuery(`
		SELECT
			media_item.work_id,
			media_item.id,
			media_item.title,
			user_media_progress.position_seconds,
			user_media_progress.duration_seconds,
			user_media_progress.last_played_at,
			user_media_progress.completed
		FROM media_item
		INNER JOIN user_media_progress ON user_media_progress.media_item_id = media_item.id
		WHERE media_item.work_id IN (%s)
			AND media_item.kind = 'audio'
			AND user_media_progress.user_id = ?
		ORDER BY media_item.work_id, user_media_progress.last_played_at DESC, user_media_progress.updated_at DESC, media_item.id DESC
	`, uniqueInt64s(workIDs))
	args = append(args, userID)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var mediaItemID sql.NullInt64
		var title sql.NullString
		var position, duration sql.NullFloat64
		var lastPlayedAt sql.NullString
		var completed sql.NullBool
		if err := rows.Scan(&workID, &mediaItemID, &title, &position, &duration, &lastPlayedAt, &completed); err != nil {
			return nil, err
		}
		if _, exists := result[workID]; exists {
			continue
		}
		result[workID] = workProgressSummary{
			MediaItemID:     nullableInt64(mediaItemID),
			Title:           title.String,
			PositionSeconds: position.Float64,
			DurationSeconds: nullableFloat64(duration),
			LastPlayedAt:    nullableString(lastPlayedAt),
			Completed:       completed.Valid && completed.Bool,
		}
	}
	return result, rows.Err()
}

func stringInQuery(format string, values []string) (string, []any) {
	args := make([]any, len(values))
	for index, value := range values {
		args[index] = value
	}
	return fmt.Sprintf(format, queryPlaceholders(len(values))), args
}

func queryPlaceholders(count int) string {
	if count <= 0 {
		return "NULL"
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
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
