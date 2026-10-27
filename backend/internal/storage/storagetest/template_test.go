package storagetest

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestTemplateDatabasesRemainIsolated(t *testing.T) {
	first := Open(t)
	if _, err := first.Exec("CREATE TABLE test_isolation_probe (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	second := Open(t)
	var count int
	if err := second.QueryRow("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'test_isolation_probe'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("one test's schema change leaked into another database")
	}
	var journal string
	if err := second.QueryRow("PRAGMA journal_mode").Scan(&journal); err != nil {
		t.Fatal(err)
	}
	var foreignKeys int
	if err := second.QueryRow("PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if journal != "wal" || foreignKeys != 1 {
		t.Fatal("test database must retain production WAL and foreign keys")
	}
	if second.Stats().MaxOpenConnections != 4 {
		t.Fatal("test database must open with the production connection pool")
	}
	// Startup must accept the copied ledger and schema as an already migrated
	// installation.
	if err := storage.Migrate(second, filepath.Join("..", "..", "..", "migrations")); err != nil {
		t.Fatalf("copied migration state is invalid: %v", err)
	}
}

func TestSeededTemplateStartsEachTestFromItsSeed(t *testing.T) {
	template := NewTemplate(func(db *sql.DB) error {
		_, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('library_mode', '"standard"')`)
		return err
	})
	first := template.Open(t)
	if _, err := first.Exec(`UPDATE app_setting SET value_json = '"storage_pool"' WHERE key = 'library_mode'`); err != nil {
		t.Fatal(err)
	}
	second := template.OpenFile(t, filepath.Join(t.TempDir(), "named.db"))
	var mode string
	if err := second.QueryRow(`SELECT value_json FROM app_setting WHERE key = 'library_mode'`).Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != `"standard"` {
		t.Fatalf("library_mode = %s, want the seeded value", mode)
	}
	var settings int
	if err := Open(t).QueryRow(`SELECT COUNT(*) FROM app_setting WHERE key = 'library_mode'`).Scan(&settings); err != nil {
		t.Fatal(err)
	}
	if settings != 0 {
		t.Fatal("a seeded template changed the unseeded schema")
	}
}
