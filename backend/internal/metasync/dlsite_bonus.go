package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// DLsiteMakerCatalogClient lists a maker's published works. Purchase bonus
// detection reads it to find a bonus's parent among the maker's products.
type DLsiteMakerCatalogClient interface {
	FetchMakerCatalog(ctx context.Context, makerID string, options dlsite.MakerCatalogOptions) (dlsite.MakerProfile, error)
}

const (
	// purchaseBonusCatalogMaxPages bounds the maker profile pages read for one
	// bonus. Pages list newer works first and paging stops once it passes the
	// bonus code, so only makers with many newer works reach the bound.
	purchaseBonusCatalogMaxPages = 10
	// purchaseBonusParentFetchLimit bounds the catalog products requested for
	// one bonus: the codes nearest the bonus code.
	purchaseBonusParentFetchLimit = 5

	PurchaseBonusLinked    = "linked"
	PurchaseBonusUnmatched = "unmatched"
	PurchaseBonusDismissed = "dismissed"
)

// purchaseBonusInheritedKeys are the product fields a bonus takes from its
// parent when its own are empty. Everything else, including the title,
// introduction, cover and release date, stays the bonus's own.
var purchaseBonusInheritedKeys = map[string][]string{
	"genres":   {"genres", "genres_replaced"},
	"creators": {"creaters"},
	"series":   {"series_id", "series_name", "series_name_masked", "title_id", "title_name", "title_name_masked"},
}

// WithPurchaseBonusLinking enables purchase bonus detection during metadata
// sync. autoLink turns detection on for bonuses without a decision; recheck
// also retries bonuses an earlier detection could not match. A linked bonus
// inherits from its parent regardless of autoLink.
func (s *DLsiteSyncer) WithPurchaseBonusLinking(autoLink bool, recheck bool) *DLsiteSyncer {
	s.purchaseBonusAutoLink = autoLink
	s.purchaseBonusRecheck = recheck
	return s
}

type purchaseBonusRecord struct {
	status     string
	parentCode string
	origin     string
}

// purchaseBonusOutcome is decided while the bonus product is fetched and
// stored once the bonus work exists.
type purchaseBonusOutcome struct {
	record     bool
	status     string
	parentCode string
	evidence   string
}

func (s *DLsiteSyncer) purchaseBonusRecordForCode(ctx context.Context, code string) (purchaseBonusRecord, bool, error) {
	var record purchaseBonusRecord
	err := s.db.QueryRowContext(ctx, `SELECT bonus.status, bonus.parent_code, bonus.origin
		FROM work_purchase_bonus AS bonus
		JOIN work ON work.id = bonus.work_id
		WHERE UPPER(work.primary_code) = UPPER(?)`, code).Scan(&record.status, &record.parentCode, &record.origin)
	if errors.Is(err, sql.ErrNoRows) {
		return purchaseBonusRecord{}, false, nil
	}
	if err != nil {
		return purchaseBonusRecord{}, false, err
	}
	record.parentCode = strings.ToUpper(strings.TrimSpace(record.parentCode))
	return record, true, nil
}

// fetchPurchaseBonusProduct fetches the requested product and, when it is a
// linked or newly detected purchase bonus, fills its empty genres, credits and
// series from the parent product. The parent is requested but never stored as
// a work. Detection failures leave the bonus unlinked for a later sync rather
// than failing the bonus's own metadata.
func (s *DLsiteSyncer) fetchPurchaseBonusProduct(ctx context.Context, code string, outcome *purchaseBonusOutcome) (dlsite.Product, error) {
	product, err := s.fetchProductForEdition(ctx, code)
	if err != nil {
		return dlsite.Product{}, err
	}
	record, found, err := s.purchaseBonusRecordForCode(ctx, code)
	if err != nil {
		return dlsite.Product{}, err
	}
	parentCode := ""
	var parent *dlsite.Product
	switch {
	case found && record.status == PurchaseBonusLinked:
		parentCode = record.parentCode
	case found && record.status == PurchaseBonusDismissed, !s.purchaseBonusAutoLink:
		return product, nil
	case found && record.status == PurchaseBonusUnmatched && !s.purchaseBonusRecheck:
		return product, nil
	default:
		hint, isBonus := dlsite.PurchaseBonusHintFor(product)
		if !isBonus {
			return product, nil
		}
		detected, detectErr := s.detectPurchaseBonusParent(ctx, hint, productLocale(product))
		if detectErr != nil {
			if ctx.Err() != nil {
				return dlsite.Product{}, ctx.Err()
			}
			slog.Warn("purchase bonus detection failed", "code", code, "error", detectErr)
			return product, nil
		}
		if detected.code == "" {
			evidence := "none"
			if detected.ambiguous {
				evidence = "ambiguous"
			}
			*outcome = purchaseBonusOutcome{record: true, status: PurchaseBonusUnmatched, evidence: evidence}
			return product, nil
		}
		parentCode = detected.code
		parent = detected.product
		*outcome = purchaseBonusOutcome{record: true, status: PurchaseBonusLinked, parentCode: parentCode, evidence: detected.match.String()}
	}
	if parent == nil {
		fetched, fetchErr := s.fetchProductInLocale(ctx, parentCode, productLocale(product))
		if fetchErr != nil {
			if errors.Is(fetchErr, dlsite.ErrNoProduct) {
				// A withdrawn parent leaves the bonus with its own metadata.
				return product, nil
			}
			return dlsite.Product{}, fmt.Errorf("fetch purchase bonus parent %s: %w", parentCode, fetchErr)
		}
		parent = &fetched
	}
	return purchaseBonusProduct(product, *parent), nil
}

