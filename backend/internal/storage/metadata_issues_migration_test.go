package storage

import (
	"path/filepath"
	"testing"
)

func TestMetadataIssuesMigrationPreservesUnavailableAndExistingMetadata(t *testing.T) {
	source := filepath.Join("..", "..", "migrations")
	before := copyNumberedMigrationsThrough(t, source, 32)
	db := openMigrationManagerDB(t)
	if err := Migrate(db, before); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work(id,primary_code,title) VALUES (1,'RJ00000000','Retained local metadata');
 INSERT INTO work_metadata_provider_state(work_id,provider_id,status,message,checked_at)
 SELECT 1,id,'not_found','protected legacy diagnostic','2026-01-01 00:00:00' FROM metadata_provider WHERE code='dlsite';`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, source); err != nil {
		t.Fatal(err)
	}
	var status, checked, title string
	var count int
	if err := db.QueryRow(`SELECT state.status,state.checked_at,work.title,state.failure_count FROM work_metadata_sync_state AS state JOIN work ON work.id=state.work_id WHERE work.id=1`).Scan(&status, &checked, &title, &count); err != nil {
		t.Fatal(err)
	}
	if status != "unavailable" || checked != "2026-01-01 00:00:00" || title != "Retained local metadata" || count != 1 {
		t.Fatalf("migrated issue=%s %s %s %d", status, checked, title, count)
	}
	if err := Migrate(db, source); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_sync_state").Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate state=%d %v", count, err)
	}
}
