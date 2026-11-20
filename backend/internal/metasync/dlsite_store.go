package metasync

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func (s *DLsiteSyncer) applyProduct(ctx context.Context, workID int64, product dlsite.Product) error {
	ctx, err := s.beginAttempt(ctx)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	providerID, err := ensureMetadataProvider(ctx, tx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	newer, err := newerMetadataWasStored(ctx, tx, workID, providerID)
	if err != nil {
		return err
	}
	if newer {
		if err := recordSyncOutcome(ctx, tx, workID, providerID, "metadata", "succeeded"); err != nil {
			return err
		}
		return tx.Commit()
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_external_id (work_id, provider_id, id_type, external_id, url, is_primary)
		VALUES (?, ?, 'workno', ?, ?, 1)
		ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
			work_id = excluded.work_id,
			url = excluded.url,
			is_primary = excluded.is_primary
	`, workID, providerID, product.WorkNo, s.productURL(product)); err != nil {
		return err
	}
	// A failed dynamic request leaves rating, sales, and prices unknown, not
	// absent: a field the product response did not declare keeps its value.
	keepStored := product.DynamicUnavailable
	var priceCurrency any = ""
	if product.RegularPrice != nil || product.CurrentPrice != nil {
		priceCurrency = "JPY"
	} else if keepStored {
		priceCurrency = nil
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE work
		SET title = ?,
			title_kana = ?,
			description = ?,
			release_date = ?,
			age_rating = ?,
			rating_average = `+dynamicWorkColumn("rating_average", keepStored)+`,
			sales_count = `+dynamicWorkColumn("sales_count", keepStored)+`,
			regular_price = `+dynamicWorkColumn("regular_price", keepStored)+`,
			current_price = `+dynamicWorkColumn("current_price", keepStored)+`,
			price_currency = `+dynamicWorkColumn("price_currency", keepStored)+`,
			is_permanently_free = `+dynamicWorkColumn("is_permanently_free", keepStored)+`,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, chooseTitle(product), product.WorkNameKana, chooseDescription(product), nullableText(product.RegistDate), product.AgeCategoryString,
		product.RateAverage2DP, product.SalesCount, product.RegularPrice, product.CurrentPrice, priceCurrency, product.IsPermanentlyFree(), workID); err != nil {
		return err
	}
	if err := upsertDLsiteWorkEdition(ctx, tx, providerID, workID, product); err != nil {
		return err
	}
	var logicalWorkID int64
	if err := tx.QueryRowContext(ctx, "SELECT logical_work_id FROM work_edition WHERE work_id = ?", workID).Scan(&logicalWorkID); err != nil {
		return err
	}

	editionLanguage := strings.TrimSpace(productEditionLanguage(product))
	editionToken := dlsite.EditionMetadataLanguage(editionLanguage)
	if editionToken == "" {
		editionToken = strings.ToUpper(editionLanguage)
	}
	requestLocale := normalizeRequestLocale(firstNonEmptyText(product.RequestLocale, product.Language))
	if requestLocale == "" {
		requestLocale = dlsite.LocaleForMetadataLanguage(editionToken)
	}
	baseRaw := product.Raw
	if len(baseRaw) == 0 {
		baseRaw = json.RawMessage(`{}`)
	}
	if keepStored {
		if baseRaw, err = withStoredDynamicSection(ctx, tx, workID, providerID, product.WorkNo, baseRaw); err != nil {
			return err
		}
	}
	contentHash := hashSnapshot(baseRaw)
	variantKey := metadataVariantKey(editionLanguage, editionToken)
	kikotoMeta := map[string]any{
		"response_language": product.Language,
		"request_locale":    requestLocale,
		"edition_language":  editionLanguage,
		"variant_key":       variantKey,
		"content_hash":      contentHash,
	}
	if product.MetadataSourceCode != "" {
		kikotoMeta["metadata_source_code"] = product.MetadataSourceCode
	}
	if product.PurchaseBonusParentCode != "" {
		kikotoMeta["purchase_bonus_parent_code"] = product.PurchaseBonusParentCode
		kikotoMeta["purchase_bonus_inherited"] = product.PurchaseBonusInherited
	}
	raw := snapshotWithKikotoMeta(baseRaw, kikotoMeta)
	if err := upsertDLsiteMetadataSnapshot(ctx, tx, workID, providerID, product.WorkNo, raw, variantKey, editionLanguage, requestLocale, contentHash); err != nil {
		return err
	}
	if err := upsertDLsiteMetadataVariant(ctx, tx, logicalWorkID, workID, providerID, product.WorkNo, editionLanguage, requestLocale, chooseTitle(product), product.Genres, contentHash); err != nil {
		return err
	}
	if err := replaceDLsiteWorkGenres(ctx, tx, workID, product.Genres, requestLocale, s.projectionPriority()); err != nil {
		return err
	}
	if err := recordSyncOutcome(ctx, tx, workID, providerID, "metadata", "succeeded"); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	if err := s.classifyFamilyEditions(ctx, baseProductCode(product)); err != nil {
		return err
	}
	if err := ProjectDLsiteMetadataFamily(ctx, s.db, logicalWorkID, s.projectionPriority()); err != nil {
		return err
	}
	if s.familyStored != nil {
		s.familyStored(ctx, logicalWorkID)
	}
	return nil
}

// dynamicWorkColumn is the assignment of a normalized column that the dynamic
// product request feeds. When that request failed, keepStored keeps the stored
// value wherever the product response left the field unknown. The column names
// are fixed literals.
func dynamicWorkColumn(column string, keepStored bool) string {
	if keepStored {
		return "COALESCE(?, " + column + ")"
	}
	return "?"
}

// withStoredDynamicSection carries the dynamic section of the work's latest
// stored snapshot into a product whose dynamic request failed, so the counts
// read from the snapshot survive the refresh.
func withStoredDynamicSection(ctx context.Context, tx *sql.Tx, workID, providerID int64, externalID string, raw json.RawMessage) (json.RawMessage, error) {
	var stored string
	err := tx.QueryRowContext(ctx, `
		SELECT snapshot_json
		FROM metadata_snapshot
		WHERE work_id = ? AND provider_id = ? AND external_id = ?
		ORDER BY fetched_at DESC, id DESC
		LIMIT 1
	`, workID, providerID, externalID).Scan(&stored)
	if errors.Is(err, sql.ErrNoRows) {
		return raw, nil
	}
	if err != nil {
		return nil, err
	}
	var previous map[string]json.RawMessage
	if json.Unmarshal([]byte(stored), &previous) != nil || rawFieldEmpty(previous["dynamic"]) {
		return raw, nil
	}
	var current map[string]json.RawMessage
	if json.Unmarshal(raw, &current) != nil {
		return raw, nil
	}
	if _, ok := current["product"]; !ok {
		current = map[string]json.RawMessage{"product": raw}
	} else if !rawFieldEmpty(current["dynamic"]) {
		return raw, nil
	}
	current["dynamic"] = previous["dynamic"]
	return mustMarshalRaw(current, raw), nil
}

// replaceDLsiteWorkGenres records the genre ids of one edition and learns
// their names: NameBase is the Japanese name, and Name is the name for the
// locale DLsite was asked for. Names are keyed by that request locale, not by
// the edition language, because an edition without its own locale is
// requested in ja-jp and reports Japanese names. The search index expands
// each id to every learned name, so a tag matches in any known language.
func replaceDLsiteWorkGenres(ctx context.Context, tx *sql.Tx, workID int64, genres []dlsite.Genre, requestLocale string, priorities []string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_dlsite_genre WHERE work_id = ?", workID); err != nil {
		return err
	}
	requestLocale = normalizeRequestLocale(requestLocale)
	ids := []int64{}
	for _, genre := range genres {
		if genre.ID <= 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_dlsite_genre (work_id, genre_id)
			VALUES (?, ?)
			ON CONFLICT(work_id, genre_id) DO NOTHING
		`, workID, int64(genre.ID)); err != nil {
			return err
		}
		if err := learnDLsiteGenreNamesTx(ctx, tx, genre, requestLocale); err != nil {
			return err
		}
		id, err := metadatatags.EnsureGenreTx(ctx, tx, int64(genre.ID))
		if err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	return metadatatags.RefreshNamesTx(ctx, tx, priorities, ids...)
}

// learnDLsiteGenreNamesTx stores one response's names for a genre: NameBase
// as Japanese and Name under the locale DLsite was asked for. The newest
// observation replaces an older, different name.
func learnDLsiteGenreNamesTx(ctx context.Context, tx *sql.Tx, genre dlsite.Genre, requestLocale string) error {
	names := []struct{ language, name string }{{"ja-jp", genre.NameBase}}
	if requestLocale != "" {
		names = append(names, struct{ language, name string }{requestLocale, genre.Name})
	}
	for _, entry := range names {
		name := strings.TrimSpace(entry.name)
		if name == "" || len(name) > 512 {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO dlsite_genre_name (genre_id, language, name)
			VALUES (?, ?, ?)
			ON CONFLICT(genre_id, language) DO UPDATE SET
				name = excluded.name,
				updated_at = CURRENT_TIMESTAMP
			WHERE dlsite_genre_name.name <> excluded.name
		`, int64(genre.ID), entry.language, name); err != nil {
			return err
		}
	}
	return nil
}

func normalizeRequestLocale(value string) string {
	return strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "_", "-")))
}

// metadataVariantKey identifies the provider-declared edition.  The locale
// used to request that edition is provenance and must not create a second
// display variant when a caller changes its fallback request order.
func metadataVariantKey(editionLanguage, normalizedLanguage string) string {
	key := strings.TrimSpace(normalizedLanguage)
	if key == "" {
		key = strings.TrimSpace(editionLanguage)
	}
	key = strings.ToLower(strings.ReplaceAll(key, "_", "-"))
	if key == "" {
		return "unknown"
	}
	return key
}

func hashSnapshot(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func upsertDLsiteMetadataSnapshot(
	ctx context.Context,
	tx *sql.Tx,
	workID int64,
	providerID int64,
	externalID string,
	raw json.RawMessage,
	variantKey string,
	editionLanguage string,
	requestLocale string,
	contentHash string,
) error {
	var existingID int64
	var existingHash, existingRaw string
	err := tx.QueryRowContext(ctx, `
		SELECT id, content_hash, snapshot_json
		FROM metadata_snapshot
		WHERE work_id = ? AND provider_id = ? AND external_id = ?
		ORDER BY fetched_at DESC, id DESC
		LIMIT 1
	`, workID, providerID, externalID).Scan(&existingID, &existingHash, &existingRaw)
	if err == nil && (strings.TrimSpace(existingHash) == contentHash || (strings.TrimSpace(existingHash) == "" && existingRaw == string(raw))) {
		if _, err := tx.ExecContext(ctx, `
			UPDATE metadata_snapshot
			SET fetched_at = CURRENT_TIMESTAMP,
				snapshot_json = ?, variant_key = ?, edition_language = ?, request_locale = ?, content_hash = ?
			WHERE id = ?
		`, string(raw), variantKey, editionLanguage, requestLocale, contentHash, existingID); err != nil {
			return err
		}
		return retainMetadataSnapshots(ctx, tx, workID, providerID, externalID)
	}
	if !errors.Is(err, sql.ErrNoRows) && err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_snapshot (
			work_id, provider_id, external_id, snapshot_json,
			variant_key, edition_language, request_locale, content_hash
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, workID, providerID, externalID, string(raw), variantKey, editionLanguage, requestLocale, contentHash); err != nil {
		return err
	}
	return retainMetadataSnapshots(ctx, tx, workID, providerID, externalID)
}

func retainMetadataSnapshots(ctx context.Context, tx *sql.Tx, workID, providerID int64, externalID string) error {
	_, err := tx.ExecContext(ctx, `
		DELETE FROM metadata_snapshot
		WHERE id IN (
			SELECT id
			FROM metadata_snapshot
			WHERE work_id = ? AND provider_id = ? AND external_id = ?
			ORDER BY fetched_at DESC, id DESC
			LIMIT -1 OFFSET 2
		)
	`, workID, providerID, externalID)
	return err
}

func upsertDLsiteMetadataVariant(
	ctx context.Context,
	tx *sql.Tx,
	logicalWorkID int64,
	workID int64,
	providerID int64,
	externalID string,
	editionLanguage string,
	requestLocale string,
	title string,
	genres []dlsite.Genre,
	contentHash string,
) error {
	tags := make([]string, 0, len(genres))
	seen := map[string]bool{}
	for _, genre := range genres {
		name := strings.TrimSpace(firstNonEmptyText(genre.Name, genre.NameBase))
		key := strings.ToLower(name)
		if name == "" || seen[key] {
			continue
		}
		seen[key] = true
		tags = append(tags, name)
	}
	tagsJSON, err := json.Marshal(tags)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO dlsite_metadata_variant (
			logical_work_id, work_id, provider_id, external_id,
			edition_language, request_locale, title, tags_json, content_hash,
			fetched_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(provider_id, work_id) DO UPDATE SET
			logical_work_id = excluded.logical_work_id,
			external_id = excluded.external_id,
			edition_language = excluded.edition_language,
			request_locale = excluded.request_locale,
			title = excluded.title,
			tags_json = excluded.tags_json,
			content_hash = excluded.content_hash,
			fetched_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
	`, logicalWorkID, workID, providerID, externalID, editionLanguage, requestLocale, strings.TrimSpace(title), string(tagsJSON), contentHash)
	return err
}

func (s *DLsiteSyncer) ensureWorkForProduct(ctx context.Context, product dlsite.Product) (int64, error) {
	code := strings.ToUpper(strings.TrimSpace(product.WorkNo))
	if code == "" {
		code = strings.ToUpper(strings.TrimSpace(product.ProductID))
	}
	if code == "" {
		return 0, fmt.Errorf("empty product code")
	}
	// DLsite may publish a replacement product code for an existing language
	// edition.  The replacement remains a provider code, not a second Kikoto
	// work. Reuse a known parent only inside the explicitly declared origin
	// family, and do not merge a replacement that already has its own work.
	if ownerID, _, err := ExistingReplacementEdition(ctx, s.db, product); err != nil {
		return 0, err
	} else if ownerID > 0 {
		return ownerID, nil
	}
	// An existing work keeps its descriptive columns here: applyProduct writes
	// them only after confirming that no newer result was stored meanwhile.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, title_kana, description, release_date, age_rating)
		VALUES (?, 'audio', ?, ?, ?, ?, ?)
		ON CONFLICT(primary_code) DO NOTHING
	`, code, chooseTitle(product), product.WorkNameKana, chooseDescription(product), nullableText(product.RegistDate), product.AgeCategoryString); err != nil {
		return 0, err
	}
	workID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", code)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return workID, nil
}

func ensureMetadataProvider(ctx context.Context, tx *sql.Tx, code string, displayName string) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_provider (code, display_name)
		VALUES (?, ?)
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name
	`, code, displayName); err != nil {
		return 0, err
	}

	var id int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = ?", code).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, sql.ErrNoRows
		}
		return 0, err
	}
	return id, nil
}

func mustJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(data)
}

func chooseTitle(product dlsite.Product) string {
	if strings.TrimSpace(product.ProductName) != "" {
		return strings.TrimSpace(product.ProductName)
	}
	if strings.TrimSpace(product.WorkName) != "" {
		return strings.TrimSpace(product.WorkName)
	}
	return product.WorkNo
}

func chooseDescription(product dlsite.Product) string {
	if strings.TrimSpace(product.IntroShort) != "" {
		return strings.TrimSpace(product.IntroShort)
	}
	return strings.TrimSpace(product.Intro)
}

func nullableText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func upsertDLsiteWorkEdition(ctx context.Context, tx *sql.Tx, providerID int64, workID int64, product dlsite.Product) error {
	currentCode := strings.ToUpper(strings.TrimSpace(product.WorkNo))
	if currentCode == "" {
		currentCode = strings.ToUpper(strings.TrimSpace(product.ProductID))
	}
	if currentCode == "" {
		return nil
	}
	var existingPrimaryCode string
	if err := tx.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&existingPrimaryCode); err != nil {
		return err
	}
	// A product with a declared parent can be a reissued code for an existing
	// edition. Keep the edition's stable primary code and record the provider
	// code as an alias instead of overwriting work_edition.primary_code.
	if !strings.EqualFold(strings.TrimSpace(existingPrimaryCode), currentCode) {
		matches, err := ProductMatchesExistingEdition(ctx, tx, product, existingPrimaryCode)
		if err != nil {
			return err
		}
		if matches {
			var logicalWorkID int64
			if err := tx.QueryRowContext(ctx, "SELECT logical_work_id FROM work_edition WHERE work_id = ?", workID).Scan(&logicalWorkID); err != nil {
				return err
			}
			if err := upsertWorkCodeAlias(ctx, tx, logicalWorkID, providerID, currentCode, productEditionLanguage(product), productEditionLabel(product), workID, "provider_reissued"); err != nil {
				return err
			}
			canonicalCode := ""
			if err := tx.QueryRowContext(ctx, "SELECT canonical_code FROM logical_work WHERE id = ?", logicalWorkID).Scan(&canonicalCode); err != nil {
				return err
			}
			return syncKnownProductLanguageEditions(ctx, tx, providerID, logicalWorkID, canonicalCode, product.LanguageEditions)
		}
		return fmt.Errorf("provider product does not match the existing edition")
	}
	if !productDeclaresFamily(product) {
		if kept, err := keepClassifiedEditionFamily(ctx, tx, providerID, workID, currentCode, product); err != nil || kept {
			return err
		}
	}
	baseCode := baseProductCode(product)
	canonicalCode := currentCode
	if baseCode != "" {
		canonicalCode = baseCode
	}
	canonicalWorkID, _ := sqlutil.SelectID(ctx, tx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", canonicalCode)
	var canonical any
	if canonicalWorkID > 0 {
		canonical = canonicalWorkID
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO logical_work (canonical_work_id, canonical_code, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(canonical_code) DO UPDATE SET
			canonical_work_id = COALESCE(excluded.canonical_work_id, logical_work.canonical_work_id),
			updated_at = CURRENT_TIMESTAMP
	`, canonical, canonicalCode); err != nil {
		return err
	}
	logicalWorkID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM logical_work WHERE canonical_code = ?", canonicalCode)
	if err != nil {
		return err
	}
	language := productEditionLanguage(product)
	editionLabel := productEditionLabel(product)
	isCanonical := 0
	if strings.EqualFold(currentCode, canonicalCode) {
		isCanonical = 1
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, metadata_language, edition_label, is_canonical, maker_id, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id) DO UPDATE SET
			logical_work_id = excluded.logical_work_id,
			provider_id = excluded.provider_id,
			primary_code = excluded.primary_code,
			base_code = excluded.base_code,
			metadata_language = excluded.metadata_language,
			edition_label = excluded.edition_label,
			is_canonical = excluded.is_canonical,
			maker_id = CASE WHEN excluded.maker_id <> '' THEN excluded.maker_id ELSE work_edition.maker_id END,
			updated_at = CURRENT_TIMESTAMP
	`, workID, logicalWorkID, providerID, currentCode, baseCode, language, editionLabel, isCanonical, strings.ToUpper(strings.TrimSpace(product.MakerID))); err != nil {
		return err
	}
	if err := upsertWorkCodeAlias(ctx, tx, logicalWorkID, providerID, currentCode, language, editionLabel, workID, "persisted_edition"); err != nil {
		return err
	}
	if err := upsertWorkCodeAlias(ctx, tx, logicalWorkID, providerID, canonicalCode, "", "", nil, "provider_declared"); err != nil {
		return err
	}
	if isCanonical == 1 {
		if _, err = tx.ExecContext(ctx, "UPDATE logical_work SET canonical_work_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", workID, logicalWorkID); err != nil {
			return err
		}
	}
	return syncKnownProductLanguageEditions(ctx, tx, providerID, logicalWorkID, canonicalCode, product.LanguageEditions)
}

// productDeclaresFamily reports whether a response says anything about the
// product's family: a translation_info or a language_editions list.
func productDeclaresFamily(product dlsite.Product) bool {
	info := product.TranslationInfo
	return strings.TrimSpace(info.OriginalWorkNo) != "" || strings.TrimSpace(info.ParentWorkNo) != "" ||
		strings.TrimSpace(info.Lang) != "" || len(info.StatusForTranslatorByLang) > 0 ||
		len(product.LanguageEditions) > 0
}

// keepClassifiedEditionFamily keeps the family of an edition that is already
// classified when a response declares none. Without a translation_info or a
// language_editions list a response looks like an origin of its own, which is
// no evidence against the family an earlier response declared. The edition's
// descriptive fields still follow the response. It reports whether the
// edition was already classified.
func keepClassifiedEditionFamily(ctx context.Context, tx *sql.Tx, providerID int64, workID int64, currentCode string, product dlsite.Product) (bool, error) {
	var logicalWorkID int64
	err := tx.QueryRowContext(ctx, "SELECT logical_work_id FROM work_edition WHERE work_id = ?", workID).Scan(&logicalWorkID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	language := productEditionLanguage(product)
	label := productEditionLabel(product)
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_edition
		SET provider_id = ?,
			metadata_language = CASE WHEN ? <> '' THEN ? ELSE metadata_language END,
			edition_label = CASE WHEN ? <> '' THEN ? ELSE edition_label END,
			maker_id = CASE WHEN ? <> '' THEN ? ELSE maker_id END,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ?
	`, providerID, language, language, label, label, strings.ToUpper(strings.TrimSpace(product.MakerID)), strings.ToUpper(strings.TrimSpace(product.MakerID)), workID); err != nil {
		return false, err
	}
	return true, upsertWorkCodeAlias(ctx, tx, logicalWorkID, providerID, currentCode, language, label, workID, "persisted_edition")
}

func syncKnownProductLanguageEditions(ctx context.Context, tx *sql.Tx, providerID int64, logicalWorkID int64, canonicalCode string, editions []dlsite.LanguageEdition) error {
	for _, edition := range editions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if !dlsiteWorkNoPattern.MatchString(code) {
			continue
		}
		language := editionLanguageValue(edition)
		label := strings.TrimSpace(edition.Label)
		if err := upsertWorkCodeAlias(ctx, tx, logicalWorkID, providerID, code, language, label, nil, "provider_declared"); err != nil {
			return err
		}
		editionWorkID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return err
		}
		isCanonical := 0
		if strings.EqualFold(code, canonicalCode) {
			isCanonical = 1
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, metadata_language, edition_label, is_canonical, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(work_id) DO UPDATE SET
				logical_work_id = excluded.logical_work_id,
				provider_id = excluded.provider_id,
				primary_code = excluded.primary_code,
				base_code = excluded.base_code,
				metadata_language = CASE
					WHEN excluded.metadata_language <> '' THEN excluded.metadata_language
					ELSE work_edition.metadata_language
				END,
				edition_label = CASE
					WHEN excluded.edition_label <> '' THEN excluded.edition_label
					ELSE work_edition.edition_label
				END,
				is_canonical = excluded.is_canonical,
				updated_at = CURRENT_TIMESTAMP
		`, editionWorkID, logicalWorkID, providerID, code, canonicalCode, language, label, isCanonical); err != nil {
			return err
		}
		if err := upsertWorkCodeAlias(ctx, tx, logicalWorkID, providerID, code, language, label, editionWorkID, "persisted_edition"); err != nil {
			return err
		}
	}
	return nil
}

