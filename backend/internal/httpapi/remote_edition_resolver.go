package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

const maxRemoteEditionCandidates = 8

func (s *Server) resolveRemoteEdition(ctx context.Context, source remoteSourceForUse, client *kikoeru.Client, code string) (kikoeru.Work, json.RawMessage, error) {
	work, raw, err := s.resolveKikoeruWork(ctx, client, code)
	if errors.Is(err, errRemoteWorkNotFound) {
		work, err = s.resolveRemoteEditionFallback(ctx, source, client, code)
		if err == nil {
			raw, err = json.Marshal(work)
		}
		return work, raw, err
	}
	if err != nil {
		return work, raw, err
	}
	if local := normalizeDLsiteCode(code); local != "" && normalizedRemoteWorkCode(work) != local {
		if err := s.verifyRemoteWorkIdentity(ctx, work); err != nil {
			return kikoeru.Work{}, nil, err
		}
		if s.localCodeForRemoteWork(ctx, local, work) != local {
			return kikoeru.Work{}, nil, errRemoteWorkNotFound
		}
	}
	return work, raw, nil
}

// resolveRemoteEditionFallback keeps source-local discovery separate from work
// identity. Only exact DLsite responses with verified family evidence authorize an alias.
// Requests use the supplied source client and the shared DLsite transport; no
// URL from either response becomes a new request destination.
func (s *Server) resolveRemoteEditionFallback(ctx context.Context, source remoteSourceForUse, client *kikoeru.Client, localCode string) (kikoeru.Work, error) {
	if s.cfg.IsDemo() || !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		return kikoeru.Work{}, errRemoteWorkNotFound
	}
	if err := ctx.Err(); err != nil {
		return kikoeru.Work{}, err
	}
	localCode = normalizeDLsiteCode(localCode)
	if localCode == "" {
		return kikoeru.Work{}, errRemoteWorkNotFound
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	aliases, err := s.remoteEditionAliasCodes(ctx, localCode)
	if err != nil {
		return kikoeru.Work{}, err
	}
	for _, code := range aliases {
		work, _, err := s.resolveKikoeruWork(ctx, client, code)
		if err == nil && strings.EqualFold(normalizedRemoteWorkCode(work), code) {
			return work, nil
		}
		if err != nil && !errors.Is(err, errRemoteWorkNotFound) {
			return kikoeru.Work{}, err
		}
	}
	if s.dlsiteClient == nil {
		return kikoeru.Work{}, errRemoteWorkNotFound
	}
	canonical, err := s.localEditionCanonicalCode(ctx, localCode)
	if err != nil {
		return kikoeru.Work{}, err
	}
	if canonical == "" || canonical == localCode {
		return kikoeru.Work{}, errRemoteWorkNotFound
	}
	origin, _, err := s.resolveKikoeruWork(ctx, client, canonical)
	if err != nil {
		return kikoeru.Work{}, err
	}
	if !strings.EqualFold(normalizedRemoteWorkCode(origin), canonical) {
		return kikoeru.Work{}, errRemoteWorkNotFound
	}
	seen := map[string]bool{localCode: true, canonical: true}
	checked := 0
	for index, edition := range origin.OtherLanguageEditions {
		// Bound both response traversal and provider lookups. Candidates remain
		// in memory; discovery never creates works or walks sibling families.
		if index >= 32 || checked >= maxRemoteEditionCandidates {
			break
		}
		if err := ctx.Err(); err != nil {
			return kikoeru.Work{}, err
		}
		candidate := normalizeDLsiteCode(edition.SourceID)
		if candidate == "" || seen[candidate] {
			continue
		}
		seen[candidate] = true
		checked++
		product, err := s.dlsiteClient.FetchProduct(ctx, candidate)
		if errors.Is(err, dlsite.ErrNoProduct) {
			continue
		}
		if err != nil {
			return kikoeru.Work{}, err
		}
		if normalizeWorkCode(firstNonEmpty(product.WorkNo, product.ProductID)) != candidate {
			continue
		}
		matches, err := metasync.ProductMatchesExistingEdition(ctx, s.db, product, localCode)
		if err != nil {
			return kikoeru.Work{}, err
		}
		if !matches {
			continue
		}
		work, _, err := s.resolveKikoeruWork(ctx, client, candidate)
		if errors.Is(err, errRemoteWorkNotFound) {
			continue
		}
		if err != nil {
			return kikoeru.Work{}, err
		}
		if !strings.EqualFold(normalizedRemoteWorkCode(work), candidate) {
			continue
		}
		persisted, err := s.persistDLsiteReplacementAlias(ctx, localCode, candidate, product)
		if err != nil {
			return kikoeru.Work{}, err
		}
		if persisted {
			return work, nil
		}
	}
	return kikoeru.Work{}, errRemoteWorkNotFound
}