type purchaseBonusDetection struct {
	code      string
	match     dlsite.PurchaseBonusMatch
	ambiguous bool
	product   *dlsite.Product
}

// detectPurchaseBonusParent looks for the parent among stored works from the
// same maker first, then among the codes nearest the bonus in the maker's
// published catalog. Catalog products are requested for scoring only.
func (s *DLsiteSyncer) detectPurchaseBonusParent(ctx context.Context, hint dlsite.PurchaseBonusHint, locale string) (purchaseBonusDetection, error) {
	local, err := s.storedPurchaseBonusCandidates(ctx, hint)
	if err != nil {
		return purchaseBonusDetection{}, err
	}
	if code, match, ambiguous := hint.SelectParent(local); code != "" || ambiguous {
		return purchaseBonusDetection{code: code, match: match, ambiguous: ambiguous}, nil
	}
	catalog, ok := s.client.(DLsiteMakerCatalogClient)
	if !ok {
		return purchaseBonusDetection{}, nil
	}
	if err := s.waitRequestDelay(ctx); err != nil {
		return purchaseBonusDetection{}, err
	}
	profile, err := catalog.FetchMakerCatalog(ctx, hint.MakerID, dlsite.MakerCatalogOptions{
		Mode:          "incremental",
		MaxPages:      purchaseBonusCatalogMaxPages,
		Delay:         s.requestDelay,
		StopBelowCode: hint.Code,
		SkipSeries:    true,
	})
	if err != nil {
		return purchaseBonusDetection{}, fmt.Errorf("maker catalog %s: %w", hint.MakerID, err)
	}
	checked := map[string]bool{hint.Code: true}
	for _, candidate := range local {
		checked[strings.ToUpper(candidate.Code)] = true
	}
	candidates := []dlsite.PurchaseBonusCandidate{}
	products := map[string]dlsite.Product{}
	for _, code := range nearestPurchaseBonusCodes(hint.Code, profile.WorkCodes, checked, purchaseBonusParentFetchLimit) {
		product, err := s.fetchProductInLocale(ctx, code, locale)
		if err != nil {
			if ctx.Err() != nil || dlsite.IsTimeout(err) {
				return purchaseBonusDetection{}, err
			}
			continue
		}
		candidate := dlsite.PurchaseBonusCandidateFromProduct(product)
		candidates = append(candidates, candidate)
		products[candidate.Code] = product
	}
	code, match, ambiguous := hint.SelectParent(candidates)
	detection := purchaseBonusDetection{code: code, match: match, ambiguous: ambiguous}
	if product, ok := products[code]; ok {
		detection.product = &product
	}
	return detection, nil
}

