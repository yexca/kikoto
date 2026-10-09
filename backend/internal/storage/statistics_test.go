package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestOptimizeStatisticsAnalyzesTablesFilledAfterTheLastPass(t *testing.T) {
	// A memory database has one connection, so the test also observes the
	// connection-scoped analysis limit after the pass.
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`
		CREATE TABLE item (id INTEGER PRIMARY KEY, kind TEXT NOT NULL);
		CREATE INDEX idx_item_kind ON item(kind);
		WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 500)
		INSERT INTO item (id, kind) SELECT n, 'kind-' || (n % 7) FROM seq;
	`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := OptimizeStatistics(context.Background(), db); err != nil {
		t.Fatalf("OptimizeStatistics() error = %v", err)
	}

	var analyzed int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 'item' AND idx = 'idx_item_kind'`).Scan(&analyzed); err != nil {
		t.Fatalf("read statistics: %v", err)
	}
	if analyzed != 1 {
		t.Fatalf("item index statistics rows = %d, want 1", analyzed)
	}
	var limit int
	if err := db.QueryRow(`PRAGMA analysis_limit`).Scan(&limit); err != nil {
		t.Fatalf("read analysis limit: %v", err)
	}
	if limit != 0 {
		t.Fatalf("analysis_limit after pass = %d, want the connection default 0", limit)
	}
}

func TestOptimizeStatisticsYieldsToWriterAndRestoresConnectionPolicy(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "example.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(2)
	if _, err := db.Exec(`CREATE TABLE item(id INTEGER PRIMARY KEY,kind TEXT); CREATE INDEX idx_item_kind ON item(kind);
		WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<500)
		INSERT INTO item SELECT n,'example' FROM seq`); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	start := time.Now()
	if err := OptimizeStatistics(ctx, db); err == nil {
		t.Fatal("maintenance acquired a held write lock")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("cancelled maintenance took %v", elapsed)
	}
	var timeout, limit int
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if err := conn.QueryRowContext(context.Background(), `PRAGMA busy_timeout`).Scan(&timeout); err != nil {
		t.Fatal(err)
	}
	if err := conn.QueryRowContext(context.Background(), `PRAGMA analysis_limit`).Scan(&limit); err != nil {
		t.Fatal(err)
	}
	if timeout != sqliteBusyTimeoutMillis || limit != 0 {
		t.Fatalf("restored connection policy = %d/%d", timeout, limit)
	}
}
