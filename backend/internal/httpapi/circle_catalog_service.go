package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Circle catalog persistence owns party identity, catalog rows, and
// authoritative work-to-circle relations.

type dlsitePartySnapshotProjection struct {
	WorkID     int64
	ProviderID int64
	Code       string
	Title      string
	Release    sql.NullString
	Raw        string
}

// writeDLsitePartyProjection writes one work's circle, catalog row, and
// authoritative circle relation from its latest DLsite snapshot.
func (s *Server) writeDLsitePartyProjection(ctx context.Context, snapshot dlsitePartySnapshotProjection, party parsedParty) error {
	partyID, err := s.upsertDLsiteParty(ctx, party.ExternalID, party.DisplayName, snapshot.Raw)
	if err != nil {
		return err
	}
	if err := s.upsertPartyCatalogItem(ctx, partyID, snapshot.Code, snapshot.Title, nullableStringValue(snapshot.Release), s.dlsiteURL(snapshot.Code), "imported", snapshot.Raw); err != nil {
		return err
	}
	return s.upsertAuthoritativeWorkParty(ctx, snapshot.WorkID, partyID, "dlsite_snapshot")
}

func (s *Server) dlsitePartyProjectionCurrent(
	ctx context.Context,
	snapshot dlsitePartySnapshotProjection,
	party parsedParty,
) (bool, error) {
	var partyID int64
	var partyMatches, snapshotMatches, catalogMatches int
	err := s.db.QueryRowContext(ctx, `
		SELECT
			party.id,
			CASE WHEN party.display_name = ? AND party.sort_name = ? THEN 1 ELSE 0 END,
			EXISTS (
				SELECT 1
				FROM party_metadata_snapshot AS party_snapshot
				WHERE party_snapshot.party_id = party.id
					AND party_snapshot.provider_id = external.provider_id
					AND party_snapshot.external_id = external.external_id
					AND party_snapshot.snapshot_json <> '{}'
			),
			EXISTS (
				SELECT 1
				FROM party_catalog_item AS catalog
				WHERE catalog.party_id = party.id
					AND catalog.provider_id = external.provider_id
					AND catalog.primary_code = ?
					AND catalog.title = ?
					AND catalog.release_date IS ?
					AND catalog.url = ?
					AND catalog.catalog_status = 'imported'
					AND catalog.dlsite_available = 1
					AND catalog.raw_json = ?
			)
		FROM party_external_id AS external
		INNER JOIN party ON party.id = external.party_id
		WHERE external.provider_id = ?
			AND external.id_type = 'maker_id'
			AND external.external_id = ?
	`, party.DisplayName, strings.ToLower(party.DisplayName),
		strings.ToUpper(strings.TrimSpace(snapshot.Code)), snapshot.Title, nullableStringValue(snapshot.Release),
		s.dlsiteURL(snapshot.Code), snapshot.Raw, snapshot.ProviderID, party.ExternalID,
	).Scan(&partyID, &partyMatches, &snapshotMatches, &catalogMatches)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if partyMatches == 0 || snapshotMatches == 0 || catalogMatches == 0 {
		return false, nil
	}

	var relationMatches int
	if err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM work_party AS relation
			WHERE relation.work_id = ?
				AND relation.party_id = ?
				AND relation.role IN ('circle', 'translator_circle', 'official_translation_brand')
				AND (
					relation.source = 'manual_override'
					OR (relation.provider_id = ? AND relation.source = 'dlsite_snapshot')
				)
		)
	`, snapshot.WorkID, partyID, snapshot.ProviderID).Scan(&relationMatches); err != nil {
		return false, err
	}
	return relationMatches != 0, nil
}

type parsedParty struct {
	ExternalID  string
	DisplayName string
}

func parsePartyFromDLsiteSnapshot(raw string) parsedParty {
	if strings.TrimSpace(raw) == "" {
		return parsedParty{}
	}
	rawBytes := []byte(raw)
	var combined struct {
		Product json.RawMessage `json:"product"`
	}
	if err := json.Unmarshal(rawBytes, &combined); err == nil && len(combined.Product) > 0 {
		rawBytes = combined.Product
	}
	var payload struct {
		MakerID   string `json:"maker_id"`
		MakerName string `json:"maker_name"`
		CircleID  string `json:"circle_id"`
		BrandID   string `json:"brand_id"`
		LabelID   string `json:"label_id"`
		LabelName string `json:"label_name"`
	}
	if err := json.Unmarshal(rawBytes, &payload); err != nil {
		return parsedParty{}
	}
	externalID := firstNonEmpty(payload.MakerID, payload.CircleID, payload.BrandID, payload.LabelID)
	displayName := firstNonEmpty(payload.MakerName, payload.LabelName, externalID)
	return parsedParty{ExternalID: normalizeMakerID(externalID), DisplayName: strings.TrimSpace(displayName)}
}

func (s *Server) upsertDLsiteParty(ctx context.Context, externalID string, displayName string, raw string) (int64, error) {
	externalID = normalizeMakerID(externalID)
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return 0, err
	}
	var existingPartyID int64
	err = s.db.QueryRowContext(ctx, `
		SELECT party_id
		FROM party_external_id
		WHERE provider_id = ? AND id_type = 'maker_id' AND external_id = ?
	`, providerID, externalID).Scan(&existingPartyID)
	if err == nil {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return 0, err
		}
		defer func() { _ = tx.Rollback() }()
		if err := renameParty(ctx, tx, existingPartyID, displayName); err != nil {
			return 0, err
		}
		if err := insertPartyMetadataSnapshot(ctx, tx, existingPartyID, providerID, externalID, raw); err != nil {
			return 0, err
		}
		return existingPartyID, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO party (party_type, display_name, sort_name,provider_name)
		VALUES ('circle', ?, ?,?)
	`, displayName, strings.ToLower(displayName), displayName); err != nil {
		return 0, err
	}
	partyID, err := lastInsertID(tx)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, url, is_primary)
		VALUES (?, ?, 'maker_id', ?, ?, 1)
		ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
			party_id = excluded.party_id,
			url = excluded.url,
			is_primary = excluded.is_primary
	`, partyID, providerID, externalID, s.dlsiteMakerURL(externalID)); err != nil {
		return 0, err
	}
	if err := insertPartyMetadataSnapshot(ctx, tx, partyID, providerID, externalID, raw); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return partyID, nil
}

func (s *Server) upsertPartyCatalogItem(ctx context.Context, partyID int64, code string, title string, releaseDate *string, url string, status string, raw string) error {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	return s.upsertPartyCatalogItemForProvider(ctx, partyID, providerID, code, title, releaseDate, url, status, raw, true)
}

func (s *Server) upsertPartyCatalogItemForProvider(ctx context.Context, partyID int64, providerID int64, code string, title string, releaseDate *string, url string, status string, raw string, dlsiteAvailable bool) error {
	available := 0
	if dlsiteAvailable {
		available = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date, url, catalog_status, dlsite_available, raw_json, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(party_id, provider_id, primary_code) DO UPDATE SET
			title = excluded.title,
			release_date = excluded.release_date,
			url = excluded.url,
			catalog_status = excluded.catalog_status,
			dlsite_available = excluded.dlsite_available,
			raw_json = excluded.raw_json,
			last_seen_at = CURRENT_TIMESTAMP
	`, partyID, providerID, strings.ToUpper(strings.TrimSpace(code)), title, releaseDate, url, status, available, raw)
	return err
}

