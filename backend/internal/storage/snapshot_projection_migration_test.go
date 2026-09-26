package storage

import (
	"path/filepath"
	"testing"
)

// Migration 041 keeps only the latest circle snapshots and stops rewrites of
// unchanged rows from advancing the recommendation revision.
func TestSnapshotProjectionMigrationPrunesCircleSnapshotsAndIgnoresNoOpUpdates(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 40)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`,
		`INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice 1', 'example voice 1'), (2, 'Example Voice 2', 'example voice 2')`,
		`INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'metadata_snapshot')`,
		`INSERT INTO party (id, party_type, display_name, sort_name) VALUES (1, 'circle', 'Example Circle', 'example circle')`,
		`INSERT INTO party_metadata_snapshot (id, party_id, provider_id, external_id, snapshot_json, fetched_at)
			SELECT value, 1, provider.id, 'RG00000000', '{"n":' || value || '}', '2000-01-0' || value || ' 00:00:00'
			FROM json_each('[1,2,3,4]'), metadata_provider AS provider
			WHERE provider.code = 'dlsite'`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 41)); err != nil {
		t.Fatal(err)
	}

	var kept string
	if err := db.QueryRow(`SELECT group_concat(id, ',') FROM (SELECT id FROM party_metadata_snapshot ORDER BY id)`).Scan(&kept); err != nil {
		t.Fatal(err)
	}
	if kept != "3,4" {
		t.Fatalf("circle snapshots after migration 041 = %s, want the latest two 3,4", kept)
	}

	revision := func() int {
		t.Helper()
		var value int
		if err := db.QueryRow(`SELECT revision FROM recommendation_input_revision WHERE id = 1`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := revision()
	if _, err := db.Exec(`UPDATE work_credit SET updated_at = '2001-01-01 00:00:00', source = 'dlsite_product' WHERE work_id = 1`); err != nil {
		t.Fatal(err)
	}
	if got := revision(); got != before {
		t.Fatalf("revision after provenance-only credit update = %d, want %d", got, before)
	}
	if _, err := db.Exec(`UPDATE work_credit SET person_id = 2 WHERE work_id = 1`); err != nil {
		t.Fatal(err)
	}
	if got := revision(); got != before+1 {
		t.Fatalf("revision after credited person changed = %d, want %d", got, before+1)
	}
}