func (s *DLsiteSyncer) storedPurchaseBonusCandidates(ctx context.Context, hint dlsite.PurchaseBonusHint) ([]dlsite.PurchaseBonusCandidate, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT work.primary_code, edition.maker_id, COALESCE(work.title, ''),
			COALESCE(work.title_kana, ''), COALESCE(work.release_date, ''), COALESCE(work.is_permanently_free, 0)
		FROM work
		JOIN work_edition AS edition ON edition.work_id = work.id
		WHERE UPPER(edition.maker_id) = UPPER(?) AND UPPER(work.primary_code) <> UPPER(?)
		ORDER BY work.id`, hint.MakerID, hint.Code)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	candidates := []dlsite.PurchaseBonusCandidate{}
	for rows.Next() {
		var candidate dlsite.PurchaseBonusCandidate
		if err := rows.Scan(&candidate.Code, &candidate.MakerID, &candidate.Title, &candidate.TitleKana, &candidate.ReleaseDate, &candidate.Free); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

// nearestPurchaseBonusCodes returns up to limit unchecked catalog codes with
// the bonus's prefix, nearest the bonus number first.
func nearestPurchaseBonusCodes(bonusCode string, codes []string, checked map[string]bool, limit int) []string {
	prefix, number, ok := dlsite.SplitWorkCode(bonusCode)
	if !ok {
		return nil
	}
	type nearCode struct {
		code     string
		distance int64
	}
	near := []nearCode{}
	seen := map[string]bool{}
	for _, code := range codes {
		code = strings.ToUpper(strings.TrimSpace(code))
		codePrefix, codeNumber, ok := dlsite.SplitWorkCode(code)
		if !ok || codePrefix != prefix || checked[code] || seen[code] || !dlsiteWorkNoPattern.MatchString(code) {
			continue
		}
		seen[code] = true
		distance := codeNumber - number
		if distance < 0 {
			distance = -distance
		}
		near = append(near, nearCode{code: code, distance: distance})
	}
	sort.SliceStable(near, func(i, j int) bool {
		if near[i].distance != near[j].distance {
			return near[i].distance < near[j].distance
		}
		return near[i].code < near[j].code
	})
	result := []string{}
	for _, item := range near {
		if len(result) == limit {
			break
		}
		result = append(result, item.code)
	}
	return result
}

// fetchProductInLocale requests a related product in the locale the bonus was
// requested in, so inherited genre names are learned under the right locale.
func (s *DLsiteSyncer) fetchProductInLocale(ctx context.Context, code string, locale string) (dlsite.Product, error) {
	if locale == "" {
		return s.fetchProduct(ctx, code)
	}
	product, err := s.fetchProductWithLanguages(ctx, code, []string{locale})
	if err != nil {
		return dlsite.Product{}, err
	}
	if product.RequestLocale == "" {
		product.RequestLocale = locale
	}
	return product, nil
}

func productLocale(product dlsite.Product) string {
	return normalizeRequestLocale(firstNonEmptyText(product.RequestLocale, product.Language))
}

// purchaseBonusProduct fills the bonus's empty genres, credits and series from
// its parent and records the parent and inherited groups for traceability.
func purchaseBonusProduct(bonus dlsite.Product, parent dlsite.Product) dlsite.Product {
	product := bonus
	product.PurchaseBonusParentCode = dlsiteProductCode(parent)
	bonusFields := rawProductObject(bonus.ProductRaw)
	parentFields := rawProductObject(parent.ProductRaw)
	inherited := []string{}
	for _, group := range []string{"genres", "creators", "series"} {
		keys := purchaseBonusInheritedKeys[group]
		if !rawFieldsEmpty(bonusFields, keys) || rawFieldsEmpty(parentFields, keys) {
			continue
		}
		for _, key := range keys {
			if value, ok := parentFields[key]; ok {
				bonusFields[key] = value
			}
		}
		inherited = append(inherited, group)
		switch group {
		case "genres":
			product.Genres = parent.Genres
		case "creators":
			product.Creators = parent.Creators
		}
	}
	product.PurchaseBonusInherited = inherited
	if len(inherited) == 0 || bonusFields == nil {
		return product
	}
	product.ProductRaw = mustMarshalRaw(bonusFields, bonus.ProductRaw)
	product.Raw = replaceRawProduct(bonus.Raw, product.ProductRaw)
	return product
}

func rawProductObject(raw json.RawMessage) map[string]json.RawMessage {
	var object map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &object) != nil {
		return nil
	}
	if nested, ok := object["product"]; ok && len(nested) > 0 {
		return rawProductObject(nested)
	}
	return object
}

// replaceRawProduct swaps the product object of a stored response, which is
// either the product itself or a {"product", "dynamic"} envelope.
func replaceRawProduct(raw json.RawMessage, product json.RawMessage) json.RawMessage {
	var object map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &object) != nil {
		return product
	}
	if _, ok := object["product"]; !ok {
		return product
	}
	object["product"] = product
	return mustMarshalRaw(object, raw)
}

func rawFieldsEmpty(fields map[string]json.RawMessage, keys []string) bool {
	for _, key := range keys {
		if !rawFieldEmpty(fields[key]) {
			return false
		}
	}
	return true
}

func rawFieldEmpty(value json.RawMessage) bool {
	switch strings.TrimSpace(string(value)) {
	case "", "null", "[]", "{}", `""`, "false", "0":
		return true
	default:
		return false
	}
}

func (s *DLsiteSyncer) recordPurchaseBonusOutcome(ctx context.Context, workID int64, outcome purchaseBonusOutcome) error {
	if !outcome.record || workID <= 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	providerID, err := ensureMetadataProvider(ctx, tx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	// A user's link or dismissal saved while detection ran is never replaced.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_purchase_bonus (work_id, provider_id, parent_code, status, origin, evidence, updated_at)
		VALUES (?, ?, ?, ?, 'detected', ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id) DO UPDATE SET
			provider_id = excluded.provider_id,
			parent_code = excluded.parent_code,
			status = excluded.status,
			origin = 'detected',
			evidence = excluded.evidence,
			updated_by_user_id = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_purchase_bonus.origin = 'detected' AND work_purchase_bonus.status <> 'linked'
	`, workID, providerID, outcome.parentCode, outcome.status, outcome.evidence); err != nil {
		return err
	}
	return tx.Commit()
}

// snapshotIsPurchaseBonus reports whether a stored DLsite snapshot
// describes a purchase bonus. Bulk sync uses it to revisit stored bonuses that
// have no detection decision yet.
func snapshotIsPurchaseBonus(raw string) bool {
	fields := rawProductObject(json.RawMessage(raw))
	if fields == nil {
		return false
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return false
	}
	var product dlsite.Product
	if err := json.Unmarshal(encoded, &product); err != nil {
		return false
	}
	_, isBonus := dlsite.PurchaseBonusHintFor(product)
	return isBonus
}