type authoritativePartyRelation struct {
	PartyID int64
	Role    string
}

func (s *Server) authoritativeDLsitePartyRelations(ctx context.Context, workID, currentPartyID int64) ([]authoritativePartyRelation, error) {
	var isCanonical int
	var translationKind, makerID, originMakerID string
	err := s.db.QueryRowContext(ctx, `
		SELECT is_canonical, translation_kind, maker_id, origin_maker_id
		FROM work_edition
		WHERE work_id = ?
	`, workID).Scan(&isCanonical, &translationKind, &makerID, &originMakerID)
	if errors.Is(err, sql.ErrNoRows) {
		return []authoritativePartyRelation{{PartyID: currentPartyID, Role: "circle"}}, nil
	}
	if err != nil {
		return nil, err
	}
	if isCanonical != 0 {
		return []authoritativePartyRelation{{PartyID: currentPartyID, Role: "circle"}}, nil
	}

	makerID = normalizeMakerID(makerID)
	originMakerID = normalizeMakerID(originMakerID)
	if originMakerID != "" && !strings.EqualFold(originMakerID, makerID) {
		var providerID int64
		err := s.db.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID)
		if errors.Is(err, sql.ErrNoRows) {
			providerID, err = s.metadataProviderID(ctx, "dlsite", "DLsite")
		}
		if err != nil {
			return nil, err
		}
		var originPartyID int64
		err = s.db.QueryRowContext(ctx, `
			SELECT party_id
			FROM party_external_id
			WHERE provider_id = ? AND id_type = 'maker_id' AND UPPER(external_id) = UPPER(?)
		`, providerID, originMakerID).Scan(&originPartyID)
		if errors.Is(err, sql.ErrNoRows) && dlsiteMakerIDPattern.MatchString(originMakerID) {
			originPartyID, err = s.ensurePlaceholderCircle(ctx, originMakerID)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if originPartyID > 0 && originPartyID != currentPartyID {
			return []authoritativePartyRelation{
				{PartyID: originPartyID, Role: "circle"},
				{PartyID: currentPartyID, Role: "translator_circle"},
			}, nil
		}
	}

	role := "translator_circle"
	if strings.EqualFold(strings.TrimSpace(translationKind), "official") ||
		(originMakerID != "" && strings.EqualFold(makerID, originMakerID)) {
		role = "official_translation_brand"
	}
	return []authoritativePartyRelation{{PartyID: currentPartyID, Role: role}}, nil
}

