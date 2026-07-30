package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWorkPartyProvenanceMigrationRepairsCatalogOwnership(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	preRepairDir := t.TempDir()
	entries, err := os.ReadDir(migrationDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() >= "021_reconcile_work_party_provenance.sql" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(migrationDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(preRepairDir, entry.Name()), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	db, err := Open(filepath.Join(t.TempDir(), "party-provenance.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db, preRepairDir); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO work (id, primary_code, title) VALUES
			(8101, 'RJ90008101', 'Synthetic origin'),
			(8102, 'RJ90008102', 'Synthetic translation'),
			(8103, 'RJ90008103', 'Synthetic translation without party projection'),
			(8110, 'RJ90008110', 'Synthetic origin without maker metadata'),
			(8111, 'RJ90008111', 'Synthetic translation with preserved origin evidence')`,
		`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (8201, 8101, 'RJ90008101')`,
		`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (8210, 8110, 'RJ90008110')`,
		`INSERT INTO party (id, display_name) VALUES
			(8301, 'Synthetic Origin Studio'),
			(8302, 'Synthetic Catalog Studio'),
			(8304, 'Synthetic Manual Studio')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (
			work_id, logical_work_id, provider_id, primary_code, is_canonical,
			translation_kind, classification_source, maker_id, origin_maker_id
		) VALUES
			(8101, 8201, ?, 'RJ90008101', 1, 'origin', 'canonical', 'RG900081', 'RG900081'),
			(8102, 8201, ?, 'RJ90008102', 0, 'third_party', 'maker_mismatch', 'RG900082', 'RG900081'),
			(8103, 8201, ?, 'RJ90008103', 0, 'third_party', 'maker_mismatch', 'RG900083', 'RG900081')
	`, providerID, providerID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (
			work_id, logical_work_id, provider_id, primary_code, is_canonical,
			translation_kind, classification_source, maker_id, origin_maker_id
		) VALUES
			(8110, 8210, ?, 'RJ90008110', 1, 'origin', 'canonical', '', ''),
			(8111, 8210, ?, 'RJ90008111', 0, 'third_party', 'maker_mismatch', 'RG900085', 'RG900086')
	`, providerID, providerID); err != nil {
		t.Fatal(err)
	}
	for _, identity := range []struct {
		partyID    int64
		externalID string
	}{
		{partyID: 8301, externalID: "RG900081"},
		{partyID: 8302, externalID: "RG900082"},
		{partyID: 8304, externalID: "RG900084"},
	} {
		if _, err := db.Exec(`
			INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
			VALUES (?, ?, 'maker_id', ?, 1)
		`, identity.partyID, providerID, identity.externalID); err != nil {
			t.Fatal(err)
		}
	}
	for _, snapshot := range []struct {
		workID int64
		code   string
		raw    string
	}{
		{workID: 8101, code: "RJ90008101", raw: `{"product":{"workno":"RJ90008101","maker_id":"RG900081","maker_name":"Synthetic Origin Studio"}}`},
		{workID: 8102, code: "RJ90008102", raw: `{"product":{"workno":"RJ90008102","maker_id":"RG900082","maker_name":"Synthetic Catalog Studio"}}`},
		{workID: 8103, code: "RJ90008103", raw: `{"product":{"workno":"RJ90008103","maker_id":"RG900083","maker_name":"Synthetic Third Studio"}}`},
	} {
		if _, err := db.Exec(`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, ?, ?)`, snapshot.workID, providerID, snapshot.code, snapshot.raw); err != nil {
			t.Fatal(err)
		}
	}
	for _, relation := range []struct {
		workID int64
		party  int64
		source string
	}{
		{workID: 8101, party: 8301, source: "dlsite_snapshot"},
		{workID: 8101, party: 8302, source: "circle_refresh"},
		{workID: 8102, party: 8302, source: "dlsite_snapshot"},
		{workID: 8103, party: 8302, source: "remote_source_catalog"},
		{workID: 8102, party: 8304, source: "manual_override"},
	} {
		if _, err := db.Exec(`INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (?, ?, 'circle', ?, ?)`, relation.workID, relation.party, providerID, relation.source); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, catalog_status)
		VALUES (8302, ?, 'RJ90008101', 'Catalog provenance', 'catalog')
	`, providerID); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}
	var invalidRelations, catalogRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_party WHERE source IN ('circle_refresh', 'remote_source_catalog')").Scan(&invalidRelations); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM party_catalog_item WHERE party_id = 8302 AND primary_code = 'RJ90008101'").Scan(&catalogRows); err != nil {
		t.Fatal(err)
	}
	if invalidRelations != 0 || catalogRows != 1 {
		t.Fatalf("invalid relations = %d, preserved catalog rows = %d", invalidRelations, catalogRows)
	}
	for _, workID := range []int64{8101, 8103} {
		var externalID string
		if err := db.QueryRow("SELECT external_id FROM work_primary_circle WHERE work_id = ?", workID).Scan(&externalID); err != nil {
			t.Fatal(err)
		}
		if externalID != "RG900081" {
			t.Fatalf("work %d projected circle = %q, want family origin", workID, externalID)
		}
	}
	var preservedOriginMakerID string
	if err := db.QueryRow("SELECT origin_maker_id FROM work_edition WHERE work_id = 8111").Scan(&preservedOriginMakerID); err != nil {
		t.Fatal(err)
	}
	if preservedOriginMakerID != "RG900086" {
		t.Fatalf("preserved origin maker id = %q, want RG900086", preservedOriginMakerID)
	}
	for _, expected := range []struct {
		workID     int64
		externalID string
	}{
		{workID: 8102, externalID: "RG900082"},
		{workID: 8103, externalID: "RG900083"},
	} {
		var role string
		if err := db.QueryRow(`
			SELECT relation.role
			FROM work_party AS relation
			INNER JOIN party_external_id AS external ON external.party_id = relation.party_id
			WHERE relation.work_id = ? AND external.provider_id = ? AND external.external_id = ?
		`, expected.workID, providerID, expected.externalID).Scan(&role); err != nil {
			t.Fatal(err)
		}
		if role != "translator_circle" {
			t.Fatalf("work %d party role = %q", expected.workID, role)
		}
	}

	// An edition-specific manual Hero override from the pre-migration database
	// remains above the repaired family origin.
	var manualExternalID string
	if err := db.QueryRow("SELECT external_id FROM work_primary_circle WHERE work_id = 8102").Scan(&manualExternalID); err != nil {
		t.Fatal(err)
	}
	if manualExternalID != "RG900084" {
		t.Fatalf("manual projected circle = %q", manualExternalID)
	}
}
