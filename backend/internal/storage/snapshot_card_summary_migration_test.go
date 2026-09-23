package storage

import (
	"path/filepath"
	"testing"
)

// Migration 038 must queue snapshots stored before it so an upgraded server
// builds their card summaries in the background.
func TestSnapshotCardSummaryMigrationQueuesExistingSnapshots(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 37)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO metadata_snapshot (id, work_id, provider_id, external_id, snapshot_json)
		SELECT 7, 1, id, 'RJ00000000', '{"workno":"RJ00000000"}' FROM metadata_provider WHERE code = 'dlsite'`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 38)); err != nil {
		t.Fatal(err)
	}
	var queued, summaries int
	if err := db.QueryRow(`SELECT
		(SELECT COUNT(*) FROM metadata_snapshot_card_summary_dirty WHERE snapshot_id = 7),
		(SELECT COUNT(*) FROM metadata_snapshot_card_summary)`).Scan(&queued, &summaries); err != nil {
		t.Fatal(err)
	}
	if queued != 1 || summaries != 0 {
		t.Fatalf("after migration 038: queued %d, summaries %d; want the existing snapshot queued", queued, summaries)
	}
}