func upsertWorkCodeAlias(ctx context.Context, tx *sql.Tx, logicalWorkID int64, providerID int64, code string, language string, label string, sourceWorkID any, relationshipKind string) error {
	code = strings.ToUpper(strings.TrimSpace(code))
	if !dlsiteWorkNoPattern.MatchString(code) {
		return nil
	}
	if relationshipKind != "persisted_edition" && relationshipKind != "provider_reissued" {
		relationshipKind = "provider_declared"
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO work_code_alias (
			logical_work_id, provider_id, primary_code, metadata_language,
			edition_label, source_work_id, relationship_kind, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(provider_id, primary_code) DO UPDATE SET
			logical_work_id = excluded.logical_work_id,
			metadata_language = CASE
				WHEN excluded.metadata_language <> '' THEN excluded.metadata_language
				ELSE work_code_alias.metadata_language
			END,
			edition_label = CASE
				WHEN excluded.edition_label <> '' THEN excluded.edition_label
				ELSE work_code_alias.edition_label
			END,
			source_work_id = COALESCE(excluded.source_work_id, work_code_alias.source_work_id),
			relationship_kind = CASE
				WHEN excluded.source_work_id IS NOT NULL THEN excluded.relationship_kind
				ELSE work_code_alias.relationship_kind
			END,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_code_alias.relationship_kind <> 'provider_reissued'
			OR (work_code_alias.logical_work_id = excluded.logical_work_id
				AND (excluded.source_work_id IS NULL OR work_code_alias.source_work_id = excluded.source_work_id))
	`, logicalWorkID, providerID, code, strings.TrimSpace(language), strings.TrimSpace(label), sourceWorkID, relationshipKind)
	if err == nil && relationshipKind == "provider_reissued" {
		changed, changeErr := result.RowsAffected()
		if changeErr != nil {
			return changeErr
		}
		if changed == 0 {
			return errors.New("provider replacement conflicts with an existing work identity")
		}
	}
	return err
}

func snapshotWithKikotoMeta(raw json.RawMessage, metadata map[string]any) json.RawMessage {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err == nil {
		encoded, err := json.Marshal(metadata)
		if err == nil {
			object["_kikoto"] = encoded
			if next, err := json.Marshal(object); err == nil {
				return next
			}
		}
	}
	return raw
}
