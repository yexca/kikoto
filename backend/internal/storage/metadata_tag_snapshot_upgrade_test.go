package storage

import (
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/migrations"
)

func TestSchema050UpgradePreservesWorksAndSnapshots(t *testing.T) {
	source := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, source, 50)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO work(primary_code,title) VALUES ('RJ00000000','Example Work')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT work.id,provider.id,'RJ00000000','{}' FROM work CROSS JOIN metadata_provider AS provider WHERE work.primary_code='RJ00000000' AND provider.code='dlsite'"); err != nil {
		t.Fatal(err)
	}
	if err := MigrateFS(db, migrations.Files, "test"); err != nil {
		t.Fatalf("schema 050 upgrade: %v", err)
	}
	var current, works, snapshots int
	if err := db.QueryRow("SELECT current_version FROM schema_state WHERE id=1").Scan(&current); err != nil || current != latestNumberedMigrationVersion {
		t.Fatalf("upgraded version: %d %v", current, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code='RJ00000000' AND title='Example Work'").Scan(&works); err != nil || works != 1 {
		t.Fatalf("work changed: %d %v", works, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot WHERE work_id IS NOT NULL AND snapshot_json='{}'").Scan(&snapshots); err != nil || snapshots != 1 {
		t.Fatalf("snapshot changed: %d %v", snapshots, err)
	}
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatalf("upgraded delete with snapshot: %v", err)
	}
}