func (s *Server) remoteEditionAliasCodes(ctx context.Context, localCode string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT alias.primary_code
		FROM work_edition AS edition
		INNER JOIN work_code_alias AS alias ON alias.logical_work_id = edition.logical_work_id
		INNER JOIN metadata_provider AS provider ON provider.id = alias.provider_id AND provider.code = 'dlsite'
		WHERE UPPER(edition.primary_code) = UPPER(?)
			AND alias.source_work_id = edition.work_id
			AND alias.relationship_kind = 'provider_reissued'
			AND UPPER(alias.primary_code) <> UPPER(?)
		ORDER BY alias.id ASC
		LIMIT 8
	`, localCode, localCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		if code = normalizeWorkCode(code); code != "" {
			result = append(result, code)
		}
	}
	return result, rows.Err()
}

func (s *Server) localEditionCanonicalCode(ctx context.Context, localCode string) (string, error) {
	var canonical string
	err := s.db.QueryRowContext(ctx, `
		SELECT logical.canonical_code
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE UPPER(edition.primary_code) = UPPER(?)
		LIMIT 1
	`, localCode).Scan(&canonical)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return normalizeWorkCode(canonical), err
}

func (s *Server) persistDLsiteReplacementAlias(ctx context.Context, localCode, candidate string, product dlsite.Product) (bool, error) {
	if s.cfg.IsDemo() {
		return false, nil
	}
	canonical := normalizeDLsiteCode(product.TranslationInfo.OriginalWorkNo)
	if canonical == "" || normalizeWorkCode(firstNonEmpty(product.WorkNo, product.ProductID)) != candidate {
		return false, nil
	}
	ownerID, ownerCode, err := metasync.ExistingReplacementEdition(ctx, s.db, product)
	if err != nil || ownerID == 0 || !strings.EqualFold(ownerCode, localCode) {
		return false, err
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	matches, err := metasync.ProductMatchesExistingEdition(ctx, tx, product, localCode)
	if err != nil || !matches {
		return false, err
	}
	var logicalWorkID, workID int64
	if err := tx.QueryRowContext(ctx, `
		SELECT edition.logical_work_id, edition.work_id
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE UPPER(edition.primary_code) = UPPER(?)
			AND UPPER(logical.canonical_code) = UPPER(?)
			AND NOT EXISTS (SELECT 1 FROM work WHERE UPPER(primary_code) = UPPER(?))
		LIMIT 1
	`, localCode, canonical, candidate).Scan(&logicalWorkID, &workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_provider (code, display_name)
		VALUES ('dlsite', 'DLsite')
		ON CONFLICT(code) DO NOTHING
	`); err != nil {
		return false, err
	}
	var providerID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		return false, err
	}
	language := strings.TrimSpace(product.TranslationInfo.Lang)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_code_alias (
			logical_work_id, provider_id, primary_code, metadata_language,
			source_work_id, relationship_kind, updated_at
		)
		VALUES (?, ?, ?, ?, ?, 'provider_reissued', CURRENT_TIMESTAMP)
		ON CONFLICT(provider_id, primary_code) DO UPDATE SET
			metadata_language = excluded.metadata_language,
			source_work_id = excluded.source_work_id,
			relationship_kind = excluded.relationship_kind,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_code_alias.logical_work_id = excluded.logical_work_id
			AND (work_code_alias.source_work_id IS NULL OR work_code_alias.source_work_id = excluded.source_work_id)
	`, logicalWorkID, providerID, candidate, language, workID); err != nil {
		return false, err
	}
	var aliasLogicalID, aliasWorkID sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT logical_work_id, source_work_id
		FROM work_code_alias
		WHERE provider_id = ? AND UPPER(primary_code) = UPPER(?)
	`, providerID, candidate).Scan(&aliasLogicalID, &aliasWorkID); err != nil {
		return false, err
	}
	if !aliasLogicalID.Valid || aliasLogicalID.Int64 != logicalWorkID || !aliasWorkID.Valid || aliasWorkID.Int64 != workID {
		return false, nil
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// verifyRemoteWorkIdentity runs before persistence transactions, so an exact
// candidate lookup can reuse a known edition without holding a database lock.
// Only the explicitly selected remote work is checked; siblings stay candidates.
func (s *Server) verifyRemoteWorkIdentity(ctx context.Context, work kikoeru.Work) error {
	if s.cfg.IsDemo() || s.dlsiteClient == nil {
		return nil
	}
	code := normalizeDLsiteCode(normalizedRemoteWorkCode(work))
	if code == "" {
		return nil
	}
	var known int
	if err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (SELECT 1 FROM work WHERE UPPER(primary_code) = ?)
			OR NOT EXISTS (SELECT 1 FROM work_edition WHERE is_canonical = 0)
			OR EXISTS (SELECT 1 FROM work_code_alias AS alias
			INNER JOIN metadata_provider AS provider ON provider.id = alias.provider_id AND provider.code = 'dlsite'
			INNER JOIN work_edition AS edition ON edition.work_id = alias.source_work_id AND edition.logical_work_id = alias.logical_work_id
			WHERE UPPER(alias.primary_code) = ? AND alias.relationship_kind = 'provider_reissued' AND alias.source_work_id IS NOT NULL)
	`, code, code).Scan(&known); err != nil {
		return err
	}
	if known != 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	product, err := s.dlsiteClient.FetchProduct(ctx, code)
	if errors.Is(err, dlsite.ErrNoProduct) {
		return nil
	}
	if err != nil {
		return err
	}
	if normalizeWorkCode(firstNonEmpty(product.WorkNo, product.ProductID)) != code {
		return errors.New("provider returned a mismatched product code")
	}
	ownerID, localCode, err := metasync.ExistingReplacementEdition(ctx, s.db, product)
	if err != nil || ownerID == 0 {
		return err
	}
	persisted, err := s.persistDLsiteReplacementAlias(ctx, localCode, code, product)
	if err == nil && !persisted {
		return errors.New("provider replacement conflicts with an existing work identity")
	}
	return err
}

// localCodeForRemoteWork keeps Fetch paths and work ownership on Kikoto's
// edition identity after a source lookup returns a replacement provider code.
func (s *Server) localCodeForRemoteWork(ctx context.Context, requestedCode string, remoteWork kikoeru.Work) string {
	requestedCode = normalizeWorkCode(requestedCode)
	var localCode string
	remoteCode := normalizeWorkCode(normalizedRemoteWorkCode(remoteWork))
	if remoteCode != "" {
		if err := s.db.QueryRowContext(ctx, `
			SELECT work.primary_code
			FROM work_code_alias AS alias
			INNER JOIN metadata_provider AS provider ON provider.id = alias.provider_id AND provider.code = 'dlsite'
			INNER JOIN work ON work.id = alias.source_work_id
			INNER JOIN work_edition AS edition ON edition.work_id = work.id AND edition.logical_work_id = alias.logical_work_id
			WHERE UPPER(alias.primary_code) = UPPER(?)
				AND alias.relationship_kind = 'provider_reissued'
			LIMIT 1
		`, remoteCode).Scan(&localCode); err == nil {
			return normalizeWorkCode(localCode)
		}
		return remoteCode
	}
	return requestedCode
}
