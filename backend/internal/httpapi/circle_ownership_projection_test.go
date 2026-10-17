package httpapi

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
)

// The persisted primary circles and catalog owners must equal what the
// ownership rules compute from scratch after every kind of write that feeds
// them.
func TestCircleOwnershipProjectionFollowsEveryWrite(t *testing.T) {
	db := openMigratedTestDB(t)
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	steps := circleOwnershipSteps{t: t, db: db}
	exec, wantOwner := steps.exec, steps.wantOwner

	exec("parties", "INSERT INTO party (id, display_name) VALUES (1, 'Origin Circle'), (2, 'Translation Circle'), (3, 'Override Circle'), (4, 'Listing Circle')")
	for partyID := int64(1); partyID <= 4; partyID++ {
		exec("external ids", "INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (?, ?, 'maker_id', ?, 1)", partyID, providerID, fmt.Sprintf("RG0000000%d", partyID))
	}
	exec("catalog before works", "INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title) VALUES (2, ?, 'RJ00000001', 'Translation'), (4, ?, 'RJ00000000', 'Origin'), (4, ?, 'RJ00000005', 'Unknown')", providerID, providerID, providerID)
	wantOwner("catalog before works", "RJ00000000", 4, 4)
	wantOwner("catalog before works", "RJ00000001", 2, 2)

	exec("works", "INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Origin'), (2, 'RJ00000001', 'Translation')")
	exec("origin circle", "INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (1, 1, 'circle', ?, 'dlsite_snapshot')", providerID)
	wantOwner("origin circle", "RJ00000000", 4, 1)
	wantOwner("origin circle", "RJ00000001", 2, 2)

	exec("logical work", "INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000000')")
	exec("origin edition", "INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id) VALUES (1, 1, ?, 'RJ00000000', 'RJ00000000', 1, 'origin', 'RG00000001')", providerID)
	exec("translation edition", "INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id) VALUES (2, 1, ?, 'RJ00000001', 'RJ00000000', 0, 'third_party', 'RG00000002')", providerID)
	wantOwner("translation edition", "RJ00000001", 2, 1)

	exec("manual override", "INSERT INTO work_party (work_id, party_id, role, source) VALUES (1, 3, 'circle', 'manual_override')")
	wantOwner("manual override", "RJ00000000", 4, 3)
	wantOwner("manual override", "RJ00000001", 2, 3)
	exec("override cleared", "DELETE FROM work_party WHERE work_id = 1 AND party_id = 3")
	wantOwner("override cleared", "RJ00000001", 2, 1)

	exec("remote circle", "INSERT INTO work_party (work_id, party_id, role, source) VALUES (1, 3, 'circle', 'remote_source')")
	exec("origin maker changed", "UPDATE work_edition SET maker_id = 'RG00000003' WHERE work_id = 1")
	wantOwner("origin maker changed", "RJ00000001", 2, 3)
	steps.wantPrimary("origin maker changed", 1, 3)
	exec("maker id renamed", "UPDATE party_external_id SET external_id = 'RG00000013' WHERE party_id = 3")
	wantOwner("maker id renamed", "RJ00000001", 2, 1)
	exec("maker id restored", "UPDATE party_external_id SET external_id = 'RG00000003' WHERE party_id = 3")
	wantOwner("maker id restored", "RJ00000001", 2, 3)
	exec("origin maker restored", "UPDATE work_edition SET maker_id = 'RG00000001' WHERE work_id = 1")
	exec("origin external removed", "DELETE FROM party_external_id WHERE party_id = 1")
	exec("origin external restored", "INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (1, ?, 'maker_id', 'RG00000001', 1)", providerID)

	exec("translation circle", "INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (2, 2, 'circle', ?, 'dlsite_snapshot')", providerID)
	exec("canonical moved", "UPDATE logical_work SET canonical_work_id = 2 WHERE id = 1")
	exec("relation source changed", "UPDATE work_party SET source = 'manual_override' WHERE work_id = 2 AND party_id = 2")
	wantOwner("relation source changed", "RJ00000000", 4, 2)
	exec("canonical restored", "UPDATE logical_work SET canonical_work_id = 1 WHERE id = 1")
	wantOwner("canonical restored", "RJ00000000", 4, 1)

	exec("catalog party changed", "UPDATE party_catalog_item SET party_id = 3 WHERE primary_code = 'RJ00000005'")
	exec("catalog code changed", "UPDATE party_catalog_item SET primary_code = 'RJ00000006' WHERE primary_code = 'RJ00000005'")
	wantOwner("catalog code changed", "RJ00000006", 3, 3)
	exec("catalog work appears", "INSERT INTO work (id, primary_code, title) VALUES (6, 'RJ00000006', 'Late')")
	exec("catalog work circle", "INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (6, 4, 'circle', ?, 'dlsite_snapshot')", providerID)
	wantOwner("catalog work circle", "RJ00000006", 3, 4)

	exec("edition left family", "DELETE FROM work_edition WHERE work_id = 2")
	wantOwner("edition left family", "RJ00000001", 2, 2)
	exec("origin work deleted", "DELETE FROM work WHERE id = 1")
	wantOwner("origin work deleted", "RJ00000000", 4, 4)
	exec("party deleted", "DELETE FROM party WHERE id = 4")
	exec("catalog row deleted", "DELETE FROM party_catalog_item WHERE primary_code = 'RJ00000001'")
}

