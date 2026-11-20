package storage

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func personTriggers(t *testing.T, db *sqlutil.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'person' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	return names
}

// Migration 105 keeps every person under its id with its credits, ids, and
// triggers, and from then on two people may share a display name.
func TestPersonNamesMigrationAllowsNamesakes(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 104)
	for _, statement := range []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000018', 'Example Work')`,
		`INSERT INTO person (id, display_name, sort_name) VALUES (7, 'Example Voice', 'example voice')`,
		`INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 7, 'voice_actor', 'metadata_snapshot')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	before := personTriggers(t, db)
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}
	if after := personTriggers(t, db); !slices.Equal(before, after) {
		t.Fatalf("person triggers after the rebuild = %v, want %v", after, before)
	}
	var credited int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_credit WHERE person_id = 7`).Scan(&credited); err != nil || credited != 1 {
		t.Fatalf("credits of the kept person = %d, %v", credited, err)
	}
	if _, err := db.Exec(`INSERT INTO person (display_name, sort_name) VALUES ('Example Voice', 'example voice')`); err != nil {
		t.Fatalf("a namesake person was refused: %v", err)
	}
}
