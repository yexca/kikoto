package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/dlsite"
)

const maxDLsiteFamilyEditions = 32

// DLsiteFamilySyncResult describes one targeted, recursively discovered
// language family. A missing sibling is reported without discarding products
// that were synchronized successfully.
type DLsiteFamilySyncResult struct {
	attempt              int64
	RequestedCode        string   `json:"requestedCode"`
	CanonicalCode        string   `json:"canonicalCode"`
	Codes                []string `json:"codes"`
	SyncedCodes          []string `json:"syncedCodes"`
	SkippedCodes         []string `json:"skippedCodes"`
	Failures             []string `json:"failures"`
	RequestedUnavailable bool     `json:"requestedUnavailable"`
	// PurchaseBonusParent names the parent product metadata sync detected for
	// the requested purchase bonus in this attempt.
	PurchaseBonusParent string `json:"purchaseBonusParent,omitempty"`
}

// DLsiteDemoFamilySyncResult describes the bounded language-edition metadata
// collected for one Demo-local product. Only versions that independently meet
// the Demo content policy are materialized.
type DLsiteDemoFamilySyncResult struct {
	RequestedCode     string   `json:"requestedCode"`
	RequestedEligible bool     `json:"requestedEligible"`
	WorkID            int64    `json:"workId"`
	SyncedCodes       []string `json:"syncedCodes"`
	SkippedCodes      []string `json:"skippedCodes"`
	DiscardedCodes    []string `json:"discardedCodes"`
	Failures          []string `json:"failures"`
}

// SyncDemoProductFamily stores an admitted Demo-local product and eligible
// provider-declared language editions. It intentionally does not follow base
// product links or recurse through a sibling response: every materialized
// edition must independently pass the Demo policy, and only the supplied local
// product is eligible for file registration by the caller.
func (s *DLsiteSyncer) SyncDemoProductFamily(ctx context.Context, product dlsite.Product) (DLsiteDemoFamilySyncResult, error) {
	requestedCode := dlsiteProductCode(product)
	if requestedCode == "" {
		return DLsiteDemoFamilySyncResult{}, fmt.Errorf("product does not expose a stable work code")
	}
	result := DLsiteDemoFamilySyncResult{
		RequestedCode:  requestedCode,
		SyncedCodes:    []string{},
		SkippedCodes:   []string{},
		DiscardedCodes: []string{},
		Failures:       []string{},
	}
	if !isDemoEligibleProduct(product) {
		result.DiscardedCodes = append(result.DiscardedCodes, requestedCode)
		return result, nil
	}

	workID, err := s.SyncProductOnly(ctx, product)
	if err != nil {
		return result, err
	}
	result.RequestedEligible = true
	result.WorkID = workID
	result.SyncedCodes = append(result.SyncedCodes, requestedCode)

	seen := map[string]bool{requestedCode: true}
	fetchedEditions := 1
	for _, edition := range product.LanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if !dlsiteWorkNoPattern.MatchString(code) || seen[code] {
			continue
		}
		seen[code] = true
		if languageEditionExplicitlyUnavailable(product, edition) {
			result.SkippedCodes = append(result.SkippedCodes, code)
			continue
		}
		if fetchedEditions >= maxDLsiteFamilyEditions {
			result.Failures = append(result.Failures, fmt.Sprintf("language edition limit of %d reached", maxDLsiteFamilyEditions))
			break
		}
		fetchedEditions++

		localized, fetchErr := s.fetchProductForEdition(ctx, code)
		if fetchErr != nil {
			// DLsite can retain an edition in the family relationship after its
			// product is no longer published. The requested local product has
			// already passed admission, so an unavailable optional edition is
			// metadata absence rather than a Demo scan failure.
			if errors.Is(fetchErr, dlsite.ErrNoProduct) {
				result.SkippedCodes = append(result.SkippedCodes, code)
				continue
			}
			result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, fetchErr.Error()))
			continue
		}
		if fetchedCode := dlsiteProductCode(localized); !strings.EqualFold(fetchedCode, code) {
			result.Failures = append(result.Failures, fmt.Sprintf("%s: provider returned mismatched code %q", code, fetchedCode))
			continue
		}
		if !isDemoEligibleProduct(localized) {
			result.DiscardedCodes = append(result.DiscardedCodes, code)
			continue
		}
		if _, syncErr := s.SyncProductOnly(ctx, localized); syncErr != nil {
			result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, syncErr.Error()))
			continue
		}
		result.SyncedCodes = append(result.SyncedCodes, code)
	}

	if s.cacheRoot != "" {
		// A cover is presentation-only. Keep the admitted local work playable
		// when a provider image is temporarily unavailable or the cache is
		// unwritable. Metadata-only siblings do not need their own cover fetch.
		_, _ = s.downloadCover(ctx, product)
	}
	return result, nil
}

