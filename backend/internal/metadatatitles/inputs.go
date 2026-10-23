package metadatatitles

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
)

// Inputs holds everything title selection reads for one work: the family's
// DLsite editions or declared remote titles, accepted machine fields and
// language-specific manual descriptions as variants, the work's manual titles
// by language, and the canonical work row as the languageless fallback.
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
		machineValue := "CASE WHEN field_name='title' THEN value_text ELSE '' END"
		machineSource := "CASE WHEN field_name='title' THEN source_text ELSE '' END"
		if descriptions {
			machineValue, machineSource = "value_text", "source_text"
		}
		// A language-specific manual description lets a language win selection,
		// so lists read it too; the universal description stays a detail overlay.
		rows, err = db.QueryContext(ctx, `SELECT work_id,language,field_name,value_json,'manual','' FROM work_manual_override WHERE (field_name='title' OR field_name='description' AND language<>'') AND work_id IN (`+placeholders+`)
 UNION ALL SELECT work_id,language,field_name,`+machineValue+`,'llm',`+machineSource+` FROM work_llm_translation WHERE status='accepted' AND work_id IN (`+placeholders+`) ORDER BY work_id,language`, append(append([]any{}, args...), args...)...)
		if err != nil {
			return nil, err
		}
		machines := map[int64]map[string]Variant{}
		manualDescriptions := map[int64]map[string]Variant{}
		for rows.Next() {
			var id int64
			var language, field, value, kind, source string
			if err := rows.Scan(&id, &language, &field, &value, &kind, &source); err != nil {
				_ = rows.Close()
				return nil, err
			}
			input, exists := result[id]
			if !exists {
				continue
			}
			if kind == "manual" {
				var text string
				if json.Unmarshal([]byte(value), &text) != nil || strings.TrimSpace(text) == "" {
					continue
				}
				if field == "title" {
					input.Manual[language] = text
				} else {
					if manualDescriptions[id] == nil {
						manualDescriptions[id] = map[string]Variant{}
					}
					manualDescriptions[id][language] = Variant{Language: language, Description: strings.TrimSpace(text), ManualDescription: true}
				}
				continue
			}
			origin := Original(input.Variants, input.Fallback)
			if field == "title" && source != origin.Title || field == "description" && descriptions && source != origin.Description {
				continue
			}
			if machines[id] == nil {
				machines[id] = map[string]Variant{}
			}
			v := machines[id][language]
			v.Code, v.Language, v.LLM = origin.Code, language, true
			if field == "title" {
				v.Title = value
			} else {
				v.Description = value
				v.LLMDescription = true
			}
			machines[id][language] = v
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
		for _, group := range []map[int64]map[string]Variant{machines, manualDescriptions} {
			for id, languages := range group {
				input := result[id]
				for _, language := range []string{"ja-jp", "zh-cn", "zh-tw", "en-us", "ko-kr"} {
					if v, exists := languages[language]; exists {
						input.Variants = append(input.Variants, v)
					}
				}
				result[id] = input
			}
		}

	}
	return result, nil
}
