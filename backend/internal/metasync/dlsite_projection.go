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

// DLsiteMetadataVariant is the language-scoped title/tag projection captured
// alongside a raw provider snapshot. Work identity remains the work/edition;
// this record only describes one metadata representation of that identity.
type DLsiteMetadataVariant struct {
	ID              int64
	LogicalWorkID   int64
	WorkID          int64
	PrimaryCode     string
	ExternalID      string
	EditionLanguage string
	RequestLocale   string
	Title           string
	TagsJSON        string
	ContentHash     string
	FetchedAt       string
	IsCanonical     bool
}

// SelectDLsiteMetadataVariant returns the best available title/tag variant
// for a work family according to the configured priority. The origin token
// matches the canonical edition, regardless of that edition's actual
// language. Unknown edition languages are retained in the table but never
// become a priority match.
func SelectDLsiteMetadataVariant(ctx context.Context, db *sql.DB, workID int64, priorities []string) (DLsiteMetadataVariant, bool, error) {
	variants, err := ListDLsiteMetadataVariants(ctx, db, workID)
	if err != nil {
		return DLsiteMetadataVariant{}, false, err
	}
	selected := chooseDLsiteMetadataVariant(variants, priorities)
	return selected, selected.ID > 0, nil
}

// ListDLsiteMetadataVariants returns the stored title/tag representations for
// the logical family containing workID. The variants do not create or replace
// work identities; PrimaryCode is only a stable presentation key.
func ListDLsiteMetadataVariants(ctx context.Context, db *sql.DB, workID int64) ([]DLsiteMetadataVariant, error) {
	if db == nil || workID <= 0 {
		return []DLsiteMetadataVariant{}, nil
	}
	var logicalWorkID int64
	err := db.QueryRowContext(ctx, `
		SELECT logical_work_id
		FROM work_edition
		WHERE work_id = ?
	`, workID).Scan(&logicalWorkID)
	if errors.Is(err, sql.ErrNoRows) {
		return []DLsiteMetadataVariant{}, nil
	}
	if err != nil {
		return nil, err
	}
	return loadDLsiteMetadataVariants(ctx, db, logicalWorkID)
}