func isDemoEligibleProduct(product dlsite.Product) bool {
	permanentlyFree := product.IsPermanentlyFree()
	return contentpolicy.IsAllAges(product.AgeCategoryString) && permanentlyFree != nil && *permanentlyFree
}

func dlsiteProductCode(product dlsite.Product) string {
	return strings.ToUpper(strings.TrimSpace(firstNonEmptyText(product.WorkNo, product.ProductID)))
}

// SyncFamily refreshes a requested product and every language edition that can
// be reached from its DLsite relationship payload. Discovery is bounded and
// de-duplicated so malformed provider relationships cannot loop forever.
func (s *DLsiteSyncer) syncFamily(ctx context.Context, requestedCode string) (DLsiteFamilySyncResult, error) {
	requestedCode = strings.ToUpper(strings.TrimSpace(requestedCode))
	if !dlsiteWorkNoPattern.MatchString(requestedCode) {
		return DLsiteFamilySyncResult{}, fmt.Errorf("invalid DLsite work code %q", requestedCode)
	}
	if sourceCode, linked, err := s.metadataLinkSourceCode(ctx, requestedCode); err != nil {
		return DLsiteFamilySyncResult{}, err
	} else if linked {
		return s.syncLinkedWork(ctx, requestedCode, sourceCode)
	}
	result := DLsiteFamilySyncResult{RequestedCode: requestedCode, Codes: []string{}, SyncedCodes: []string{}, SkippedCodes: []string{}, Failures: []string{}}
	queue := []string{requestedCode}
	seen := map[string]bool{}
	skipped := map[string]bool{}
	products := map[string]dlsite.Product{}
	for len(queue) > 0 && len(seen) < maxDLsiteFamilyEditions {
		code := strings.ToUpper(strings.TrimSpace(queue[0]))
		queue = queue[1:]
		if seen[code] || skipped[code] || !dlsiteWorkNoPattern.MatchString(code) {
			continue
		}
		seen[code] = true
		result.Codes = append(result.Codes, code)
		if err := s.syncFamilyCode(ctx, requestedCode, code, &result, &queue, seen, skipped, products); err != nil {
			return result, err
		}
	}
	if result.CanonicalCode == "" {
		result.CanonicalCode = requestedCode
	}
	if err := s.syncFamilyCanonical(ctx, &result, products); err != nil {
		return result, err
	}
	if err := s.classifyFamilyEditions(ctx, result.CanonicalCode); err != nil {
		return result, err
	}
	if len(result.SyncedCodes) == 0 {
		return result, fmt.Errorf("DLsite family metadata could not be synchronized: %s", strings.Join(result.Failures, "; "))
	}
	return result, nil
}

