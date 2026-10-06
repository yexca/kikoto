package httpapi

import (
	"context"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metadatatitles"
)

// Remote language choices describe stored metadata, never playable editions or
// a successful DLsite sync. Their media identity remains the requested work.
func (s *Server) remoteTitlePresentation(ctx context.Context, workID int64, overrides workManualOverrides) ([]workMetadataVariant, error) {
	inputs, err := s.loadWorkTitleInputs(ctx, []int64{workID}, true)
	if err != nil {
		return nil, err
	}
	result := []workMetadataVariant{}
	hasLanguage := false
	for _, variant := range inputs[workID].Variants {
		if variant.RemoteSource != "" && variant.Language != "" {
			hasLanguage = true
			break
		}
	}
	if !hasLanguage {
		return result, nil
	}
	seen := map[string]bool{}
	for _, variant := range inputs[workID].Variants {
		if variant.RemoteSource == "" {
			continue
		}
		tags, err := metadatatags.PresentationFor(ctx, s.db, workID, workID, nil, s.viewerTagLanguages(ctx), variant.Language)
		if err != nil {
			return nil, err
		}
		choice := metadatatitles.ForEdition(variant, overrides.Titles)
		key := variant.Code
		if seen[key] {
			key = "remote:" + variant.Language + ":" + variant.Code
		}
		seen[key] = true
		result = append(result, workMetadataVariant{
			PresentationOnly: true, MetadataCode: variant.Code, Key: key, Language: variant.Language, Title: choice.Title,
			Description: choice.Description, TitleSource: choice.Source, Origin: variant.Origin, Tags: cleanProjectedTags(tags),
		})
	}
	return result, nil
}
