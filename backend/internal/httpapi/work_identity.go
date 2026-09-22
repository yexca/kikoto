package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

func (s *Server) workCodeExists(ctx context.Context, code string) bool {
	_, ok := s.workIDForCode(ctx, code)
	return ok
}

func (s *Server) workIDForCode(ctx context.Context, code string) (int64, bool) {
	var id int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&id); err != nil {
		return 0, false
	}
	return id, true
}

type canonicalWorkRef struct {
	WorkID int64
	Code   string
	Known  bool
}

func (s *Server) canonicalWorkForCode(ctx context.Context, code string) (canonicalWorkRef, error) {
	code = normalizeDLsiteCode(code)
	if code == "" {
		return canonicalWorkRef{}, nil
	}
	var canonicalID sql.NullInt64
	var canonicalCode string
	err := s.db.QueryRowContext(ctx, `
		SELECT logical.canonical_work_id, logical.canonical_code
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE UPPER(edition.primary_code) = UPPER(?)
	`, code).Scan(&canonicalID, &canonicalCode)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return canonicalWorkRef{}, err
	}
	if err == nil {
		canonicalCode = normalizeDLsiteCode(canonicalCode)
		if canonicalID.Valid {
			return canonicalWorkRef{WorkID: canonicalID.Int64, Code: canonicalCode, Known: true}, nil
		}
		if id, ok := s.workIDForCode(ctx, canonicalCode); ok {
			return canonicalWorkRef{WorkID: id, Code: canonicalCode, Known: true}, nil
		}
		return canonicalWorkRef{Code: canonicalCode, Known: false}, nil
	}
	err = s.db.QueryRowContext(ctx, `
		SELECT logical.canonical_work_id, logical.canonical_code
		FROM work_code_alias AS alias
		INNER JOIN logical_work AS logical ON logical.id = alias.logical_work_id
		WHERE UPPER(alias.primary_code) = UPPER(?)
		ORDER BY CASE WHEN alias.source_work_id IS NOT NULL THEN 0 ELSE 1 END, alias.id
		LIMIT 1
	`, code).Scan(&canonicalID, &canonicalCode)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return canonicalWorkRef{}, err
	}
	if err == nil {
		canonicalCode = normalizeDLsiteCode(canonicalCode)
		if canonicalID.Valid {
			return canonicalWorkRef{WorkID: canonicalID.Int64, Code: canonicalCode, Known: true}, nil
		}
		if id, ok := s.workIDForCode(ctx, canonicalCode); ok {
			return canonicalWorkRef{WorkID: id, Code: canonicalCode, Known: true}, nil
		}
		return canonicalWorkRef{Code: canonicalCode, Known: false}, nil
	}
	if id, ok := s.workIDForCode(ctx, code); ok {
		return canonicalWorkRef{WorkID: id, Code: code, Known: true}, nil
	}
	return canonicalWorkRef{Code: code, Known: false}, nil
}