func (s *Server) upsertAuthoritativeWorkParty(ctx context.Context, workID int64, partyID int64, source string) error {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	relations, err := s.authoritativeDLsitePartyRelations(ctx, workID, partyID)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Only relations that are no longer authoritative are deleted. Deleting
	// and reinserting an unchanged relation would advance the recommendation
	// revision for a projection that changed nothing.
	staleQuery := `
		DELETE FROM work_party
		WHERE work_id = ?
			AND role IN ('circle', 'translator_circle', 'official_translation_brand')
			AND source IN ('dlsite_snapshot', 'dlsite_product', 'dlsite_edition', 'remote_source', 'circle_refresh', 'remote_source_catalog')
	`
	staleArgs := []any{workID}
	kept := []string{}
	for _, relation := range relations {
		if relation.PartyID > 0 && relation.Role != "" {
			kept = append(kept, "(party_id = ? AND role = ?)")
			staleArgs = append(staleArgs, relation.PartyID, relation.Role)
		}
	}
	if len(kept) > 0 {
		staleQuery += " AND NOT (" + strings.Join(kept, " OR ") + ")"
	}
	if _, err := tx.ExecContext(ctx, staleQuery, staleArgs...); err != nil {
		return err
	}
	for _, relation := range relations {
		if relation.PartyID <= 0 || relation.Role == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
			VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(work_id, party_id, role) DO UPDATE SET
				provider_id = excluded.provider_id,
				source = excluded.source,
				updated_at = CURRENT_TIMESTAMP
			WHERE work_party.source <> 'manual_override'
				AND (work_party.provider_id IS NOT excluded.provider_id OR work_party.source <> excluded.source)
		`, workID, relation.PartyID, relation.Role, providerID, strings.TrimSpace(source)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// reconcileDLsiteCircleOwnership repairs the circle relations of workIDs,
// including relations that lack the translation-aware projection. It is
// deliberately driven by the persisted edition maker ids, never
// by catalog display names.
func (s *Server) reconcileDLsiteCircleOwnership(ctx context.Context, workIDs []int64) error {
	if len(workIDs) == 0 {
		return nil
	}
	var providerID int64
	err := s.db.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	type workParty struct{ workID, partyID int64 }
	pairs := []workParty{}
	if err := s.queryInt64Batches(ctx, `
		SELECT DISTINCT edition.work_id, external.party_id
		FROM work_edition AS edition
		INNER JOIN party_external_id AS external
			ON external.provider_id = ?
			AND external.id_type = 'maker_id'
			AND UPPER(external.external_id) = UPPER(edition.maker_id)
		WHERE edition.maker_id <> ''
			AND edition.work_id IN (%s)
	`, workIDs, []any{providerID}, func(rows *sql.Rows) error {
		var pair workParty
		if err := rows.Scan(&pair.workID, &pair.partyID); err != nil {
			return err
		}
		pairs = append(pairs, pair)
		return nil
	}); err != nil {
		return err
	}
	for _, pair := range pairs {
		needsRepair, err := s.dlsiteCircleOwnershipNeedsRepair(ctx, pair.workID, pair.partyID, providerID)
		if err != nil {
			return err
		}
		if !needsRepair {
			continue
		}
		if err := s.upsertAuthoritativeWorkParty(ctx, pair.workID, pair.partyID, "dlsite_edition"); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) dlsiteCircleOwnershipNeedsRepair(ctx context.Context, workID, partyID, providerID int64) (bool, error) {
	relations, err := s.authoritativeDLsitePartyRelations(ctx, workID, partyID)
	if err != nil {
		return false, err
	}
	want := map[string]bool{}
	for _, relation := range relations {
		want[fmt.Sprintf("%d:%s", relation.PartyID, relation.Role)] = true
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT party_id, role, provider_id, source
		FROM work_party
		WHERE work_id = ?
			AND role IN ('circle', 'translator_circle', 'official_translation_brand')
			AND source IN ('dlsite_snapshot', 'dlsite_product', 'dlsite_edition', 'remote_source', 'circle_refresh', 'remote_source_catalog')
	`, workID)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	seen := map[string]bool{}
	for rows.Next() {
		var relationPartyID int64
		var relationProviderID sql.NullInt64
		var role, source string
		if err := rows.Scan(&relationPartyID, &role, &relationProviderID, &source); err != nil {
			return false, err
		}
		key := fmt.Sprintf("%d:%s", relationPartyID, role)
		if !want[key] || !relationProviderID.Valid || relationProviderID.Int64 != providerID ||
			(source != "dlsite_snapshot" && source != "dlsite_product" && source != "dlsite_edition") {
			return true, nil
		}
		seen[key] = true
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	if len(seen) != len(want) {
		return true, nil
	}
	for key := range want {
		if !seen[key] {
			return true, nil
		}
	}
	return false, nil
}

// findCircle resolves a known circle without creating one. It returns
// sql.ErrNoRows when the maker id is not in this site's database.
func (s *Server) findCircle(ctx context.Context, externalID string) (int64, error) {
	var partyID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT external.party_id
		FROM party_external_id AS external
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		WHERE provider.code = 'dlsite' AND external.id_type = 'maker_id' AND external.external_id = ?
	`, externalID).Scan(&partyID)
	return partyID, err
}

// writeCircleLookupError reports an unknown maker id with a distinct code so
// the page can offer a fetch to users who may run one.
// ensurePlaceholderCircle creates an unfetched circle for a metadata fetch.
// Only metadata:sync paths may call it; reads and per-user state use findCircle.
func (s *Server) ensurePlaceholderCircle(ctx context.Context, externalID string) (int64, error) {
	if s.cfg.IsDemo() {
		return s.findCircle(ctx, externalID)
	}
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return 0, err
	}
	var partyID int64
	err = s.db.QueryRowContext(ctx, `
		SELECT party_id
		FROM party_external_id
		WHERE provider_id = ? AND id_type = 'maker_id' AND external_id = ?
	`, providerID, externalID).Scan(&partyID)
	if err == nil {
		return partyID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	return s.upsertDLsiteParty(ctx, externalID, "Unfetched circle "+externalID, "{}")
}

// discardUnfetchedCircle removes a placeholder whose first fetch failed, so a
// mistyped or nonexistent maker id does not linger in the circle list. A
// circle that gained a name, catalog, relation, or any user state is kept.
func (s *Server) discardUnfetchedCircle(ctx context.Context, partyID int64) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	var unfetched bool
	if err := tx.QueryRowContext(ctx, `
		SELECT
			party.display_name = 'Unfetched circle ' || external.external_id
			AND NOT EXISTS (SELECT 1 FROM party_catalog_item WHERE party_id = party.id)
			AND NOT EXISTS (SELECT 1 FROM party_series WHERE party_id = party.id)
			AND NOT EXISTS (SELECT 1 FROM work_party WHERE party_id = party.id)
			AND NOT EXISTS (SELECT 1 FROM user_party_state WHERE party_id = party.id)
			AND NOT EXISTS (SELECT 1 FROM user_party_tag_assignment WHERE party_id = party.id)
			AND NOT EXISTS (
				SELECT 1 FROM party_catalog_refresh_state
				WHERE party_id = party.id AND last_success_at IS NOT NULL
			)
			AND NOT EXISTS (
				SELECT 1 FROM party_metadata_snapshot
				WHERE party_id = party.id AND snapshot_json <> '{}'
			)
		FROM party
		INNER JOIN party_external_id AS external ON external.party_id = party.id AND external.id_type = 'maker_id'
		WHERE party.id = ?
	`, partyID).Scan(&unfetched); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if !unfetched {
		return false, nil
	}
	// Snapshots only detach on delete, so the placeholder's empty one goes first.
	if _, err := tx.ExecContext(ctx, "DELETE FROM party_metadata_snapshot WHERE party_id = ?", partyID); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM party WHERE id = ?", partyID); err != nil {
		return false, err
	}
	return true, tx.Commit()
}
