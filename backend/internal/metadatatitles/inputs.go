package metadatatitles

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
)

// Inputs holds everything title selection reads for one work: the family's
// DLsite editions or declared remote titles, the work's manual titles by
// language, and the canonical work row as the languageless fallback.
type Inputs struct {
	Variants []Variant
	Manual   map[string]string
	Fallback Variant
}

type Querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// LoadInputs is a bounded, batched read shared by lists, search results and
// the title sort projection. It makes no metadata requests and creates no
// work identity.
func LoadInputs(ctx context.Context, db Querier, ids []int64, descriptions bool) (map[int64]Inputs, error) {
	result := map[int64]Inputs{}
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
		// The work row remains the fallback. Provider-declared remote language
		// titles are loaded with the edition variants below.
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
			input := Inputs{Manual: map[string]string{}}
			if err := rows.Scan(&id, &input.Fallback.Code, &input.Fallback.Title, &input.Fallback.Description, &input.Fallback.Language, &input.Fallback.RemoteSource); err != nil {
				_ = rows.Close()
				return nil, err
			}
			input.Fallback.Language = EditionLanguage(input.Fallback.Language)
			input.Fallback.Origin = true
			result[id] = input
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
		rows, err = db.QueryContext(ctx, `WITH requested AS (SELECT id FROM work WHERE id IN (`+placeholders+`)),
 title_variants AS (
   SELECT requested.id AS work_id, edition.primary_code, variant.edition_language,
   variant.title, `+editionDescription+` AS description, edition.is_canonical,
   '' AS remote_source, 0 AS remote_origin, variant.fetched_at, variant.id AS variant_id
   FROM requested
   JOIN work_edition AS current ON current.work_id=requested.id
   JOIN dlsite_metadata_variant AS variant ON variant.logical_work_id=current.logical_work_id
   JOIN work_edition AS edition ON edition.work_id=variant.work_id
   JOIN work AS edition_work ON edition_work.id=variant.work_id
   UNION ALL
   SELECT variant.work_id,variant.edition_code,variant.edition_language,variant.title,'',
   (variant.language='origin'),provider.display_name,(variant.language='origin'),'',0
   FROM remote_metadata_title_variant AS variant JOIN metadata_provider AS provider ON provider.id=variant.provider_id
   WHERE variant.work_id IN (SELECT id FROM requested)
   AND NOT EXISTS (SELECT 1 FROM metadata_snapshot AS snapshot JOIN metadata_provider AS higher ON higher.id=snapshot.provider_id
    WHERE snapshot.work_id=variant.work_id AND higher.code NOT GLOB 'kikoeru_source_*')
   AND NOT EXISTS (SELECT 1 FROM work_edition AS current JOIN dlsite_metadata_variant AS higher ON higher.logical_work_id=current.logical_work_id
    WHERE current.work_id=variant.work_id)
 ) SELECT work_id,primary_code,edition_language,title,description,is_canonical,remote_source
 FROM title_variants ORDER BY work_id,remote_origin DESC,fetched_at DESC,variant_id DESC,edition_language`, args...)
		if err != nil {
			return nil, err
		}
		seen := map[int64]map[string]bool{}
		for rows.Next() {
			var id int64
			var language string
			var variant Variant
			if err := rows.Scan(&id, &variant.Code, &language, &variant.Title, &variant.Description, &variant.Origin, &variant.RemoteSource); err != nil {
				_ = rows.Close()
				return nil, err
			}
			variant.Language = EditionLanguage(language)
			input, exists := result[id]
			if !exists {
				continue
			}
			if variant.RemoteSource != "" {
				if seen[id] == nil {
					seen[id] = map[string]bool{}
				}
				key := variant.Code + "\x00" + variant.Language
				if seen[id][key] {
					continue
				}
				seen[id][key] = true
			}
			input.Variants = append(input.Variants, variant)
			result[id] = input
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
