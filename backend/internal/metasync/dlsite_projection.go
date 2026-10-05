package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
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
	Description     string
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
	return listDLsiteMetadataVariants(ctx, db, workID, false)
}

// ListDLsiteMetadataVariantsWithDescriptions is for the detail page only.
// Projection and list reads must not load every edition's introduction.
func ListDLsiteMetadataVariantsWithDescriptions(ctx context.Context, db *sql.DB, workID int64) ([]DLsiteMetadataVariant, error) {
	return listDLsiteMetadataVariants(ctx, db, workID, true)
}

func listDLsiteMetadataVariants(ctx context.Context, db *sql.DB, workID int64, descriptions bool) ([]DLsiteMetadataVariant, error) {
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
	return loadDLsiteMetadataVariants(ctx, db, logicalWorkID, descriptions)
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
	if _, err = tx.ExecContext(ctx, "INSERT INTO app_setting(key,value_json) VALUES ('metadata_projection_pending','true') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json"); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err = metadatatags.RefreshNamesTx(ctx, tx, priorities); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	var frontier int64
	if err := db.QueryRowContext(ctx, "SELECT COALESCE(MAX(id),0) FROM work").Scan(&frontier); err != nil {
		return err
	}
	for cursor := int64(0); cursor < frontier; {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		next, err := projectMetadataBatch(ctx, tx, cursor, frontier, priorities)
		if err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		if next == cursor {
			break
		}
		cursor = next
	}
	final, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = final.Rollback() }()
	if _, err := final.ExecContext(ctx, "INSERT INTO app_setting(key,value_json) VALUES ('metadata_tag_projection_version','1') ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json"); err != nil {
		return err
	}
	if _, err := final.ExecContext(ctx, "DELETE FROM app_setting WHERE key='metadata_projection_pending'"); err != nil {
		return err
	}
	return final.Commit()
}

func projectMetadataBatch(ctx context.Context, tx *sql.Tx, cursor, frontier int64, priorities []string) (int64, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id FROM work WHERE id>? AND id<=? ORDER BY id LIMIT 64", cursor, frontier)
	if err != nil {
		return cursor, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return cursor, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return cursor, err
	}
	if closeErr != nil {
		return cursor, closeErr
	}
	for _, id := range ids {
		if err := ProjectWorkMetadataTagsTx(ctx, tx, id, priorities); err != nil {
			return cursor, err
		}
		cursor = id
	}
	return cursor, nil
}

// BackfillMetadataTags resumes safely after an interrupted start. Completion is
// saved only after every bounded work batch has committed.
func BackfillMetadataTags(ctx context.Context, db *sql.DB, priorities []string) error {
	var done bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM app_setting WHERE key='metadata_tag_projection_version' AND value_json='1') AND NOT EXISTS(SELECT 1 FROM app_setting WHERE key='metadata_projection_pending')").Scan(&done); err != nil {
		return err
	}
	if done {
		return nil
	}
	return ProjectDLsiteMetadata(ctx, db, priorities)
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

