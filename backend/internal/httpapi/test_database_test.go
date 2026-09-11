package httpapi

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

// Build the real packaged schema once, then give every test its own writable
// file and normal production connection pool. No database or WAL is shared.
var migratedTestDatabaseImage = sync.OnceValues(func() ([]byte, error) {
	dir, err := os.MkdirTemp("", "kikoto-test-schema-")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	path := filepath.Join(dir, "schema.db")
	db, err := storage.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		return nil, err
	}
	var busy, logPages, checkpointed int
	if err := db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logPages, &checkpointed); err != nil {
		return nil, err
	}
	if busy != 0 {
		return nil, fmt.Errorf("test schema checkpoint remained busy")
	}
	if err := db.Close(); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
})

func openMigratedTestDB(t *testing.T) *sql.DB {
	t.Helper()
	image, err := migratedTestDatabaseImage()
	if err != nil {
		t.Fatalf("prepare test database: %v", err)
	}
	path := filepath.Join(t.TempDir(), "test.db")
	if err := os.WriteFile(path, image, 0o600); err != nil {
		t.Fatalf("copy test database: %v", err)
	}
	db, err := storage.Open(path)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestMigratedTestDatabasesRemainIsolated(t *testing.T) {
	first := openMigratedTestDB(t)
	if _, err := first.Exec("CREATE TABLE test_isolation_probe (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	second := openMigratedTestDB(t)
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
	if journal != "wal" || foreignKeys != 1 || second.Stats().MaxOpenConnections != 4 {
		t.Fatal("test database must retain production WAL, foreign keys and connection pool")
	}
	// Startup must still accept the copied ledger and schema as an already
	// migrated installation. Migration-chain tests continue to build their own DBs.
	if err := storage.Migrate(second, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatalf("copied migration state is invalid: %v", err)
	}
}
