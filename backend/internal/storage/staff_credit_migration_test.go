package storage

import (
	"path/filepath"
	"testing"
)

// Migration 084 adds staff credits: every work's credits are projected again
// while its circle record is kept, every work is indexed again, and a staff
// credit change queues its work for the search index.
func TestStaffCreditMigrationReprojectsCreditsAndReindexesEveryWork(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 83)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`,
		`INSERT INTO work_snapshot_projection (work_id, kind, snapshot_id, version, input_hash) VALUES (1, 'voice_credit', 1, 1, 'recorded'), (1, 'dlsite_party', 1, 1, 'recorded')`,
		`DELETE FROM work_search_dirty`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 84)); err != nil {
		t.Fatal(err)
	}

	count := func(query string) int {
		t.Helper()
		var value int
		if err := db.QueryRow(query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got := count(`SELECT COUNT(*) FROM work_snapshot_projection WHERE kind = 'voice_credit'`); got != 0 {
		t.Fatalf("voice credit records after migration 084 = %d, want 0 so voice credits are projected again", got)
	}
	if got := count(`SELECT COUNT(*) FROM work_snapshot_projection WHERE kind = 'dlsite_party' AND input_hash = 'recorded'`); got != 1 {
		t.Fatalf("circle records after migration 084 = %d, want the recorded one kept", got)
	}
	if got := count(`SELECT COUNT(*) FROM work_search_dirty WHERE work_id = 1`); got != 1 {
		t.Fatalf("work queued for the search index = %d, want 1", got)
	}
	for _, statement := range []string{
		`DELETE FROM work_search_dirty`,
		`INSERT INTO work_snapshot_projection (work_id, kind, snapshot_id, version, input_hash) VALUES (1, 'staff_credit', 1, 1, 'recorded')`,
		`INSERT INTO work_staff_credit (work_id, role, position, name, source) VALUES (1, 'scenario', 0, 'Example Writer', 'metadata_snapshot')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if got := count(`SELECT COUNT(*) FROM work_search_dirty WHERE work_id = 1`); got != 1 {
		t.Fatalf("work queued after a staff credit insert = %d, want 1", got)
	}
	if _, err := db.Exec(`INSERT INTO work_staff_credit (work_id, role, position, name) VALUES (1, 'voice_actor', 1, 'Example Voice')`); err == nil {
		t.Fatal("work_staff_credit accepted the voice_actor role, want only staff roles")
	}
}
