package httpapi

import (
	"context"
	"strings"

	"github.com/yexca/kikoto/backend/internal/library"
)

func (s *Server) enrichLibraryWorkSummaries(ctx context.Context, userID int64, works []libraryWorkSummary) error {
	if len(works) == 0 {
		return nil
	}
	workIDs, fallbackCodes, primaryCodes := librarySummaryEnrichmentKeys(works)
	mediaSelections, err := s.libraryStore.LoadMediaSelections(ctx, workIDs)
	if err != nil {
		return err
	}
	fallbackSelections, err := s.libraryStore.LoadFallbackMediaSelections(ctx, fallbackCodes)
	if err != nil {
		return err
	}
	mediaWorkIDs := applyLibraryMediaSelections(works, mediaSelections, fallbackSelections)
	data, err := s.loadLibrarySummaryEnrichment(ctx, userID, workIDs, mediaWorkIDs, primaryCodes)
	if err != nil {
		return err
	}
	return s.applyLibrarySummaryEnrichment(ctx, userID, works, data)
}

func librarySummaryEnrichmentKeys(works []libraryWorkSummary) ([]int64, []string, []string) {
	workIDs := make([]int64, 0, len(works))
	fallbackCodes := []string{}
	primaryCodes := make([]string, 0, len(works))
	for index := range works {
		workIDs = append(workIDs, works[index].ID)
		primaryCodes = append(primaryCodes, works[index].PrimaryCode)
		fallbackCodes = append(fallbackCodes, works[index].fallbackEditionCodes...)
	}
	return workIDs, fallbackCodes, primaryCodes
}

func applyLibraryMediaSelections(works []libraryWorkSummary, mediaSelections map[int64]library.MediaSelection, fallbackSelections map[string]library.MediaSelection) []int64 {
	mediaWorkIDs := make([]int64, 0, len(works))
	for index := range works {
		selection, ok := mediaSelections[works[index].ID]
		if !ok {
			for _, code := range works[index].fallbackEditionCodes {
				if candidate, found := fallbackSelections[strings.ToUpper(strings.TrimSpace(code))]; found {
					selection, ok = candidate, true
					break
				}
			}
		}
		if ok {
			works[index].mediaWorkID = selection.WorkID
		}
		mediaWorkIDs = append(mediaWorkIDs, works[index].mediaWorkID)
	}
	return mediaWorkIDs
}

type librarySummaryEnrichmentData struct {
	availability map[int64]library.Availability
	series       map[string]string
	overrides    map[int64][]library.ManualOverrideRow
	progress     map[int64]library.Progress
	nonOrigin    map[int64]bool
}

func (s *Server) loadLibrarySummaryEnrichment(ctx context.Context, userID int64, workIDs, mediaWorkIDs []int64, primaryCodes []string) (librarySummaryEnrichmentData, error) {
	availability, err := s.libraryStore.LoadAvailability(ctx, mediaWorkIDs)
	if err != nil {
		return librarySummaryEnrichmentData{}, err
	}
	series, err := s.libraryStore.LoadSeries(ctx, primaryCodes)
	if err != nil {
		return librarySummaryEnrichmentData{}, err
	}
	overrides, err := s.libraryStore.LoadManualOverrides(ctx, workIDs)
	if err != nil {
		return librarySummaryEnrichmentData{}, err
	}
	progress, err := s.libraryStore.LoadProgress(ctx, userID, workIDs)
	if err != nil {
		return librarySummaryEnrichmentData{}, err
	}
	nonOrigin, err := s.loadAvailableNonOriginEditions(ctx, workIDs)
	if err != nil {
		return librarySummaryEnrichmentData{}, err
	}
	return librarySummaryEnrichmentData{
		availability: availability, series: series, overrides: overrides,
		progress: progress, nonOrigin: nonOrigin,
	}, nil
}

func (s *Server) applyLibrarySummaryEnrichment(ctx context.Context, userID int64, works []libraryWorkSummary, data librarySummaryEnrichmentData) error {
	for index := range works {
		works[index].HasNonOrigin = data.nonOrigin[works[index].ID]
		credits, err := s.voiceCreditsForWork(ctx, works[index].ID)
		if err != nil {
			return err
		}
		works[index].VoiceCredits = credits
		if item, ok := data.availability[works[index].mediaWorkID]; ok && works[index].mediaWorkID != works[index].ID {
			works[index].TrackCount = item.TrackCount
			works[index].AvailableLocations = item.AvailableLocations
			works[index].Availability = availabilityBadgesWithPresence(item.LocationTypes, works[index].SourcePresence)
		}
		if titleID := data.series[strings.ToUpper(strings.TrimSpace(works[index].PrimaryCode))]; titleID != "" {
			works[index].SeriesTitleID = titleID
		}
		if rows := data.overrides[works[index].ID]; len(rows) > 0 {
			overrides := workManualOverrides{}
			for _, row := range rows {
				s.applyManualOverrideRow(&overrides, manualOverrideRow{
					FieldName: row.FieldName, ValueJSON: row.ValueJSON, AssetPath: row.AssetPath,
				})
			}
			applyManualOverridesToLibrarySummary(&works[index], overrides)
		}
		if item, ok := data.progress[works[index].ID]; ok {
			works[index].Progress = workProgressSummary{
				WorkID: item.WorkID, MediaWorkID: item.MediaWorkID, MediaItemID: item.MediaItemID,
				FileSourceID: item.FileSourceID, LocationID: item.LocationID, LocationType: item.LocationType,
				Title: item.Title, PositionSeconds: item.PositionSeconds,
				DurationSeconds: item.DurationSeconds, LastPlayedAt: item.LastPlayedAt, Completed: item.Completed,
			}
		}
		if len(works[index].Availability) == 0 {
			works[index].Availability = availabilityBadgesWithPresence(works[index].availableLocationTypes, works[index].SourcePresence)
		}
	}
	return nil
}