func (s *DLsiteSyncer) syncFamilyCode(
	ctx context.Context,
	requestedCode string,
	code string,
	result *DLsiteFamilySyncResult,
	queue *[]string,
	seen map[string]bool,
	skipped map[string]bool,
	products map[string]dlsite.Product,
) error {
	fetch := s.fetchProductForEdition
	var bonus purchaseBonusOutcome
	if strings.EqualFold(code, requestedCode) {
		// Only the requested work can be a purchase bonus: DLsite declares no
		// family relationship that would reach one from another code.
		fetch = func(ctx context.Context, code string) (dlsite.Product, error) {
			return s.fetchPurchaseBonusProduct(ctx, code, &bonus)
		}
	}
	product, workID, err := s.syncFetchedProduct(ctx, code, fetch)
	if err != nil {
		return s.recordFamilyFetchFailure(ctx, requestedCode, code, err, result, skipped)
	}
	if err := s.recordPurchaseBonusOutcome(ctx, workID, bonus); err != nil {
		return err
	}
	if bonus.status == PurchaseBonusLinked {
		result.PurchaseBonusParent = bonus.parentCode
	}
	products[code] = product
	result.SyncedCodes = append(result.SyncedCodes, code)
	// Localized editions currently contribute only title and tags. Keep cover
	// fetching on the canonical/origin edition until image localization has a
	// separate storage and display contract.
	if s.cacheRoot != "" && isCanonicalProduct(product) {
		if _, err := s.downloadCover(ctx, product); err != nil {
			if dlsite.IsTimeout(err) || ctx.Err() != nil {
				return err
			}
			result.Failures = append(result.Failures, fmt.Sprintf("%s cover: %s", code, err.Error()))
		}
	}
	queueFamilyRelationships(product, queue, seen, skipped, result)
	return nil
}

func (s *DLsiteSyncer) recordFamilyFetchFailure(
	ctx context.Context,
	requestedCode string,
	code string,
	fetchErr error,
	result *DLsiteFamilySyncResult,
	skipped map[string]bool,
) error {
	if dlsite.IsTimeout(fetchErr) || ctx.Err() != nil {
		return fetchErr
	}
	if errors.Is(fetchErr, dlsite.ErrNoProduct) {
		if strings.EqualFold(code, requestedCode) {
			result.RequestedUnavailable = true
		} else {
			skipped[code] = true
			result.SkippedCodes = append(result.SkippedCodes, code)
			return nil
		}
	}
	result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, fetchErr.Error()))
	return nil
}

func queueFamilyRelationships(product dlsite.Product, queue *[]string, seen map[string]bool, skipped map[string]bool, result *DLsiteFamilySyncResult) {
	if base := baseProductCode(product); dlsiteWorkNoPattern.MatchString(base) {
		*queue = append(*queue, base)
		if result.CanonicalCode == "" {
			result.CanonicalCode = base
		}
	}
	for _, edition := range product.LanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if !dlsiteWorkNoPattern.MatchString(code) || seen[code] || skipped[code] {
			continue
		}
		if languageEditionExplicitlyUnavailable(product, edition) {
			skipped[code] = true
			result.SkippedCodes = append(result.SkippedCodes, code)
			continue
		}
		*queue = append(*queue, code)
	}
}

func (s *DLsiteSyncer) syncFamilyCanonical(ctx context.Context, result *DLsiteFamilySyncResult, products map[string]dlsite.Product) error {
	if len(products) == 0 {
		return nil
	}
	origin, ok := products[result.CanonicalCode]
	// The canonical work code identifies the origin edition.  Its source
	// language may be English, Chinese, or another provider language, so the
	// request locale must not be used as an origin test.
	if ok &&
		strings.EqualFold(strings.TrimSpace(firstNonEmptyText(origin.WorkNo, origin.ProductID)), result.CanonicalCode) &&
		(productEditionLanguage(origin) != "" || strings.TrimSpace(origin.TranslationInfo.Lang) != "" || originResponseLanguage(origin.Language)) {
		return nil
	}
	originProduct, _, originFetched, err := s.syncOriginProductForCode(ctx, result.CanonicalCode)
	if err != nil {
		if dlsite.IsTimeout(err) || ctx.Err() != nil {
			return err
		}
		result.Failures = append(result.Failures, fmt.Sprintf("%s origin metadata: %s", result.CanonicalCode, err.Error()))
		return nil
	}
	products[result.CanonicalCode] = originProduct
	if originFetched && s.cacheRoot != "" {
		if _, err := s.downloadCover(ctx, originProduct); err != nil {
			if dlsite.IsTimeout(err) || ctx.Err() != nil {
				return err
			}
			result.Failures = append(result.Failures, fmt.Sprintf("%s origin cover: %s", result.CanonicalCode, err.Error()))
		}
	}
	if !containsCode(result.SyncedCodes, result.CanonicalCode) {
		result.SyncedCodes = append(result.SyncedCodes, result.CanonicalCode)
	}
	return nil
}

