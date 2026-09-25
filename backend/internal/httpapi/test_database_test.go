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
// file. No database or WAL is shared.
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

// openMigratedTestDB limits the pool to one connection. A request path that
// keeps a cursor or transaction open while issuing another query needs a
// second pooled connection; in production, a few such concurrent requests can
// exhaust the pool and wait on each other indefinitely. With one connection the
// same path blocks deterministically, so a test hanging in
// database/sql.(*DB).conn points at a query issued before the prior one closed.
func openMigratedTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db := openMigratedTestDBWithProductionPool(t)
	db.SetMaxOpenConns(1)
	return db
}

// openMigratedTestDBWithProductionPool keeps the production connection pool
// for tests that deliberately exercise concurrent connections, such as a
// reader proceeding while another connection holds the write lock.
func openMigratedTestDBWithProductionPool(t *testing.T) *sql.DB {
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
	if journal != "wal" || foreignKeys != 1 {
		t.Fatal("test database must retain production WAL and foreign keys")
	}
	if second.Stats().MaxOpenConnections != 1 {
		t.Fatal("test database must use one connection to expose nested pool acquisition")
	}
	if production := openMigratedTestDBWithProductionPool(t); production.Stats().MaxOpenConnections != 4 {
		t.Fatal("production-pool test database must retain the production connection pool")
	}
	// Startup must still accept the copied ledger and schema as an already
	// migrated installation. Migration-chain tests continue to build their own DBs.
	if err := storage.Migrate(second, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatalf("copied migration state is invalid: %v", err)
	}
}
