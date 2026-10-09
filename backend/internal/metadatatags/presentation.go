package metadatatags

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"sort"
	"strings"
)

// Presentation applies the work's overrides to an edition's genres without
// rewriting provider tags_json. Unknown legacy names remain readable while
// startup converts old rows into concepts. A named language uses that
// language's own name and otherwise the stored priority-selected name.
func Presentation(ctx context.Context, q Querier, workID, sourceID int64, legacy []string, languages ...string) ([]string, error) {
	return PresentationFor(ctx, q, workID, sourceID, legacy, nil, languages...)
}

// PresentationFor is Presentation for a viewer whose metadata language
// priority may differ from the instance default: the viewer's
// priority-selected name replaces the stored one. Nil priorities keep the
// stored names.
func PresentationFor(ctx context.Context, q Querier, workID, sourceID int64, legacy []string, priorities []string, languages ...string) ([]string, error) {
	var genreCount int
	if err := q.QueryRowContext(ctx, "SELECT COUNT(*) FROM work_dlsite_genre WHERE work_id=?", sourceID).Scan(&genreCount); err != nil {
		return nil, err
	}
	fallback := []int64{}
	unknown := []string{}
	if genreCount == 0 {
		for _, name := range legacy {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			id, err := legacyConceptID(ctx, q, name)
			if errors.Is(err, sql.ErrNoRows) {
				unknown = append(unknown, name)
			} else if err != nil {
				return nil, err
			} else {
				fallback = append(fallback, id)
			}
		}
	}
	tags, err := Effective(ctx, q, workID, sourceID, fallback)
	if err != nil {
		return nil, err
	}
	language := ""
	if len(languages) > 0 {
		language = languages[0]
	}
	ids := make([]int64, 0, len(tags))
	for _, tag := range tags {
		ids = append(ids, tag.ID)
	}
	names, err := loadNamesBatch(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	result := []string{}
	for _, tag := range tags {
		name := tag.DisplayName
		if priorities != nil {
			name = displayName(names[tag.ID], priorities, name)
		}
		if language != "" {
			if localized := languageName(names[tag.ID], language); localized != "" {
				name = localized
			}
		}
		result = append(result, name)
	}
	result = append(result, unknown...)
	return result, nil
}

func Inherited(ctx context.Context, q Querier, sourceID int64, legacy []string) ([]EffectiveTag, error) {
	ids := []int64{}
	if len(legacy) == 0 {
		var err error
		ids, err = Base(ctx, q, sourceID)
		if err != nil {
			return nil, err
		}
	}
	for _, name := range legacy {
		id, err := legacyConceptID(ctx, q, strings.TrimSpace(name))
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return Effective(ctx, q, 0, sourceID, ids)
}

// Read the same dictionary-first identity that EnsureLegacyTx writes, so an
// snapshot without genre ids can still restore its inherited tags.
func legacyConceptID(ctx context.Context, q Querier, name string) (int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, "SELECT concept.tag_id FROM metadata_tag AS concept INNER JOIN dlsite_genre_name AS name ON name.genre_id=concept.dlsite_genre_id WHERE LOWER(TRIM(name.name))=LOWER(?) ORDER BY concept.tag_id LIMIT 1", name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		hash := sha256.Sum256([]byte(strings.ToLower(name)))
		err = q.QueryRowContext(ctx, "SELECT id FROM tag WHERE namespace='metadata' AND normalized_name=?", "dlsite-name:"+hex.EncodeToString(hash[:])).Scan(&id)
	}
	return id, err
}

// LocalizedNames returns, for each concept id with any known name, the name
// the given metadata language priority selects: each language's manual name,
// the universal manual name, its dictionary or provider name, then Japanese,
// then any name. It is the per-viewer counterpart of the stored display name.
func LocalizedNames(ctx context.Context, q Querier, ids []int64, priorities []string) (map[int64]string, error) {
	names, err := loadNamesBatch(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	result := make(map[int64]string, len(names))
	for id, candidates := range names {
		if name := displayName(candidates, priorities, ""); name != "" {
			result[id] = name
		}
	}
	return result, nil
}

// Localize replaces each tag's stored display name with the name priorities
// select and restores the case-insensitive name order of Read.
func Localize(ctx context.Context, q Querier, tags []EffectiveTag, priorities []string) ([]EffectiveTag, error) {
	ids := make([]int64, 0, len(tags))
	for _, tag := range tags {
		ids = append(ids, tag.ID)
	}
	names, err := LocalizedNames(ctx, q, ids, priorities)
	if err != nil {
		return nil, err
	}
	result := make([]EffectiveTag, len(tags))
	for index, tag := range tags {
		if name, ok := names[tag.ID]; ok {
			tag.DisplayName = name
		}
		result[index] = tag
	}
	sort.SliceStable(result, func(i, j int) bool {
		left, right := strings.ToLower(result[i].DisplayName), strings.ToLower(result[j].DisplayName)
		if left != right {
			return left < right
		}
		return result[i].ID < result[j].ID
	})
	return result, nil
}

// loadNamesBatch reads the names of many concepts in the same precedence
// order as loadNames.
func loadNamesBatch(ctx context.Context, q Querier, ids []int64) (map[int64][]Name, error) {
	result := map[int64][]Name{}
	for start := 0; start < len(ids); start += 300 {
		end := min(start+300, len(ids))
		placeholders := strings.TrimSuffix(strings.Repeat("?,", end-start), ",")
		args := make([]any, 0, 3*(end-start))
		for range 3 {
			for _, id := range ids[start:end] {
				args = append(args, id)
			}
		}
		rows, err := q.QueryContext(ctx, `SELECT tag_id,language,name,'manual',0 FROM metadata_tag_name WHERE tag_id IN (`+placeholders+`)
 UNION ALL SELECT concept.tag_id,name.language,name.name,'dlsite',1 FROM metadata_tag AS concept
  INNER JOIN dlsite_genre_name AS name ON name.genre_id=concept.dlsite_genre_id WHERE concept.tag_id IN (`+placeholders+`)
 UNION ALL SELECT tag_id,language,name,'provider',2 FROM metadata_tag_provider_name WHERE tag_id IN (`+placeholders+`)
 ORDER BY 1,5,2`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			var n Name
			var rank int
			if err := rows.Scan(&id, &n.Language, &n.Name, &n.Source, &rank); err != nil {
				_ = rows.Close()
				return nil, err
			}
			result[id] = append(result[id], n)
		}
		if err := closeRows(rows); err != nil {
			return nil, err
		}
	}
	return result, nil
}
