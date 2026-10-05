package httpapi

import (
	"context"

	"github.com/yexca/kikoto/backend/internal/metadatatitles"
)

type workTitleChoices map[string]metadatatitles.Selection

type workTitleInputs = metadatatitles.Inputs

// Lists and search results share a bounded, batched presentation read. No
// metadata requests or additional work identities are created by this read.
func (s *Server) loadWorkTitleInputs(ctx context.Context, ids []int64, descriptions bool) (map[int64]workTitleInputs, error) {
	return loadWorkTitleInputs(ctx, s.db, ids, descriptions)
}

func loadWorkTitleInputs(ctx context.Context, db metadatatitles.Querier, ids []int64, descriptions bool) (map[int64]workTitleInputs, error) {
	return metadatatitles.LoadInputs(ctx, db, ids, descriptions)
}

func (s *Server) loadWorkTitles(ctx context.Context, ids []int64) (map[int64]metadatatitles.Selection, error) {
	inputs, err := s.loadWorkTitleInputs(ctx, ids, false)
	if err != nil {
		return nil, err
	}
	result := make(map[int64]metadatatitles.Selection, len(inputs))
	priorities := s.viewerMetadataLanguages(ctx)
	for id, input := range inputs {
		result[id] = metadatatitles.Select(input.Variants, input.Manual, priorities, input.Fallback)
	}
	return result, nil
}

func (s *Server) loadWorkTitleSelection(ctx context.Context, workID int64) (metadatatitles.Selection, map[string]metadatatitles.Selection, error) {
	inputs, err := s.loadWorkTitleInputs(ctx, []int64{workID}, true)
	if err != nil {
		return metadatatitles.Selection{}, nil, err
	}
	input := inputs[workID]
	choices := map[string]metadatatitles.Selection{}
	for _, language := range []string{"", "ja-jp", "zh-cn", "zh-tw", "en-us", "ko-kr", "origin"} {
		choices[language], _ = metadatatitles.ForLanguage(input.Variants, input.Manual, language, input.Fallback)
	}
	return metadatatitles.Select(input.Variants, input.Manual, s.viewerMetadataLanguages(ctx), input.Fallback), choices, nil
}
