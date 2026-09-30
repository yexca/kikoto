package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// linkedProductIdentityKeys name the provider fields that place a product in a
// DLsite family. A linked snapshot describes the target work only, so these
// are removed rather than letting the source's family claim the target.
var linkedProductIdentityKeys = []string{
	"translation_info",
	"language_editions",
	"original_workno",
	"original_work_number",
	"base_workno",
	"base_code",
}

// metadataLinkSourceCode returns the user-declared DLsite source code for the
// work with code, if one exists.
func (s *DLsiteSyncer) metadataLinkSourceCode(ctx context.Context, code string) (string, bool, error) {
	var sourceCode string
	err := s.db.QueryRowContext(ctx, `SELECT link.source_code
		FROM work_metadata_link AS link
		JOIN work ON work.id = link.work_id
		JOIN metadata_provider AS provider ON provider.id = link.provider_id
		WHERE UPPER(work.primary_code) = UPPER(?) AND provider.code = 'dlsite'`, code).Scan(&sourceCode)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	sourceCode = strings.ToUpper(strings.TrimSpace(sourceCode))
	if !dlsiteWorkNoPattern.MatchString(sourceCode) || strings.EqualFold(sourceCode, code) {
		return "", false, nil
	}
	return sourceCode, true, nil
}

// syncLinkedWork refreshes a work from its linked source product. The source
// product is fetched but never materialized: the snapshot, normalized fields,
// tags, and cover are stored on the requested work under its own code, and the
// source's language family is not walked.
func (s *DLsiteSyncer) syncLinkedWork(ctx context.Context, code string, sourceCode string) (DLsiteFamilySyncResult, error) {
	result := DLsiteFamilySyncResult{
		RequestedCode: code,
		CanonicalCode: code,
		Codes:         []string{code},
		SyncedCodes:   []string{},
		SkippedCodes:  []string{},
		Failures:      []string{},
	}
	product, _, err := s.syncFetchedProduct(ctx, code, func(ctx context.Context, _ string) (dlsite.Product, error) {
		source, err := s.fetchOriginProduct(ctx, sourceCode)
		if err != nil {
			return dlsite.Product{}, err
		}
		return linkedMetadataProduct(source, code), nil
	})
	if err != nil {
		if dlsite.IsTimeout(err) || ctx.Err() != nil {
			return result, err
		}
		if errors.Is(err, dlsite.ErrNoProduct) {
			result.RequestedUnavailable = true
		}
		result.Failures = append(result.Failures, fmt.Sprintf("%s (metadata from %s): %s", code, sourceCode, err.Error()))
		return result, fmt.Errorf("DLsite family metadata could not be synchronized: %s", strings.Join(result.Failures, "; "))
	}
	result.SyncedCodes = append(result.SyncedCodes, code)
	if s.cacheRoot != "" {
		if _, err := s.downloadCover(ctx, product); err != nil {
			if dlsite.IsTimeout(err) || ctx.Err() != nil {
				return result, err
			}
			result.Failures = append(result.Failures, fmt.Sprintf("%s cover: %s", code, err.Error()))
		}
	}
	return result, nil
}

// linkedMetadataProduct re-addresses a fetched source product to the target
// code. Descriptive fields and the cover URL stay those of the source.
func linkedMetadataProduct(source dlsite.Product, targetCode string) dlsite.Product {
	product := source
	product.MetadataSourceCode = dlsiteProductCode(source)
	product.WorkNo = targetCode
	product.ProductID = targetCode
	product.TranslationInfo = dlsite.TranslationInfo{}
	product.LanguageEditions = nil
	product.ProductRaw = linkedProductRaw(source.ProductRaw, targetCode)
	product.Raw = linkedProductRaw(source.Raw, targetCode)
	return product
}

func linkedProductRaw(raw json.RawMessage, targetCode string) json.RawMessage {
	if len(raw) == 0 {
		return raw
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return raw
	}
	if nested, ok := object["product"]; ok && len(nested) > 0 {
		object["product"] = linkedProductRaw(nested, targetCode)
		return mustMarshalRaw(object, raw)
	}
	code := mustMarshalRaw(targetCode, nil)
	object["workno"] = code
	if _, ok := object["product_id"]; ok {
		object["product_id"] = code
	}
	for _, key := range linkedProductIdentityKeys {
		delete(object, key)
	}
	return mustMarshalRaw(object, raw)
}

func mustMarshalRaw(value any, fallback json.RawMessage) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fallback
	}
	return encoded
}
