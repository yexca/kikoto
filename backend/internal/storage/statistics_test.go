package storage

import (
	"context"
	"testing"
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
