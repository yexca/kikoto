package remotemetadata

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

const maxTitleEditions = 32

// TitleVariant describes a provider-declared edition of an existing work.
// Code is a metadata reference, never a source-local id or a new work root.
type TitleVariant struct {
	Code, Language, Title string
	Origin                bool
}

func editionCode(code string) string {
	return kikoeru.WorkCode(kikoeru.Work{SourceID: code})
}

func decodeTitleVariants(remote kikoeru.Work) ([]TitleVariant, error) {
	if len(remote.LanguageEditions) > maxTitleEditions || len(remote.OtherLanguageEditions) > maxTitleEditions {
		return nil, ErrInvalidWork
	}
	code := kikoeru.WorkCode(remote)
	origin := editionCode(remote.OriginalWorkNumber)
	declared := map[string]string{}
	for _, edition := range remote.LanguageEditions {
		if key := editionCode(edition.WorkNo); key != "" {
			language := dlsite.EditionMetadataLanguage(edition.Language)
			if language == dlsite.OriginMetadataLanguage {
				language = ""
			}
			if previous := declared[key]; previous != "" && language != "" && previous != language {
				return nil, ErrInvalidWork
			}
			if declared[key] == "" {
				declared[key] = language
			}
		}
	}
	if origin == "" {
		for _, edition := range remote.OtherLanguageEditions {
			if edition.IsOriginal {
				candidate := editionCode(edition.SourceID)
				if candidate != "" {
					if origin != "" && origin != candidate {
						return nil, ErrInvalidWork
					}
					origin = candidate
				}
			}
		}
	}
	if origin == "" {
		origin = code
	}
	variants := []TitleVariant{}
	if title := strings.TrimSpace(firstNonEmpty(remote.Title, remote.Name)); title != "" && !strings.EqualFold(title, code) {
		variants = append(variants, TitleVariant{Code: code, Language: declared[code], Title: title, Origin: code == origin})
	}
	for _, edition := range remote.OtherLanguageEditions {
		title := strings.TrimSpace(edition.Title)
		if len(title) > maxTitleBytes {
			return nil, ErrInvalidWork
		}
		key := editionCode(edition.SourceID)
		language := dlsite.EditionMetadataLanguage(edition.Language)
		if key == "" || key == code || title == "" || strings.EqualFold(title, key) {
			continue
		}
		if declaredLanguage, listed := declared[key]; len(declared) > 0 && (!listed || (declaredLanguage != "" && language != "" && declaredLanguage != language)) {
			continue
		}
		if language == "" {
			language = declared[key]
		}
		if language == "" || language == dlsite.OriginMetadataLanguage {
			continue
		}
		variants = append(variants, TitleVariant{Code: key, Language: language, Title: title, Origin: key == origin})
	}
	// A source's own edition wins a same-language tie; remaining ties are
	// independent of the order of the provider's arrays.
	sort.SliceStable(variants, func(i, j int) bool {
		if (variants[i].Code == code) != (variants[j].Code == code) {
			return variants[i].Code == code
		}
		if variants[i].Code != variants[j].Code {
			return variants[i].Code < variants[j].Code
		}
		return variants[i].Title < variants[j].Title
	})
	return variants, nil
}

type storedTitle struct {
	TitleVariant
	providerID int64
}

// projectTitles stores one winning provider title for each supported language
// and the original edition. Raw snapshots retain every provider value.
func projectTitles(ctx context.Context, tx *sql.Tx, workID int64, inputs []snapshotInput) (map[string]storedTitle, error) {
	var code string
	if err := tx.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id=?", workID).Scan(&code); err != nil {
		return nil, err
	}
	titles := map[string]storedTitle{}
	for _, input := range inputs {
		if !strings.EqualFold(input.work.Code, code) {
			continue
		}
		for _, variant := range input.work.TitleVariants {
			keys := []string{}
			if variant.Language != "" && variant.Language != dlsite.OriginMetadataLanguage {
				keys = append(keys, variant.Language)
			}
			if variant.Origin {
				keys = append(keys, dlsite.OriginMetadataLanguage)
			}
			for _, key := range keys {
				if _, exists := titles[key]; !exists {
					titles[key] = storedTitle{variant, input.providerID}
				}
			}
		}
	}
	keys := make([]string, 0, len(titles))
	for key := range titles {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		title := titles[key]
		if _, err := tx.ExecContext(ctx, `INSERT INTO remote_metadata_title_variant(work_id,language,provider_id,edition_code,edition_language,title,is_original)
			VALUES (?,?,?,?,?,?,?) ON CONFLICT(work_id,language) DO UPDATE SET
			provider_id=excluded.provider_id,edition_code=excluded.edition_code,edition_language=excluded.edition_language,title=excluded.title,is_original=excluded.is_original
			WHERE provider_id<>excluded.provider_id OR edition_code<>excluded.edition_code OR edition_language<>excluded.edition_language OR title<>excluded.title OR is_original<>excluded.is_original`,
			workID, key, title.providerID, title.Code, title.Language, title.Title, title.Origin); err != nil {
			return nil, err
		}
	}
	encoded, err := json.Marshal(keys)
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `DELETE FROM remote_metadata_title_variant WHERE work_id=? AND language NOT IN (SELECT value FROM json_each(?))`, workID, string(encoded))
	return titles, err
}
