package metadatatags

import (
	"context"
	"database/sql"
	"strings"
)

// ProviderTag is one tag a non-DLsite provider declared for a work. Name is the
// provider's primary name; Names holds its localized names by supported locale
// ("" when the provider gave no language). Every value is untrusted input that
// the caller has already bounded.
type ProviderTag struct {
	Name  string
	Names map[string]string
}

// ProviderConceptsTx maps provider tags onto shared concepts. A tag reuses the
// concept whose known name equals its primary or any localized name (ignoring
// case), so a remote name that matches a DLsite genre joins that genre. A tag
// without a match gets the same deterministic name concept that legacy imports
// use. The provider's localized names fill only absent cells of concepts that
// have no DLsite genre id, then those concepts' display names are refreshed.
func ProviderConceptsTx(ctx context.Context, tx *sql.Tx, providerID int64, tags []ProviderTag, priorities []string) ([]int64, error) {
	candidates := []string{}
	for _, tag := range tags {
		candidates = append(candidates, providerTagCandidates(tag)...)
	}
	known, err := FindByNames(ctx, tx, candidates)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	seen := map[int64]bool{}
	refresh := []int64{}
	for _, tag := range tags {
		names := providerTagCandidates(tag)
		if len(names) == 0 {
			continue
		}
		id := int64(0)
		for _, name := range names {
			if match, ok := known[name]; ok {
				id = match
				break
			}
		}
		if id == 0 {
			if id, err = EnsureLegacyTx(ctx, tx, names[0]); err != nil {
				return nil, err
			}
			for _, name := range names {
				known[name] = id
			}
		}
		added, err := addProviderNamesTx(ctx, tx, id, providerID, tag)
		if err != nil {
			return nil, err
		}
		if added {
			refresh = append(refresh, id)
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if len(refresh) > 0 {
		if err := RefreshNamesTx(ctx, tx, priorities, refresh...); err != nil {
			return nil, err
		}
	}
	return ids, nil
}

// The primary name is tried first, then Japanese, then the other localized
// names in a stable order, so matching does not depend on map iteration.
func providerTagCandidates(tag ProviderTag) []string {
	result := []string{}
	seen := map[string]bool{}
	add := func(name string) {
		name = strings.TrimSpace(name)
		key := strings.ToLower(name)
		if name == "" || seen[key] {
			return
		}
		seen[key] = true
		result = append(result, name)
	}
	add(tag.Name)
	for _, language := range []string{"ja-jp", "", "zh-cn", "zh-tw", "en-us", "ko-kr"} {
		add(tag.Names[language])
	}
	return result
}

func addProviderNamesTx(ctx context.Context, tx *sql.Tx, id, providerID int64, tag ProviderTag) (bool, error) {
	var genre sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT dlsite_genre_id FROM metadata_tag WHERE tag_id=?", id).Scan(&genre); err != nil {
		return false, err
	}
	if genre.Valid {
		return false, nil
	}
	added := false
	for _, language := range []string{"", "ja-jp", "zh-cn", "zh-tw", "en-us", "ko-kr"} {
		name := strings.TrimSpace(tag.Names[language])
		if name == "" || len(name) > 512 {
			continue
		}
		result, err := tx.ExecContext(ctx, `INSERT INTO metadata_tag_provider_name(tag_id,language,name,provider_id) VALUES (?,?,?,?)
 ON CONFLICT(tag_id,language) DO NOTHING`, id, language, name, providerID)
		if err != nil {
			return false, err
		}
		if n, err := result.RowsAffected(); err != nil {
			return false, err
		} else if n > 0 {
			added = true
		}
	}
	return added, nil
}

// ProjectWorkConceptsTx projects a provider base that is not made of DLsite
// genres, using the same override, merge, hiding and marker rules as
// ProjectWorkTx.
func ProjectWorkConceptsTx(ctx context.Context, tx *sql.Tx, workID int64, concepts []int64) error {
	return projectWorkTx(ctx, tx, workID, workID, concepts)
}
