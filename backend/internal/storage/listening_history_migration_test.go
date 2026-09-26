package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListeningMigrationPreservesExistingPlayEventsWithoutInventedDuration(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	before := t.TempDir()
	entries, err := os.ReadDir(migrationDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() >= "043_personal_listening_history.sql" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(migrationDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(before, entry.Name()), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	db, err := Open(filepath.Join(t.TempDir(), "history.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if err = Migrate(db, before); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`
	 INSERT INTO user_account (id,username,display_name,role) VALUES (1,'synthetic-user','Example User','user');
	 INSERT INTO work (id,primary_code,title) VALUES (1,'RJ00000000','Example Work'),(2,'RJ00000001','Example Translation');
	 INSERT INTO logical_work (id,canonical_work_id,canonical_code) VALUES (1,1,'RJ00000000');
	 INSERT INTO work_edition (work_id,logical_work_id,primary_code,is_canonical) VALUES (1,1,'RJ00000000',1),(2,1,'RJ00000001',0);
	 INSERT INTO recommendation_event (user_id,work_id,event_type,created_at) VALUES (1,2,'play','2026-01-01 00:00:00'),(1,1,'impression','2026-01-01 00:00:00');
	`)
	if err != nil {
		t.Fatal(err)
	}
	if err = Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`DELETE FROM recommendation_event`); err != nil {
		t.Fatal(err)
	}
	var count, work int
	var seconds float64
	if err = db.QueryRow(`SELECT COUNT(*),MIN(work_id),SUM(listened_seconds) FROM user_listening_session`).Scan(&count, &work, &seconds); err != nil {
		t.Fatal(err)
	}
	if count != 1 || work != 1 || seconds != 0 {
		t.Fatalf("backfill = count %d, work %d, seconds %v", count, work, seconds)
	}
	if err = Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT SUM(listen_count) FROM user_listening_day`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("restart changed history: %d, %v", count, err)
	}
}