// ProjectDLsiteMetadata updates the canonical work title and DLsite tags for
// every known family. It is called after a priority change so the existing
// library/search projections reflect the new choice without another provider
// request.
func ProjectDLsiteMetadata(ctx context.Context, db *sql.DB, priorities []string) error {
	if db == nil {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, "SELECT id FROM logical_work ORDER BY id ASC")
	if err != nil {
		return err
	}
	logicalIDs := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		logicalIDs = append(logicalIDs, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, logicalID := range logicalIDs {
		if err := projectDLsiteMetadataFamilyTx(ctx, tx, logicalID, priorities); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ProjectDLsiteMetadataFamily updates one logical family. SyncProduct uses
// this narrower operation to avoid reprojecting the entire library after each
// provider response.
func ProjectDLsiteMetadataFamily(ctx context.Context, db *sql.DB, logicalWorkID int64, priorities []string) error {
	if db == nil || logicalWorkID <= 0 {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := projectDLsiteMetadataFamilyTx(ctx, tx, logicalWorkID, priorities); err != nil {
		return err
	}
	return tx.Commit()
}

type metadataVariantQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func loadDLsiteMetadataVariants(ctx context.Context, queryer metadataVariantQuerier, logicalWorkID int64) ([]DLsiteMetadataVariant, error) {
	rows, err := queryer.QueryContext(ctx, `
		SELECT
			variant.id,
			variant.logical_work_id,
			variant.work_id,
			COALESCE(edition.primary_code, ''),
			variant.external_id,
			variant.edition_language,
			variant.request_locale,
			variant.title,
			variant.tags_json,
			variant.content_hash,
			variant.fetched_at,
			COALESCE(edition.is_canonical, 0)
		FROM dlsite_metadata_variant AS variant
		LEFT JOIN work_edition AS edition ON edition.work_id = variant.work_id
		WHERE variant.logical_work_id = ?
		ORDER BY variant.fetched_at DESC, variant.id DESC
	`, logicalWorkID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	variants := []DLsiteMetadataVariant{}
	for rows.Next() {
		var variant DLsiteMetadataVariant
		var canonical int
		if err := rows.Scan(
			&variant.ID,
			&variant.LogicalWorkID,
			&variant.WorkID,
			&variant.PrimaryCode,
			&variant.ExternalID,
			&variant.EditionLanguage,
			&variant.RequestLocale,
			&variant.Title,
			&variant.TagsJSON,
			&variant.ContentHash,
			&variant.FetchedAt,
			&canonical,
		); err != nil {
			return nil, err
		}
		variant.IsCanonical = canonical != 0
		variants = append(variants, variant)
	}
	return variants, rows.Err()
}

func chooseDLsiteMetadataVariant(variants []DLsiteMetadataVariant, priorities []string) DLsiteMetadataVariant {
	if len(variants) == 0 {
		return DLsiteMetadataVariant{}
	}
	ordered := dlsite.NormalizeMetadataPriority(priorities)
	for _, priority := range ordered {
		for _, variant := range variants {
			if !variantMatchesPriority(variant, priority) || strings.TrimSpace(variant.Title) == "" {
				continue
			}
			return variant
		}
	}
	// Unknown provider languages are retained for traceability but are not a
	// display fallback.  `origin` is always present in the normalized priority
	// list and matches the canonical edition even when its actual language is
	// not Japanese.
	return DLsiteMetadataVariant{}
}

func variantMatchesPriority(variant DLsiteMetadataVariant, priority string) bool {
	if priority == dlsite.OriginMetadataLanguage {
		return variant.IsCanonical
	}
	return dlsite.EditionMetadataLanguage(variant.EditionLanguage) == priority
}

func projectDLsiteMetadataFamilyTx(ctx context.Context, tx *sql.Tx, logicalWorkID int64, priorities []string) error {
	variants, err := loadDLsiteMetadataVariants(ctx, tx, logicalWorkID)
	if err != nil {
		return err
	}
	if len(variants) == 0 {
		return nil
	}
	selected := chooseDLsiteMetadataVariant(variants, priorities)
	if selected.WorkID <= 0 || strings.TrimSpace(selected.Title) == "" {
		return nil
	}
	canonicalWorkID, err := canonicalWorkIDTx(ctx, tx, logicalWorkID)
	if err != nil || canonicalWorkID <= 0 {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE work
		SET title = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND title <> ?
	`, strings.TrimSpace(selected.Title), canonicalWorkID, strings.TrimSpace(selected.Title)); err != nil {
		return err
	}
	if err := replaceProjectedDLsiteTags(ctx, tx, canonicalWorkID, selected); err != nil {
		return err
	}
	return nil
}

func canonicalWorkIDTx(ctx context.Context, tx *sql.Tx, logicalWorkID int64) (int64, error) {
	var workID sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT COALESCE(
			logical.canonical_work_id,
			(SELECT edition.work_id FROM work_edition AS edition WHERE edition.logical_work_id = logical.id AND edition.is_canonical = 1 LIMIT 1),
			(SELECT edition.work_id FROM work_edition AS edition WHERE edition.logical_work_id = logical.id ORDER BY edition.work_id ASC LIMIT 1)
		)
		FROM logical_work AS logical
		WHERE logical.id = ?
	`, logicalWorkID).Scan(&workID); err != nil {
		return 0, err
	}
	if !workID.Valid {
		return 0, nil
	}
	return workID.Int64, nil
}

func replaceProjectedDLsiteTags(ctx context.Context, tx *sql.Tx, workID int64, variant DLsiteMetadataVariant) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_tag WHERE work_id = ? AND source = 'dlsite'", workID); err != nil {
		return err
	}
	var tags []string
	if err := json.Unmarshal([]byte(variant.TagsJSON), &tags); err != nil {
		return fmt.Errorf("decode DLsite metadata tags: %w", err)
	}
	language := dlsite.EditionMetadataLanguage(variant.EditionLanguage)
	if language == "" {
		language = strings.ToLower(strings.TrimSpace(variant.RequestLocale))
	}
	if language == "" {
		language = strings.TrimSpace(variant.EditionLanguage)
	}
	seen := map[string]bool{}
	for _, raw := range tags {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		normalized := strings.ToLower(name)
		if seen[normalized] {
			continue
		}
		seen[normalized] = true
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO tag (namespace, normalized_name, display_name, language)
			VALUES ('dlsite', ?, ?, ?)
			ON CONFLICT(namespace, normalized_name, language) DO UPDATE SET
				display_name = excluded.display_name,
				updated_at = CURRENT_TIMESTAMP
		`, normalized, name, language); err != nil {
			return err
		}
		var tagID int64
		if err := tx.QueryRowContext(ctx, `
			SELECT id FROM tag
			WHERE namespace = 'dlsite' AND normalized_name = ? AND language = ?
		`, normalized, language).Scan(&tagID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_tag (work_id, tag_id, source)
			VALUES (?, ?, 'dlsite')
			ON CONFLICT(work_id, tag_id, source) DO NOTHING
		`, workID, tagID); err != nil {
			return err
		}
	}
	return nil
}
