package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestDLsitePartyProjectionPrefersProductMakerIdentity(t *testing.T) {
	raw := `{"product":{"maker_id":"RG900001","circle_id":"RG900002","maker_name":"Synthetic Maker"}}`
	party := parsePartyFromDLsiteSnapshot(raw)
	metadata := parseDLsiteSnapshot(raw)
	if party.ExternalID != "RG900001" || metadata.CircleExternalID != "RG900001" {
		t.Fatalf("party identity = %q, detail identity = %q", party.ExternalID, metadata.CircleExternalID)
	}
}

func TestDLsitePartyProjectionSkipsUnchangedSnapshots(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`); err != nil {
		t.Fatal(err)
	}
	raw := `{"product":{"workno":"RJ00000000","maker_id":"RG000000","maker_name":"Example Circle"}}`
	if _, err := db.Exec(`
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (1, ?, 'RJ00000000', ?)
	`, providerID, raw); err != nil {
		t.Fatal(err)
	}
	server := &Server{db: db}
	if err := server.syncPartiesFromDLsiteSnapshots(ctx); err != nil {
		t.Fatal(err)
	}

	const sentinel = "2001-02-03 04:05:06"
	if _, err := db.Exec(`
		UPDATE party SET updated_at = ? WHERE display_name = 'Example Circle';
		UPDATE party_catalog_item SET last_seen_at = ? WHERE primary_code = 'RJ00000000';
		UPDATE work_party SET updated_at = ? WHERE work_id = 1;
	`, sentinel, sentinel, sentinel); err != nil {
		t.Fatal(err)
	}
	if err := server.syncPartiesFromDLsiteSnapshots(ctx); err != nil {
		t.Fatal(err)
	}

	var partyUpdatedAt, catalogLastSeenAt, relationUpdatedAt string
	if err := db.QueryRow(`
		SELECT party.updated_at, catalog.last_seen_at, relation.updated_at
		FROM party_catalog_item AS catalog
		INNER JOIN party ON party.id = catalog.party_id
		INNER JOIN work_party AS relation ON relation.party_id = party.id AND relation.work_id = 1
		WHERE catalog.primary_code = 'RJ00000000'
	`).Scan(&partyUpdatedAt, &catalogLastSeenAt, &relationUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if partyUpdatedAt != sentinel || catalogLastSeenAt != sentinel || relationUpdatedAt != sentinel {
		t.Fatalf("unchanged projection timestamps = %q/%q/%q, want sentinel", partyUpdatedAt, catalogLastSeenAt, relationUpdatedAt)
	}
	blocker, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	readCtx, cancelRead := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancelRead()
	if err := server.syncPartiesFromDLsiteSnapshots(readCtx); err != nil {
		_ = blocker.Rollback()
		t.Fatalf("unchanged projection waited for the active writer: %v", err)
	}
	if err := blocker.Rollback(); err != nil {
		t.Fatal(err)
	}

	if _, err := db.Exec(`UPDATE party_catalog_item SET title = 'Stale title' WHERE primary_code = 'RJ00000000'`); err != nil {
		t.Fatal(err)
	}
	if err := server.syncPartiesFromDLsiteSnapshots(ctx); err != nil {
		t.Fatal(err)
	}
	var title string
	if err := db.QueryRow(`SELECT title FROM party_catalog_item WHERE primary_code = 'RJ00000000'`).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Example Work" {
		t.Fatalf("repaired catalog title = %q, want Example Work", title)
	}
}

func TestUpsertRemoteWorkDoesNotOverrideAuthoritativeMetadataOrCircle(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO work (id, primary_code, title, release_date, age_rating) VALUES (9101, 'RJ00000001', 'Authoritative title', '2025-01-02', 'general')`,
		`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (9201, 9101, 'RJ00000001')`,
		`INSERT INTO party (id, display_name) VALUES (9301, 'Origin Studio'), (9302, 'Remote Translation Studio')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, is_canonical, translation_kind, maker_id, origin_maker_id)
		VALUES (9101, 9201, ?, 'RJ00000001', 1, 'origin', 'RG900091', 'RG900091')
	`, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (9101, ?, 'RJ00000001', '{"product":{"workno":"RJ00000001","maker_id":"RG900091","maker_name":"Origin Studio"}}')
	`, providerID); err != nil {
		t.Fatal(err)
	}
	for _, identity := range []struct {
		partyID    int64
		externalID string
	}{
		{partyID: 9301, externalID: "RG900091"},
		{partyID: 9302, externalID: "RG900092"},
	} {
		if _, err := db.Exec(`
			INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
			VALUES (?, ?, 'maker_id', ?, 1)
		`, identity.partyID, providerID, identity.externalID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO work_party (work_id, party_id, role, provider_id, source)
		VALUES (9101, 9301, 'circle', ?, 'dlsite_snapshot')
	`, providerID); err != nil {
		t.Fatal(err)
	}
	remoteSourceID := insertSyntheticRemoteSource(t, db, "remote-provenance-a")
	remoteWork := kikoeru.Work{
		ID:                501,
		SourceID:          "RJ00000001",
		Title:             "Remote fallback title",
		Release:           "2026-03-04",
		AgeCategoryString: "adult",
		Circle:            &kikoeru.Circle{ID: 77, Name: "Remote Translation Studio"},
	}
	raw, err := json.Marshal(remoteWork)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := upsertRemoteWork(ctx, tx, remoteSourceForUse{
		ID: remoteSourceID, Code: "remote-provenance-a", DisplayName: "Synthetic remote A",
	}, remoteWork, raw, true); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	var title, releaseDate, ageRating string
	if err := db.QueryRow("SELECT title, release_date, age_rating FROM work WHERE id = 9101").Scan(&title, &releaseDate, &ageRating); err != nil {
		t.Fatal(err)
	}
	if title != "Authoritative title" || releaseDate != "2025-01-02" || ageRating != "general" {
		t.Fatalf("normalized metadata = %q, %q, %q", title, releaseDate, ageRating)
	}
	var remoteCircleLinks int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_party WHERE work_id = 9101 AND source = 'remote_source'").Scan(&remoteCircleLinks); err != nil {
		t.Fatal(err)
	}
	if remoteCircleLinks != 0 {
		t.Fatalf("remote circle fallback links = %d, want 0", remoteCircleLinks)
	}
	var projectedExternalID string
	if err := db.QueryRow("SELECT external_id FROM work_primary_circle WHERE work_id = 9101").Scan(&projectedExternalID); err != nil {
		t.Fatal(err)
	}
	if projectedExternalID != "RG900091" {
		t.Fatalf("projected circle = %q, want origin maker", projectedExternalID)
	}
}