// Each step changes one input that no other maintained row reflects, so every
// trigger has to recompute on its own.
func TestCircleOwnershipProjectionFollowsIsolatedInputs(t *testing.T) {
	db := openMigratedTestDB(t)
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	steps := circleOwnershipSteps{t: t, db: db}
	exec, wantOwner, wantPrimary := steps.exec, steps.wantOwner, steps.wantPrimary

	exec("parties", "INSERT INTO party (id, display_name) VALUES (1, 'Origin Circle'), (2, 'Translation Circle'), (3, 'Maker Circle'), (4, 'Listing Circle'), (5, 'Remote Circle')")
	exec("external ids", "INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (1, ?, 'maker_id', 'RG00000001', 1), (2, ?, 'maker_id', 'RG00000002', 1)", providerID, providerID)
	exec("works", "INSERT INTO work (id, primary_code, title) VALUES (10, 'RJ00000010', 'Origin'), (11, 'RJ00000011', 'Translation'), (12, 'RJ00000012', 'Renamed'), (14, 'RJ00000014', 'Sibling')")
	exec("catalog", "INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title) VALUES (2, ?, 'RJ00000011', 'Translation'), (2, ?, 'RJ00000013', 'Renamed'), (4, ?, 'RJ00000014', 'Sibling')", providerID, providerID, providerID)
	exec("family", "INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (2, 10, 'RJ00000010')")
	exec("translation edition", "INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id) VALUES (11, 2, ?, 'RJ00000011', 'RJ00000010', 0, 'third_party', 'RG00000002')", providerID)
	wantOwner("translation edition", "RJ00000011", 2, 2)

	exec("origin edition", "INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id) VALUES (10, 2, ?, 'RJ00000010', 'RJ00000010', 1, 'origin', 'RG00000001')", providerID)
	wantOwner("origin edition", "RJ00000011", 2, 1)
	exec("origin maker unknown", "UPDATE work_edition SET maker_id = 'RG00000003' WHERE work_id = 10")
	wantOwner("origin maker unknown", "RJ00000011", 2, 2)
	exec("maker id added", "INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (3, ?, 'maker_id', 'RG00000003', 1)", providerID)
	wantOwner("maker id added", "RJ00000011", 2, 3)
	exec("maker id renamed", "UPDATE party_external_id SET external_id = 'RG00000033' WHERE party_id = 3")
	wantOwner("maker id renamed", "RJ00000011", 2, 2)
	exec("maker id restored", "UPDATE party_external_id SET external_id = 'RG00000003' WHERE party_id = 3")
	wantOwner("maker id restored", "RJ00000011", 2, 3)
	exec("maker id removed", "DELETE FROM party_external_id WHERE party_id = 3")
	wantOwner("maker id removed", "RJ00000011", 2, 2)

	exec("listed work circle", "INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (12, 4, 'circle', ?, 'dlsite_snapshot')", providerID)
	wantOwner("listed work circle", "RJ00000013", 2, 2)
	exec("work code renamed", "UPDATE work SET primary_code = 'RJ00000013' WHERE id = 12")
	wantOwner("work code renamed", "RJ00000013", 2, 4)

	exec("own family", "INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (3, 12, 'RJ00000013')")
	exec("own edition", "INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id) VALUES (12, 3, ?, 'RJ00000013', 'RJ00000013', 1, 'origin', 'RG00000005')", providerID)
	exec("remote relation", "INSERT INTO work_party (work_id, party_id, role, source) VALUES (12, 5, 'circle', 'remote_source')")
	wantPrimary("remote relation", 12, 4)
	exec("remote maker id added", "INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (5, ?, 'maker_id', 'RG00000005', 1)", providerID)
	wantPrimary("remote maker id added", 12, 5)
	exec("remote maker id removed", "DELETE FROM party_external_id WHERE party_id = 5")
	wantPrimary("remote maker id removed", 12, 4)

	exec("origin circle", "INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (10, 1, 'circle', ?, 'dlsite_snapshot')", providerID)
	exec("translation circle", "INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (11, 2, 'circle', ?, 'dlsite_snapshot')", providerID)
	wantPrimary("translation circle", 11, 1)
	exec("translation left family", "DELETE FROM work_edition WHERE work_id = 11")
	wantPrimary("translation left family", 11, 2)

	exec("sibling edition", "INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind) VALUES (14, 2, ?, 'RJ00000014', 'RJ00000010', 0, 'official')", providerID)
	exec("sibling override", "INSERT INTO work_party (work_id, party_id, role, source) VALUES (14, 3, 'circle', 'manual_override')")
	wantOwner("sibling override", "RJ00000014", 4, 1)
	exec("sibling became canonical", "UPDATE logical_work SET canonical_work_id = 14 WHERE id = 2")
	wantOwner("sibling became canonical", "RJ00000014", 4, 3)
}