func (s *Server) familyWorkIDsForCode(ctx context.Context, code string) ([]int64, error) {
	code = normalizeDLsiteCode(code)
	if code == "" {
		return []int64{}, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id
		FROM work
		WHERE UPPER(work.primary_code) = UPPER(?)
		UNION
		SELECT sibling.work_id
		FROM work AS current_work
		INNER JOIN work_edition AS current_edition ON current_edition.work_id = current_work.id
		INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
		WHERE UPPER(current_work.primary_code) = UPPER(?)
	`, code, code)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Server) syncWorkEditionForWorkFromSnapshot(ctx context.Context, workID int64, primaryCode string, metadata dlsiteSnapshotMetadata) error {
	primaryCode = normalizeDLsiteCode(primaryCode)
	if primaryCode == "" {
		return nil
	}
	canonicalCode := normalizeDLsiteCode(metadata.BaseCode)
	if canonicalCode == "" {
		canonicalCode = primaryCode
	}
	var provider any
	if providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite"); err != nil {
		return err
	} else {
		provider = providerID
	}
	canonicalWorkID, _ := s.workIDForCode(ctx, canonicalCode)
	var canonical any
	if canonicalWorkID > 0 {
		canonical = canonicalWorkID
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO logical_work (canonical_work_id, canonical_code, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(canonical_code) DO UPDATE SET
			canonical_work_id = COALESCE(excluded.canonical_work_id, logical_work.canonical_work_id),
			updated_at = CURRENT_TIMESTAMP
	`, canonical, canonicalCode); err != nil {
		return err
	}
	var logicalWorkID int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM logical_work WHERE canonical_code = ?", canonicalCode).Scan(&logicalWorkID); err != nil {
		return err
	}
	isCanonical := 0
	if strings.EqualFold(primaryCode, canonicalCode) {
		isCanonical = 1
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, metadata_language, is_canonical, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id) DO UPDATE SET
			logical_work_id = excluded.logical_work_id,
			provider_id = excluded.provider_id,
			primary_code = excluded.primary_code,
			base_code = excluded.base_code,
			metadata_language = excluded.metadata_language,
			is_canonical = excluded.is_canonical,
			updated_at = CURRENT_TIMESTAMP
	`, workID, logicalWorkID, provider, primaryCode, metadata.BaseCode, metadata.MetadataLanguage, isCanonical); err != nil {
		return err
	}
	if isCanonical == 1 {
		_, err := s.db.ExecContext(ctx, "UPDATE logical_work SET canonical_work_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", workID, logicalWorkID)
		if err != nil {
			return err
		}
	}
	return s.syncKnownLanguageEditions(ctx, logicalWorkID, provider, canonicalCode, metadata.LanguageEditions)
}

func (s *Server) syncKnownLanguageEditions(ctx context.Context, logicalWorkID int64, provider any, canonicalCode string, editions []workTranslation) error {
	for _, edition := range editions {
		code := normalizeDLsiteCode(edition.PrimaryCode)
		if code == "" {
			continue
		}
		editionWorkID, ok := s.workIDForCode(ctx, code)
		if !ok {
			continue
		}
		isCanonical := 0
		if strings.EqualFold(code, canonicalCode) {
			isCanonical = 1
		}
		if _, err := s.db.ExecContext(ctx, `
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
		`, editionWorkID, logicalWorkID, provider, code, canonicalCode, edition.MetadataLanguage, edition.EditionLabel, isCanonical); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) loadWorkEditionMetadata(ctx context.Context, workID int64) (string, string, error) {
	var canonicalCode string
	var language string
	if err := s.db.QueryRowContext(ctx, `
		SELECT logical.canonical_code, edition.metadata_language
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE edition.work_id = ?
	`, workID).Scan(&canonicalCode, &language); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", nil
		}
		return "", "", err
	}
	return canonicalCode, language, nil
}

func (s *Server) loadCanonicalWorkForCode(ctx context.Context, code string) (int64, string, error) {
	var workID sql.NullInt64
	var codeValue string
	if err := s.db.QueryRowContext(ctx, `
		SELECT logical.canonical_work_id, logical.canonical_code
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE UPPER(edition.primary_code) = UPPER(?)
	`, code).Scan(&workID, &codeValue); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, "", nil
		}
		return 0, "", err
	}
	if workID.Valid {
		return workID.Int64, codeValue, nil
	}
	if fallbackID, ok := s.workIDForCode(ctx, codeValue); ok {
		return fallbackID, codeValue, nil
	}
	return 0, codeValue, nil
}

func (s *Server) workEditionVisibleInLibrary(ctx context.Context, workID int64) (bool, error) {
	var canonicalID sql.NullInt64
	var isCanonical int
	if err := s.db.QueryRowContext(ctx, `
		SELECT logical.canonical_work_id, edition.is_canonical
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE edition.work_id = ?
	`, workID).Scan(&canonicalID, &isCanonical); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return true, nil
		}
		return false, err
	}
	if !canonicalID.Valid || canonicalID.Int64 == workID {
		return true, nil
	}
	return isCanonical != 0, nil
}

func (s *Server) resolveWorkCode(w http.ResponseWriter, r *http.Request) {
	code := normalizeDLsiteCode(r.PathValue("code"))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return
	}
	resolved, err := s.resolveWorkCodeDetail(r.Context(), code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	if !s.requireDemoWork(w, r, resolved.WorkID) {
		return
	}
	writeJSON(w, http.StatusOK, resolved)
}

func (s *Server) resolveMediaWorkID(ctx context.Context, currentWorkID int64, translations []workTranslation) (int64, error) {
	if hasLocal, err := s.workHasAvailableLocalMedia(ctx, currentWorkID); err != nil {
		return 0, err
	} else if hasLocal {
		return currentWorkID, nil
	}
	canonical, err := s.workIsCanonicalEdition(ctx, currentWorkID)
	if err != nil {
		return 0, err
	}
	if !canonical {
		return currentWorkID, nil
	}
	for _, translation := range translations {
		if translation.WorkID == nil || *translation.WorkID == currentWorkID {
			continue
		}
		hasLocal, err := s.workHasAvailableLocalMedia(ctx, *translation.WorkID)
		if err != nil {
			return 0, err
		}
		if hasLocal {
			return *translation.WorkID, nil
		}
	}
	if hasMedia, err := s.workHasMedia(ctx, currentWorkID); err != nil {
		return 0, err
	} else if hasMedia {
		return currentWorkID, nil
	}
	for _, translation := range translations {
		if translation.WorkID != nil && *translation.WorkID != currentWorkID && translation.HasMedia {
			return *translation.WorkID, nil
		}
	}
	return currentWorkID, nil
}

func (s *Server) workIsCanonicalEdition(ctx context.Context, workID int64) (bool, error) {
	var isCanonical bool
	if err := s.db.QueryRowContext(ctx, "SELECT is_canonical FROM work_edition WHERE work_id = ?", workID).Scan(&isCanonical); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return isCanonical, nil
}
