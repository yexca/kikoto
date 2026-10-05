package metadatatags

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
)

// Presentation applies the work's overrides to an edition's genres without
// rewriting provider tags_json. Unknown legacy names remain readable while
// startup converts old rows into concepts.
func Presentation(ctx context.Context, q Querier, workID, sourceID int64, legacy []string, languages ...string) ([]string, error) {
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
	result := []string{}
	for _, tag := range tags {
		name := tag.DisplayName
		if len(languages) > 0 && languages[0] != "" {
			var genre sql.NullInt64
			if err := q.QueryRowContext(ctx, "SELECT dlsite_genre_id FROM metadata_tag WHERE tag_id=?", tag.ID).Scan(&genre); err != nil {
				return nil, err
			}
			names, err := loadNames(ctx, q, tag.ID, genre.Int64)
			if err != nil {
				return nil, err
			}
			if localized := languageName(names, languages[0]); localized != "" {
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
// old snapshot without genre ids can still restore its inherited tags.
func legacyConceptID(ctx context.Context, q Querier, name string) (int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, "SELECT concept.tag_id FROM metadata_tag AS concept INNER JOIN dlsite_genre_name AS name ON name.genre_id=concept.dlsite_genre_id WHERE LOWER(TRIM(name.name))=LOWER(?) ORDER BY concept.tag_id LIMIT 1", name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		hash := sha256.Sum256([]byte(strings.ToLower(name)))
		err = q.QueryRowContext(ctx, "SELECT id FROM tag WHERE namespace='metadata' AND normalized_name=?", "dlsite-name:"+hex.EncodeToString(hash[:])).Scan(&id)
	}
	return id, err
}