func languageEditionExplicitlyUnavailable(product dlsite.Product, edition dlsite.LanguageEdition) bool {
	for _, language := range edition.LanguageTokens() {
		for candidate, status := range product.TranslationInfo.StatusForTranslatorByLang {
			if strings.EqualFold(strings.TrimSpace(candidate), language) && status.OnSaleCount != nil {
				return *status.OnSaleCount == 0
			}
		}
	}
	return false
}

func (s *DLsiteSyncer) classifyFamilyEditions(ctx context.Context, canonicalCode string) error {
	canonicalCode = strings.ToUpper(strings.TrimSpace(canonicalCode))
	var logicalWorkID int64
	var originMakerID string
	if err := s.db.QueryRowContext(ctx, `
		SELECT edition.logical_work_id, COALESCE(NULLIF(origin.maker_id, ''), '')
		FROM work_edition AS edition
		INNER JOIN work_edition AS origin ON origin.logical_work_id = edition.logical_work_id AND origin.is_canonical = 1
		WHERE UPPER(edition.primary_code) = UPPER(?)
		LIMIT 1
	`, canonicalCode).Scan(&logicalWorkID, &originMakerID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	originMakerID = strings.ToUpper(strings.TrimSpace(originMakerID))
	_, err := s.db.ExecContext(ctx, `
		UPDATE work_edition
		SET origin_maker_id = ?,
			translation_kind = CASE
				WHEN is_canonical = 1 THEN 'origin'
				WHEN ? <> '' AND UPPER(maker_id) = ? THEN 'official'
				WHEN maker_id <> '' THEN 'third_party'
				ELSE 'unknown'
			END,
			classification_source = CASE
				WHEN is_canonical = 1 THEN 'canonical'
				WHEN ? <> '' AND UPPER(maker_id) = ? THEN 'maker_match'
				WHEN maker_id <> '' THEN 'maker_mismatch'
				ELSE 'incomplete_metadata'
			END,
			updated_at = CURRENT_TIMESTAMP
		WHERE logical_work_id = ?
	`, originMakerID, originMakerID, originMakerID, originMakerID, originMakerID, logicalWorkID)
	return err
}

func (s *DLsiteSyncer) syncOriginProduct(ctx context.Context, product dlsite.Product) (dlsite.Product, int64, bool, error) {
	currentCode := strings.ToUpper(strings.TrimSpace(firstNonEmptyText(product.WorkNo, product.ProductID)))
	canonicalCode := strings.ToUpper(strings.TrimSpace(baseProductCode(product)))
	if canonicalCode == "" {
		canonicalCode = currentCode
	}
	if currentCode == "" || canonicalCode == "" {
		return dlsite.Product{}, 0, false, fmt.Errorf("product does not expose a stable origin code")
	}
	if strings.EqualFold(currentCode, canonicalCode) {
		return product, 0, false, nil
	}
	return s.syncOriginProductForCode(ctx, canonicalCode)
}

func (s *DLsiteSyncer) syncOriginProductForCode(ctx context.Context, code string) (dlsite.Product, int64, bool, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if !dlsiteWorkNoPattern.MatchString(code) {
		return dlsite.Product{}, 0, false, fmt.Errorf("invalid origin work code %q", code)
	}
	product, workID, err := s.syncFetchedProduct(ctx, code, s.fetchOriginProduct)
	if err != nil {
		return dlsite.Product{}, 0, false, err
	}
	return product, workID, true, nil
}

func originResponseLanguage(language string) bool {
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "", "ja", "jp", "ja-jp", "jpn", "japanese", "日本語":
		return true
	default:
		return false
	}
}