type circleOwnershipSteps struct {
	t  *testing.T
	db *sql.DB
}

// exec runs one write and checks the persisted ownership against the rules.
func (s circleOwnershipSteps) exec(step, statement string, args ...any) {
	s.t.Helper()
	if _, err := s.db.Exec(statement, args...); err != nil {
		s.t.Fatalf("%s: %v", step, err)
	}
	assertCircleOwnershipParity(s.t, s.db, step)
}

func (s circleOwnershipSteps) wantOwner(step, code string, sourcePartyID, want int64) {
	s.t.Helper()
	var owner sql.NullInt64
	if err := s.db.QueryRow("SELECT owner_party_id FROM party_catalog_item WHERE primary_code = ? AND party_id = ?", code, sourcePartyID).Scan(&owner); err != nil {
		s.t.Fatalf("%s: owner of %s: %v", step, code, err)
	}
	if !owner.Valid || owner.Int64 != want {
		s.t.Fatalf("%s: owner of %s listed by party %d = %v, want %d", step, code, sourcePartyID, owner, want)
	}
}

func (s circleOwnershipSteps) wantPrimary(step string, workID, want int64) {
	s.t.Helper()
	var partyID int64
	if err := s.db.QueryRow("SELECT party_id FROM work_primary_circle WHERE work_id = ?", workID).Scan(&partyID); err != nil {
		s.t.Fatalf("%s: primary circle of work %d: %v", step, workID, err)
	}
	if partyID != want {
		s.t.Fatalf("%s: primary circle of work %d = %d, want %d", step, workID, partyID, want)
	}
}

func assertCircleOwnershipParity(t *testing.T, db *sql.DB, step string) {
	t.Helper()
	read := func(query string) string {
		rows, err := db.Query(query)
		if err != nil {
			t.Fatalf("%s: %v", step, err)
		}
		defer func() { _ = rows.Close() }()
		var out strings.Builder
		for rows.Next() {
			var workID, partyID int64
			var role, source string
			if err := rows.Scan(&workID, &partyID, &role, &source); err != nil {
				t.Fatalf("%s: %v", step, err)
			}
			fmt.Fprintf(&out, "%d:%d:%s:%s ", workID, partyID, role, source)
		}
		if err := rows.Err(); err != nil {
			t.Fatalf("%s: %v", step, err)
		}
		return out.String()
	}
	persisted := read("SELECT work_id, party_id, role, source FROM work_primary_circle_projection ORDER BY work_id")
	computed := read("SELECT work_id, party_id, role, source FROM work_primary_circle_ranking ORDER BY work_id")
	if persisted != computed {
		t.Fatalf("%s: primary circles = %q, want %q", step, persisted, computed)
	}
	var mismatches int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM party_catalog_item AS catalog
		INNER JOIN party_catalog_owner_resolution AS resolution ON resolution.catalog_item_id = catalog.id
		WHERE catalog.owner_party_id IS NOT resolution.owner_party_id
	`).Scan(&mismatches); err != nil {
		t.Fatalf("%s: %v", step, err)
	}
	if mismatches != 0 {
		t.Fatalf("%s: %d catalog owners differ from the ownership rules", step, mismatches)
	}
}

// Reading one circle's catalog, and recomputing one work's primary circle,
// must use indexes instead of scanning the library.
func TestCircleOwnershipReadsUseIndexes(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, testCase := range []struct {
		name  string
		query string
		index string
	}{
		{"circle catalog", "SELECT COUNT(*) FROM " + circleCatalogProjection + " AS catalog WHERE catalog.party_id = ?", "idx_party_catalog_item_owner"},
		{"circle works", "SELECT COUNT(*) FROM work_primary_circle WHERE party_id = ?", "idx_work_primary_circle_projection_party"},
		{"primary circle recompute", "SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = ?)", ""},
	} {
		rows, err := db.Query("EXPLAIN QUERY PLAN "+testCase.query, 1)
		if err != nil {
			t.Fatal(err)
		}
		usesIndex := testCase.index == ""
		plan := []string{}
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
			if strings.HasPrefix(detail, "SCAN ") {
				t.Errorf("%s plan scans: %q", testCase.name, detail)
			}
			if testCase.index != "" && strings.Contains(detail, testCase.index) {
				usesIndex = true
			}
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		_ = rows.Close()
		if !usesIndex {
			t.Errorf("%s plan %q does not use %s", testCase.name, plan, testCase.index)
		}
	}
}
