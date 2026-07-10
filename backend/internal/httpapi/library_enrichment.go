package httpapi

import (
	"context"
	"strings"
)

func (s *Server) enrichLibraryWorkSummaries(ctx context.Context, userID int64, works []libraryWorkSummary) error {
	if len(works) == 0 {
		return nil
	}
	workIDs := make([]int64, 0, len(works))
	fallbackCodes := []string{}
	primaryCodes := make([]string, 0, len(works))
	for index := range works {
		workIDs = append(workIDs, works[index].ID)
		primaryCodes = append(primaryCodes, works[index].PrimaryCode)
		fallbackCodes = append(fallbackCodes, works[index].fallbackEditionCodes...)
	}
	mediaSelections, err := s.libraryStore.LoadMediaSelections(ctx, workIDs)
	if err != nil {
		return err
	}
	fallbackSelections, err := s.libraryStore.LoadFallbackMediaSelections(ctx, fallbackCodes)
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
			works[index].mediaWorkID = selection.WorkID
			if !strings.EqualFold(selection.Code, works[index].PrimaryCode) {
				works[index].MediaEditionCode = selection.Code
				works[index].MediaEditionKind = selection.TranslationKind
				works[index].OfficialTranslation = selection.TranslationKind == "official"
			}
		}
		mediaWorkIDs = append(mediaWorkIDs, works[index].mediaWorkID)
	}
	availability, err := s.libraryStore.LoadAvailability(ctx, mediaWorkIDs)
	if err != nil {
		return err
	}
	series, err := s.libraryStore.LoadSeries(ctx, primaryCodes)
	if err != nil {
		return err
	}
	overrideRows, err := s.libraryStore.LoadManualOverrides(ctx, workIDs)
	if err != nil {
		return err
	}
	progress, err := s.libraryStore.LoadProgress(ctx, userID, mediaWorkIDs)
	if err != nil {
		return err
	}
	for index := range works {
		if item, ok := availability[works[index].mediaWorkID]; ok && works[index].mediaWorkID != works[index].ID {
			works[index].TrackCount = item.TrackCount
			works[index].AvailableLocations = item.AvailableLocations
			works[index].Availability = availabilityBadgesWithPresence(item.LocationTypes, works[index].SourcePresence)
		}
		if titleID := series[strings.ToUpper(strings.TrimSpace(works[index].PrimaryCode))]; titleID != "" {
			works[index].SeriesTitleID = titleID
		}
		if rows := overrideRows[works[index].ID]; len(rows) > 0 {
			overrides := workManualOverrides{}
			for _, row := range rows {
				s.applyManualOverrideRow(&overrides, manualOverrideRow{
					FieldName: row.FieldName, ValueJSON: row.ValueJSON, AssetPath: row.AssetPath,
				})
			}
			applyManualOverridesToLibrarySummary(&works[index], overrides)
		}
		if item, ok := progress[works[index].mediaWorkID]; ok {
			works[index].Progress = workProgressSummary{
				MediaItemID: item.MediaItemID, Title: item.Title, PositionSeconds: item.PositionSeconds,
				DurationSeconds: item.DurationSeconds, LastPlayedAt: item.LastPlayedAt, Completed: item.Completed,
			}
		}
		if len(works[index].Availability) == 0 {
			works[index].Availability = availabilityBadgesWithPresence(works[index].availableLocationTypes, works[index].SourcePresence)
		}
	}
	return nil
}
