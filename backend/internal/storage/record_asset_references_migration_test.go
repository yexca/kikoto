package storage

import (
	"path/filepath"
	"strings"
	"testing"
)

// Migration 102 gives every column that references a record file an index,
// so the foreign-key checks of deleting a file never scan a table.
func TestMigrationIndexesEveryRecordFileReference(t *testing.T) {
	db := openMigratedThrough(t, 101)
	if err := Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	for _, lookup := range []string{
		`SELECT 1 FROM record_asset_progress WHERE asset_id = 7`,
		`SELECT 1 FROM record_asset_state WHERE asset_id = 7`,
		`SELECT 1 FROM record_folder WHERE poster_asset_id = 7`,
		`SELECT 1 FROM record_folder WHERE backdrop_asset_id = 7`,
	} {
		rows, err := db.Query(`EXPLAIN QUERY PLAN ` + lookup)
		if err != nil {
			t.Fatal(err)
		}
		plan := []string{}
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
		if joined := strings.Join(plan, "; "); !strings.Contains(joined, "USING INDEX") && !strings.Contains(joined, "USING COVERING INDEX") {
			t.Errorf("%s plans %q, want an index", lookup, joined)
		}
	}
}
