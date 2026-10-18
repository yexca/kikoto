package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

type replacementQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// ProductMatchesExistingEdition checks provider family evidence against a local
// edition. Callers must obtain product by an exact request for its returned code.
// A matching language or title alone never establishes an edition relationship.
func ProductMatchesExistingEdition(ctx context.Context, queryer replacementQueryer, product dlsite.Product, localCode string) (bool, error) {
	code := dlsiteProductCode(product)
	original := strings.ToUpper(strings.TrimSpace(product.TranslationInfo.OriginalWorkNo))
	localCode = strings.ToUpper(strings.TrimSpace(localCode))
	if !dlsiteWorkNoPattern.MatchString(code) || !dlsiteWorkNoPattern.MatchString(original) || code == localCode || original == localCode {
		return false, nil
	}
	var canonical, raw string
	err := queryer.QueryRowContext(ctx, `
		SELECT logical.canonical_code, COALESCE((
			SELECT snapshot.snapshot_json FROM metadata_snapshot AS snapshot
			INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id AND provider.code = 'dlsite'
			WHERE snapshot.work_id = edition.work_id
			ORDER BY snapshot.fetched_at DESC, snapshot.id DESC LIMIT 1
		), '')
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE UPPER(edition.primary_code) = ?
	`, localCode).Scan(&canonical, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil || !strings.EqualFold(canonical, original) {
		return false, err
	}
	if strings.EqualFold(strings.TrimSpace(product.TranslationInfo.ParentWorkNo), localCode) {
		return true, nil
	}
	var verified int
	if err := queryer.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM work_code_alias AS alias
		INNER JOIN metadata_provider AS provider ON provider.id = alias.provider_id AND provider.code = 'dlsite'
		INNER JOIN work ON work.id = alias.source_work_id
		INNER JOIN work_edition AS edition ON edition.work_id = work.id AND edition.logical_work_id = alias.logical_work_id
		WHERE UPPER(alias.primary_code) = ? AND UPPER(work.primary_code) = ?
			AND alias.relationship_kind = 'provider_reissued'
	`, code, localCode).Scan(&verified); err != nil {
		return false, err
	}
	if verified == 1 {
		return true, nil
	}
	var previous dlsite.Product
	if json.Unmarshal([]byte(raw), &previous) != nil || dlsiteProductCode(previous) != localCode {
		return false, nil
	}
	// Compare the local provider snapshot with the exact candidate response.
	// Nonzero ids and nonempty provider language tokens are both required.
	local, localOK := replacementEdition(previous.LanguageEditions, localCode)
	candidate, candidateOK := replacementEdition(product.LanguageEditions, code)
	return localOK && candidateOK && local.EditionID == candidate.EditionID && strings.TrimSpace(local.Lang) == strings.TrimSpace(candidate.Lang), nil
}

func replacementEdition(editions []dlsite.LanguageEdition, code string) (dlsite.LanguageEdition, bool) {
	if len(editions) > maxDLsiteFamilyEditions {
		return dlsite.LanguageEdition{}, false
	}
	var match dlsite.LanguageEdition
	for _, edition := range editions {
		if !strings.EqualFold(strings.TrimSpace(edition.WorkNo), code) {
			continue
		}
		if match.WorkNo != "" || edition.EditionID <= 0 || strings.TrimSpace(edition.Lang) == "" {
			return dlsite.LanguageEdition{}, false
		}
		match = edition
	}
	return match, match.WorkNo != ""
}

// ExistingReplacementEdition finds an unambiguous local owner without creating
// any discovered works. An independently persisted candidate keeps its identity.
func ExistingReplacementEdition(ctx context.Context, db *sql.DB, product dlsite.Product) (int64, string, error) {
	code := dlsiteProductCode(product)
	original := strings.ToUpper(strings.TrimSpace(product.TranslationInfo.OriginalWorkNo))
	if !dlsiteWorkNoPattern.MatchString(code) || !dlsiteWorkNoPattern.MatchString(original) {
		return 0, "", nil
	}
	var existing int64
	err := db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = ?", code).Scan(&existing)
	if err == nil {
		return 0, "", nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, "", err
	}
	rows, err := db.QueryContext(ctx, `
		SELECT edition.work_id, edition.primary_code
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE UPPER(logical.canonical_code) = ? AND UPPER(edition.primary_code) <> ?
		ORDER BY edition.work_id LIMIT 33
	`, original, original)
	if err != nil {
		return 0, "", err
	}
	type localEdition struct {
		id   int64
		code string
	}
	editions := []localEdition{}
	for rows.Next() {
		var edition localEdition
		if err := rows.Scan(&edition.id, &edition.code); err != nil {
			_ = rows.Close()
			return 0, "", err
		}
		editions = append(editions, edition)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil || len(editions) > 32 {
		return 0, "", err
	}
	var owner localEdition
	for _, edition := range editions {
		matches, err := ProductMatchesExistingEdition(ctx, db, product, edition.code)
		if err != nil {
			return 0, "", err
		}
		if matches {
			if owner.id != 0 {
				return 0, "", nil
			}
			owner = edition
		}
	}
	return owner.id, owner.code, nil
}