func TestUpsertRemoteWorkRefreshesFallbackMetadataAndIgnoresUnrelatedManualOverrideForCircle(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	statements := []string{
		`INSERT INTO work (id, primary_code, title, release_date, age_rating, duration_seconds) VALUES (9351, 'RJ00000002', 'Local seed title', '2024-01-01', 'general', 30)`,
		`INSERT INTO party (id, display_name) VALUES (9352, 'Fallback Studio')`,
		`INSERT INTO work_manual_override (work_id, field_name, value_json) VALUES (9351, 'cover', '"manual-cover.jpg"')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	remoteSourceID := insertSyntheticRemoteSource(t, db, "remote-provenance-refresh")
	firstDuration := 60.0
	secondDuration := 90.0
	versions := []kikoeru.Work{
		{
			ID: 511, SourceID: "RJ00000002", Title: "Remote fallback v1", Release: "2025-02-03",
			AgeCategoryString: "adult", Duration: &firstDuration,
			Circle: &kikoeru.Circle{ID: 91, Name: "Fallback Studio"},
		},
		{
			ID: 511, SourceID: "RJ00000002", Title: "Remote fallback v2", Release: "2026-03-04",
			AgeCategoryString: "adult-only", Duration: &secondDuration,
			Circle: &kikoeru.Circle{ID: 91, Name: "Fallback Studio"},
		},
	}
	for _, remoteWork := range versions {
		raw, err := json.Marshal(remoteWork)
		if err != nil {
			t.Fatal(err)
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := upsertRemoteWork(ctx, tx, remoteSourceForUse{
			ID: remoteSourceID, Code: "remote-provenance-refresh", DisplayName: "Synthetic refresh source",
		}, remoteWork, raw, true); err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}

	var title, releaseDate, ageRating string
	var duration int64
	if err := db.QueryRow(`
		SELECT title, release_date, age_rating, duration_seconds
		FROM work
		WHERE id = 9351
	`).Scan(&title, &releaseDate, &ageRating, &duration); err != nil {
		t.Fatal(err)
	}
	if title != "Remote fallback v2" || releaseDate != "2026-03-04" || ageRating != "adult-only" || duration != 90 {
		t.Fatalf("refreshed fallback metadata = %q/%q/%q/%d", title, releaseDate, ageRating, duration)
	}
	var fallbackCircleLinks int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_party
		WHERE work_id = 9351 AND party_id = 9352 AND role = 'circle' AND source = 'remote_source'
	`).Scan(&fallbackCircleLinks); err != nil {
		t.Fatal(err)
	}
	if fallbackCircleLinks != 1 {
		t.Fatalf("remote circle fallback links = %d, want 1 despite unrelated manual override", fallbackCircleLinks)
	}
}