func isCanonicalProduct(product dlsite.Product) bool {
	currentCode := strings.ToUpper(strings.TrimSpace(firstNonEmptyText(product.WorkNo, product.ProductID)))
	canonicalCode := strings.ToUpper(strings.TrimSpace(baseProductCode(product)))
	if currentCode == "" {
		return false
	}
	if canonicalCode == "" {
		return true
	}
	return strings.EqualFold(currentCode, canonicalCode)
}

func containsCode(values []string, code string) bool {
	for _, value := range values {
		if strings.EqualFold(value, code) {
			return true
		}
	}
	return false
}

func baseProductCode(product dlsite.Product) string {
	for _, value := range []string{product.TranslationInfo.OriginalWorkNo, product.TranslationInfo.ParentWorkNo} {
		value = strings.ToUpper(strings.TrimSpace(value))
		if dlsiteWorkNoPattern.MatchString(value) {
			return value
		}
	}
	return originProductCode(product)
}

func originProductCode(product dlsite.Product) string {
	bestCode := ""
	bestOrder := 0
	for index, edition := range product.LanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if !dlsiteWorkNoPattern.MatchString(code) {
			continue
		}
		order := edition.DisplayOrder
		if order <= 0 {
			order = index + 1
		}
		if bestCode == "" || order < bestOrder {
			bestCode = code
			bestOrder = order
		}
	}
	return bestCode
}

func productEdition(product dlsite.Product) (dlsite.LanguageEdition, bool) {
	currentCode := strings.ToUpper(strings.TrimSpace(firstNonEmptyText(product.WorkNo, product.ProductID)))
	for _, edition := range product.LanguageEditions {
		if strings.EqualFold(strings.TrimSpace(edition.WorkNo), currentCode) {
			return edition, true
		}
	}
	return dlsite.LanguageEdition{}, false
}

func productEditionLanguage(product dlsite.Product) string {
	if edition, ok := productEdition(product); ok {
		return editionLanguageValue(edition)
	}
	// Product.Language is the locale requested over HTTP, not a provider
	// declaration. Falling back to it would misclassify an origin edition when
	// DLsite omits language_editions.
	return strings.TrimSpace(product.TranslationInfo.Lang)
}

func editionLanguageValue(edition dlsite.LanguageEdition) string {
	tokens := edition.LanguageTokens()
	labelLanguage := dlsite.EditionMetadataLanguage(edition.Label)
	if labelLanguage != "" {
		for _, token := range tokens {
			if dlsite.EditionMetadataLanguage(token) == labelLanguage {
				return strings.TrimSpace(token)
			}
		}
	}
	if len(tokens) > 0 {
		return tokens[0]
	}
	return strings.TrimSpace(edition.Label)
}

func productEditionLabel(product dlsite.Product) string {
	if edition, ok := productEdition(product); ok {
		return strings.TrimSpace(edition.Label)
	}
	return ""
}

func originCodeFromSnapshot(raw string) string {
	var combined struct {
		Product json.RawMessage `json:"product"`
	}
	rawBytes := []byte(raw)
	if err := json.Unmarshal(rawBytes, &combined); err == nil && len(combined.Product) > 0 {
		rawBytes = combined.Product
	}
	var product dlsite.Product
	if err := json.Unmarshal(rawBytes, &product); err != nil {
		return ""
	}
	return baseProductCode(product)
}
