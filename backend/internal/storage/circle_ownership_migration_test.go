package storage

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// The persisted circle ownership must start out equal to what the views of
// the previous schema computed.
func TestCircleOwnershipMigrationKeepsPrimaryCirclesAndCatalogOwners(t *testing.T) {
	db := openMigrationManagerDB(t)
	sourceDir := filepath.Join("..", "..", "migrations")
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 81)); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	for index, statement := range []string{
		"INSERT INTO party (id, display_name) VALUES (1, 'Origin Circle'), (2, 'Translation Circle'), (3, 'Remote Circle'), (4, 'Override Circle'), (5, 'Local Circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (1, ?1, 'maker_id', 'RG00000001', 1), (2, ?1, 'maker_id', 'RG00000002', 1), (3, ?1, 'maker_id', 'RG00000003', 1), (4, ?1, 'maker_id', 'RG00000004', 1)",
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Origin'), (2, 'RJ00000001', 'Translation'), (3, 'RJ00000002', 'Standalone'), (4, 'RJ00000003', 'Official translation')",
		"INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000000')",
		"INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id) VALUES (1, 1, ?1, 'RJ00000000', 'RJ00000000', 1, 'origin', 'RG00000001'), (2, 1, ?1, 'RJ00000001', 'RJ00000000', 0, 'third_party', 'RG00000002'), (4, 1, ?1, 'RJ00000003', 'RJ00000000', 0, 'official', 'RG00000004')",
		"INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (1, 1, 'circle', ?1, 'dlsite_snapshot'), (2, 2, 'circle', ?1, 'dlsite_snapshot')",
		"INSERT INTO work_party (work_id, party_id, role, source) VALUES (3, 3, 'circle', 'remote_source'), (3, 5, 'circle', 'local_scan'), (4, 4, 'circle', 'manual_override')",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title) VALUES (2, ?1, 'RJ00000001', 'Translation'), (4, ?1, 'RJ00000003', 'Official translation'), (3, ?1, 'RJ00000002', 'Standalone'), (4, ?1, 'RJ00000009', 'Unknown'), (2, ?1, 'RJ00000000', 'Origin')",
	} {
		if _, err := db.Exec(statement, providerID); err != nil {
			t.Fatalf("statement %d: %v", index, err)
		}
	}
	const primaryCircles = "SELECT work_id, party_id, display_name, external_id, role, source FROM work_primary_circle ORDER BY work_id"
	before := readPrimaryCircles(t, db, primaryCircles)
	if strings.Count(before, ":circle:") != 4 {
		t.Fatalf("primary circles before migration = %q, want one per work", before)
	}

	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}
	if after := readPrimaryCircles(t, db, primaryCircles); after != before {
		t.Fatalf("primary circles after migration = %q, want %q", after, before)
	}
	for _, want := range []struct {
		code          string
		sourcePartyID int64
		owner         int64
	}{
		{"RJ00000000", 2, 1},
		{"RJ00000001", 2, 1},
		{"RJ00000003", 4, 1},
		{"RJ00000002", 3, 5},
		{"RJ00000009", 4, 4},
	} {
		var owner sql.NullInt64
		if err := db.QueryRow("SELECT owner_party_id FROM party_catalog_item WHERE primary_code = ? AND party_id = ?", want.code, want.sourcePartyID).Scan(&owner); err != nil {
			t.Fatal(err)
		}
		if !owner.Valid || owner.Int64 != want.owner {
			t.Fatalf("owner of %s listed by party %d = %v, want %d", want.code, want.sourcePartyID, owner, want.owner)
		}
	}
}

func readPrimaryCircles(t *testing.T, db *sqlutil.DB, query string) string {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out strings.Builder
	for rows.Next() {
		var workID, partyID int64
		var displayName, externalID, role, source string
		if err := rows.Scan(&workID, &partyID, &displayName, &externalID, &role, &source); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&out, "%d:%d:%s:%s:%s:%s ", workID, partyID, displayName, externalID, role, source)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out.String()
}