func TestRemoteCatalogKeepsUnknownWorkAsCatalogProvenanceOnly(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO party (id, display_name) VALUES (9401, 'Catalog Studio')`); err != nil {
		t.Fatal(err)
	}
	remoteSourceID := insertSyntheticRemoteSource(t, db, "remote-provenance-b")
	var providerID int64
	if _, err := db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('kikoeru_source_remote-provenance-b', 'Synthetic remote B')`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'kikoeru_source_remote-provenance-b'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	server := &Server{db: db}
	remoteWork := kikoeru.Work{
		ID: 502, SourceID: "RJ00000003", Title: "Catalog-only work",
		Circle: &kikoeru.Circle{ID: 88, Name: "Catalog Studio"},
	}
	if err := server.upsertRemoteSourceCatalogWork(ctx, 9401, providerID, remoteSourceForUse{
		ID: remoteSourceID, Code: "remote-provenance-b", DisplayName: "Synthetic remote B",
	}, remoteWork); err != nil {
		t.Fatal(err)
	}
	var catalogRows, workRows, ownerLinks, presenceRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM party_catalog_item WHERE party_id = 9401 AND primary_code = 'RJ00000003'").Scan(&catalogRows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = 'RJ00000003'").Scan(&workRows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_party AS relation
		INNER JOIN work ON work.id = relation.work_id
		WHERE work.primary_code = 'RJ00000003' AND relation.party_id = 9401
	`).Scan(&ownerLinks); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE work.primary_code = 'RJ00000003' AND presence.file_source_id = ? AND presence.availability = 'available'
	`, remoteSourceID).Scan(&presenceRows); err != nil {
		t.Fatal(err)
	}
	if catalogRows != 1 || workRows != 0 || ownerLinks != 0 || presenceRows != 0 {
		t.Fatalf("catalog rows = %d, work rows = %d, owner links = %d, presence rows = %d", catalogRows, workRows, ownerLinks, presenceRows)
	}
}

