package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metadatatitles"
)

type workTitleChoices map[string]metadatatitles.Selection

type workTitleInputs struct {
	Variants []metadatatitles.Variant
	Manual   map[string]string
	Fallback metadatatitles.Variant
}

// Lists and search results share a bounded, batched presentation read. No
// metadata requests or additional work identities are created by this read.
func (s *Server) loadWorkTitleInputs(ctx context.Context, ids []int64, descriptions bool) (map[int64]workTitleInputs, error) {
	return loadWorkTitleInputs(ctx, s.db, ids, descriptions)
}

type workTitleQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func loadWorkTitleInputs(ctx context.Context, db workTitleQuerier, ids []int64, descriptions bool) (map[int64]workTitleInputs, error) {
	result := map[int64]workTitleInputs{}
	fallbackDescription, editionDescription := "''", "''"
	if descriptions {
		fallbackDescription = "COALESCE(original.description,requested.description)"
		editionDescription = "edition_work.description"
	}
	for start := 0; start < len(ids); start += 400 {
		end := min(start+400, len(ids))
		placeholders := strings.TrimSuffix(strings.Repeat("?,", end-start), ",")
		args := make([]any, end-start)
		for i, id := range ids[start:end] {
			args[i] = id
		}
		// A title a remote source filled stays a languageless fallback; only its
		// source name is presented.
		rows, err := db.QueryContext(ctx, `SELECT requested.id, COALESCE(original.primary_code,requested.primary_code),
 COALESCE(original.title,requested.title),`+fallbackDescription+`,COALESCE(origin.metadata_language,''),
 COALESCE((SELECT provider.display_name FROM work_metadata_field_source AS source
  JOIN metadata_provider AS provider ON provider.id=source.provider_id
  WHERE source.work_id=requested.id AND source.field_name='title'),'')
 FROM work AS requested
 LEFT JOIN work_edition AS current ON current.work_id=requested.id
 LEFT JOIN work_edition AS origin ON origin.logical_work_id=current.logical_work_id AND origin.is_canonical=1
 LEFT JOIN work AS original ON original.id=origin.work_id
 WHERE requested.id IN (`+placeholders+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			input := workTitleInputs{Manual: map[string]string{}}
			if err := rows.Scan(&id, &input.Fallback.Code, &input.Fallback.Title, &input.Fallback.Description, &input.Fallback.Language, &input.Fallback.RemoteSource); err != nil {
				_ = rows.Close()
				return nil, err
			}
			input.Fallback.Language = metadatatitles.EditionLanguage(input.Fallback.Language)
			input.Fallback.Origin = true
			result[id] = input
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
		rows, err = db.QueryContext(ctx, `SELECT requested.id, edition.primary_code, variant.edition_language,
   variant.title, `+editionDescription+`, edition.is_canonical
   FROM work AS requested
   JOIN work_edition AS current ON current.work_id=requested.id
   JOIN dlsite_metadata_variant AS variant ON variant.logical_work_id=current.logical_work_id
   JOIN work_edition AS edition ON edition.work_id=variant.work_id
   JOIN work AS edition_work ON edition_work.id=variant.work_id
   WHERE requested.id IN (`+placeholders+`) ORDER BY variant.fetched_at DESC, variant.id DESC`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			var language string
			var variant metadatatitles.Variant
			if err := rows.Scan(&id, &variant.Code, &language, &variant.Title, &variant.Description, &variant.Origin); err != nil {
				_ = rows.Close()
				return nil, err
			}
			variant.Language = metadatatitles.EditionLanguage(language)
			input, exists := result[id]
			if exists {
				input.Variants = append(input.Variants, variant)
				result[id] = input
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
		rows, err = db.QueryContext(ctx, `SELECT work_id,language,value_json FROM work_manual_override WHERE field_name='title' AND work_id IN (`+placeholders+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			var language, encoded, title string
			if err := rows.Scan(&id, &language, &encoded); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if json.Unmarshal([]byte(encoded), &title) == nil {
				input, exists := result[id]
				if exists {
					input.Manual[language] = title
				}
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
	}
	return result, nil
}

func (s *Server) loadWorkTitles(ctx context.Context, ids []int64) (map[int64]metadatatitles.Selection, error) {
	inputs, err := s.loadWorkTitleInputs(ctx, ids, false)
	if err != nil {
		return nil, err
	}
	result := make(map[int64]metadatatitles.Selection, len(inputs))
	priorities := s.preferredMetadataLanguages(ctx)
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
	return metadatatitles.Select(input.Variants, input.Manual, s.preferredMetadataLanguages(ctx), input.Fallback), choices, nil
}