func loadDLsiteMetadataVariants(ctx context.Context, queryer metadataVariantQuerier, logicalWorkID int64, descriptions bool) ([]DLsiteMetadataVariant, error) {
	description := "''"
	if descriptions {
		description = "edition_work.description"
	}
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
 `+description+`,
			variant.tags_json,
			variant.content_hash,
			variant.fetched_at,
			COALESCE(edition.is_canonical, 0)
		FROM dlsite_metadata_variant AS variant
		LEFT JOIN work_edition AS edition ON edition.work_id = variant.work_id
 JOIN work AS edition_work ON edition_work.id=variant.work_id
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
			&variant.Description,
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

// chooseDLsiteTagSourceVariant returns the edition whose genres are the
// family's shared tags: the original edition, otherwise the first edition in
// the fixed supported-language order. Language preferences never change it.
func chooseDLsiteTagSourceVariant(variants []DLsiteMetadataVariant) DLsiteMetadataVariant {
	for _, variant := range variants {
		if variant.IsCanonical && strings.TrimSpace(variant.Title) != "" {
			return variant
		}
	}
	return chooseDLsiteMetadataVariant(variants, dlsite.SupportedMetadataLanguages)
}

// SelectDLsiteTagSourceVariant returns the edition whose genres supply the
// shared tags of workID's family; see chooseDLsiteTagSourceVariant.
func SelectDLsiteTagSourceVariant(ctx context.Context, db *sql.DB, workID int64) (DLsiteMetadataVariant, bool, error) {
	variants, err := ListDLsiteMetadataVariants(ctx, db, workID)
	if err != nil {
		return DLsiteMetadataVariant{}, false, err
	}
	selected := chooseDLsiteTagSourceVariant(variants)
	return selected, selected.ID > 0, nil
}

func variantMatchesPriority(variant DLsiteMetadataVariant, priority string) bool {
	if priority == dlsite.OriginMetadataLanguage {
		return variant.IsCanonical
	}
	return dlsite.EditionMetadataLanguage(variant.EditionLanguage) == priority
}

func projectDLsiteMetadataFamilyTx(ctx context.Context, tx *sql.Tx, logicalID int64, priorities []string) error {
	rows, err := tx.QueryContext(ctx, "SELECT work_id FROM work_edition WHERE logical_work_id=? ORDER BY work_id", logicalID)
	if err != nil {
		return err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	for _, id := range ids {
		if err := ProjectWorkMetadataTagsTx(ctx, tx, id, priorities); err != nil {
			return err
		}
	}
	return nil
}

// ProjectWorkMetadataTagsTx composes provider selection and shared-tag changes
// in the caller's transaction, including works without any provider snapshot.
func ProjectWorkMetadataTagsTx(ctx context.Context, tx *sql.Tx, workID int64, priorities []string) error {
	sourceID := workID
	var logicalID int64
	err := tx.QueryRowContext(ctx, "SELECT logical_work_id FROM work_edition WHERE work_id=?", workID).Scan(&logicalID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var legacy []string
	if logicalID > 0 {
		variants, err := loadDLsiteMetadataVariants(ctx, tx, logicalID, false)
		if err != nil {
			return err
		}
		canonicalID, err := canonicalWorkIDTx(ctx, tx, logicalID)
		if err != nil {
			return err
		}
		// The family's shared tags come from a fixed edition, so every viewer
		// sees the same tag set whatever language it prefers. Only the stored
		// work title follows the instance priority.
		selected := DLsiteMetadataVariant{}
		if workID == canonicalID {
			selected = chooseDLsiteTagSourceVariant(variants)
			if title := strings.TrimSpace(chooseDLsiteMetadataVariant(variants, priorities).Title); title != "" {
				if _, err := tx.ExecContext(ctx, "UPDATE work SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND title<>?", title, workID, title); err != nil {
					return err
				}
			}
		} else {
			for _, v := range variants {
				if v.WorkID == workID {
					selected = v
					break
				}
			}
		}
		if selected.WorkID > 0 {
			sourceID = selected.WorkID
			if err := json.Unmarshal([]byte(selected.TagsJSON), &legacy); err != nil {
				return err
			}
		}
	}
	if legacy == nil {
		legacy, err = snapshotTagNamesTx(ctx, tx, sourceID)
		if err != nil {
			return err
		}
	}
	var remoteOnly bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM metadata_snapshot WHERE work_id=?)
 AND NOT EXISTS(SELECT 1 FROM metadata_snapshot AS snapshot JOIN metadata_provider AS provider ON provider.id=snapshot.provider_id WHERE snapshot.work_id=? AND provider.code='dlsite')
 AND NOT EXISTS(SELECT 1 FROM dlsite_metadata_variant WHERE work_id=?)`, sourceID, sourceID, sourceID).Scan(&remoteOnly); err != nil {
		return err
	}
	if remoteOnly && sourceID == workID {
		// A work described only by remote sources follows the configured source
		// order. With the opt-in fallback enabled, the first active source's tags
		// become the shared-tag base; otherwise remote tags keep their snapshot
		// presentation alongside manual additions.
		reconciled, err := remotemetadata.ReconcileWorkTx(ctx, tx, workID)
		if err != nil {
			return err
		}
		if reconciled.TagProviderID > 0 {
			ids, err := metadatatags.ProviderConceptsTx(ctx, tx, reconciled.TagProviderID, reconciled.Tags, priorities)
			if err != nil {
				return err
			}
			if err := metadatatags.ProjectWorkConceptsTx(ctx, tx, workID, ids); err != nil {
				return err
			}
			if err := remotemetadata.RecordFieldTx(ctx, tx, workID, remotemetadata.FieldTags, reconciled.TagProviderID); err != nil {
				return err
			}
			_, err = tx.ExecContext(ctx, "DELETE FROM work_metadata_tag_dirty WHERE work_id=?", workID)
			return err
		}
		if err := remotemetadata.RecordFieldTx(ctx, tx, workID, remotemetadata.FieldTags, 0); err != nil {
			return err
		}
	} else if err := remotemetadata.ClearTx(ctx, tx, workID); err != nil {
		return err
	}
	if legacy == nil && remoteOnly {
		legacy = []string{}
	}
	if legacy == nil {
		rows, err := tx.QueryContext(ctx, "SELECT tag.display_name FROM work_tag INNER JOIN tag ON tag.id=work_tag.tag_id WHERE work_id=? AND work_tag.source='dlsite' AND tag.namespace='dlsite' ORDER BY tag.id", sourceID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				_ = rows.Close()
				return err
			}
			legacy = append(legacy, name)
		}
		err = rows.Err()
		closeErr := rows.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if err := metadatatags.ProjectWorkTx(ctx, tx, workID, sourceID, legacy); err != nil {
		return err
	}
	if remoteOnly {
		// An empty DLsite projection must not suppress the existing remote
		// snapshot presentation before remote fallback is enabled.
		if _, err := tx.ExecContext(ctx, "DELETE FROM work_metadata_tag_projection WHERE work_id=?", workID); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "DELETE FROM work_metadata_tag_dirty WHERE work_id=?", workID)
	return err
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