func TestRemoteCatalogAddsPresenceForAlreadyMaterializedWork(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	statements := []string{
		`INSERT INTO party (id, display_name) VALUES (9451, 'Catalog Studio')`,
		`INSERT INTO work (id, primary_code, title) VALUES (9452, 'RJ00000004', 'Known work')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	remoteSourceID := insertSyntheticRemoteSource(t, db, "remote-provenance-known")
	if _, err := db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('kikoeru_source_remote-provenance-known', 'Synthetic remote known')`); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'kikoeru_source_remote-provenance-known'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	server := &Server{db: db}
	remoteWork := kikoeru.Work{
		ID: 503, SourceID: "RJ00000004", Title: "Catalog title must not overwrite known work",
		Circle: &kikoeru.Circle{ID: 92, Name: "Catalog Studio"},
	}
	if err := server.upsertRemoteSourceCatalogWork(ctx, 9451, providerID, remoteSourceForUse{
		ID: remoteSourceID, Code: "remote-provenance-known", DisplayName: "Synthetic remote known",
	}, remoteWork); err != nil {
		t.Fatal(err)
	}
	var title string
	var catalogRows, ownerLinks, presenceRows, remoteSnapshots int
	if err := db.QueryRow("SELECT title FROM work WHERE id = 9452").Scan(&title); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM party_catalog_item WHERE party_id = 9451 AND primary_code = 'RJ00000004'").Scan(&catalogRows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_party WHERE work_id = 9452").Scan(&ownerLinks); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_source_presence WHERE work_id = 9452 AND file_source_id = ? AND availability = 'available'", remoteSourceID).Scan(&presenceRows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot WHERE work_id = 9452 AND provider_id = ?", providerID).Scan(&remoteSnapshots); err != nil {
		t.Fatal(err)
	}
	if title != "Known work" || catalogRows != 1 || ownerLinks != 0 || presenceRows != 1 || remoteSnapshots != 0 {
		t.Fatalf("known catalog projection = title %q, catalog %d, owners %d, presence %d, remote snapshots %d", title, catalogRows, ownerLinks, presenceRows, remoteSnapshots)
	}
}

func TestAuthoritativeTranslationPartyUsesEditionRole(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO work (id, primary_code, title) VALUES (9501, 'RJ00000005', 'Origin'), (9502, 'RJ00000006', 'Translated edition')`,
		`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (9601, 9501, 'RJ00000005')`,
		`INSERT INTO party (id, display_name) VALUES (9701, 'Origin Studio'), (9702, 'Translation Studio')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, is_canonical, translation_kind, maker_id, origin_maker_id)
		VALUES
			(9501, 9601, ?, 'RJ00000005', 1, 'origin', 'RG900095', 'RG900095'),
			(9502, 9601, ?, 'RJ00000006', 0, 'third_party', 'RG900096', 'RG900095')
	`, providerID, providerID); err != nil {
		t.Fatal(err)
	}
	for _, identity := range []struct {
		partyID    int64
		externalID string
	}{
		{partyID: 9701, externalID: "RG900095"},
		{partyID: 9702, externalID: "RG900096"},
	} {
		if _, err := db.Exec(`INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (?, ?, 'maker_id', ?, 1)`, identity.partyID, providerID, identity.externalID); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{db: db}
	if err := server.upsertAuthoritativeWorkParty(ctx, 9501, 9701, "dlsite_snapshot"); err != nil {
		t.Fatal(err)
	}
	if err := server.upsertAuthoritativeWorkParty(ctx, 9502, 9702, "dlsite_snapshot"); err != nil {
		t.Fatal(err)
	}
	var translationRole, familyCircle string
	if err := db.QueryRow("SELECT role FROM work_party WHERE work_id = 9502 AND party_id = 9702").Scan(&translationRole); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT external_id FROM work_primary_circle WHERE work_id = 9502").Scan(&familyCircle); err != nil {
		t.Fatal(err)
	}
	if translationRole != "translator_circle" || familyCircle != "RG900095" {
		t.Fatalf("translation role = %q, family circle = %q", translationRole, familyCircle)
	}
}

func insertSyntheticRemoteSource(t *testing.T, db *sql.DB, code string) int64 {
	t.Helper()
	result, err := db.Exec(`
		INSERT INTO file_source (code, display_name, source_type, enabled)
		VALUES (?, ?, 'kikoeru_compatible', 1)
	`, code, "Synthetic "+code)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
