package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOpenEnablesForeignKeysOnEveryConnection(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		CREATE TABLE parent (
			id INTEGER PRIMARY KEY
		);
		CREATE TABLE child (
			id INTEGER PRIMARY KEY,
			parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE
		);
	`); err != nil {
		t.Fatalf("create tables: %v", err)
	}

	ctx := context.Background()
	conns := make([]*sql.Conn, 4)
	for i := range conns {
		conn, err := db.Conn(ctx)
		if err != nil {
			t.Fatalf("Conn(%d) error = %v", i, err)
		}
		conns[i] = conn
		defer conn.Close()
	}

	for i, conn := range conns {
		var enabled int
		if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil {
			t.Fatalf("PRAGMA foreign_keys on connection %d: %v", i, err)
		}
		if enabled != 1 {
			t.Fatalf("PRAGMA foreign_keys on connection %d = %d, want 1", i, enabled)
		}
		if _, err := conn.ExecContext(ctx, "INSERT INTO child (parent_id) VALUES (?)", 404); err == nil {
			t.Fatalf("connection %d allowed invalid foreign key insert", i)
		}
	}
}

func TestOpenSerializesImmediateWriteTransactions(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "transactions.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE values_for_test (id INTEGER PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	first, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Exec("INSERT INTO values_for_test (value) VALUES ('first')"); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		second, err := db.BeginTx(context.Background(), nil)
		if err == nil {
			_, err = second.Exec("INSERT INTO values_for_test (value) VALUES ('second')")
			if err == nil {
				err = second.Commit()
			} else {
				_ = second.Rollback()
			}
		}
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("second transaction finished before the first committed: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := first.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("second transaction did not resume after commit: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second transaction remained blocked")
	}
}

func TestOpenMemoryDatabase(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open(:memory:) error = %v", err)
	}
	defer db.Close()

	var enabled int
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&enabled); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if enabled != 1 {
		t.Fatalf("PRAGMA foreign_keys = %d, want 1", enabled)
	}
}

func TestNormalizedTagMigrationBackfillsEscapedUnicodeSnapshots(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	migrationDir := filepath.Join("..", "..", "migrations")
	initialSQL, err := os.ReadFile(filepath.Join(migrationDir, "001_initial.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(initialSQL)); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999998', 'Migration test')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	snapshot := `{"product":{"genres":[{"name":"\u30ed\u30ea"},{"name":"\u8033\u304b\u304d"}]},"_kikoto":{"language":"ja_JP"}}`
	if _, err := db.Exec("INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, 'RJ09999998', ?)", workID, providerID, snapshot); err != nil {
		t.Fatal(err)
	}

	tagSQL, err := os.ReadFile(filepath.Join(migrationDir, "002_v0_1_1.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(tagSQL)); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE work_tag.work_id = ? AND tag.display_name IN ('ロリ', '耳かき')
	`, workID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("normalized Unicode tags = %d, want 2", count)
	}
}

func TestMigrateUpgradesV010DatabaseWithSingleV011Migration(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	initialSQL, err := os.ReadFile(filepath.Join(migrationDir, "001_initial.sql"))
	if err != nil {
		t.Fatal(err)
	}
	v010Dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(v010Dir, "001_initial.sql"), initialSQL, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := Open(filepath.Join(t.TempDir(), "v0.1.0.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db, v010Dir); err != nil {
		t.Fatalf("create v0.1.0 database: %v", err)
	}
	if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999997', 'Preserved')"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("upgrade v0.1.0 database: %v", err)
	}
	rows, err := db.Query("SELECT filename FROM schema_migration ORDER BY filename")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var migrations []string
	for rows.Next() {
		var filename string
		if err := rows.Scan(&filename); err != nil {
			t.Fatal(err)
		}
		migrations = append(migrations, filename)
	}
	if len(migrations) != 2 || migrations[0] != "001_initial.sql" || migrations[1] != "002_v0_1_1.sql" {
		t.Fatalf("migrations = %v", migrations)
	}
	for table, column := range map[string]string{
		"work_edition":               "translation_kind",
		"workflow_job":               "checkpoint_json",
		"remote_fetch_manifest_item": "resolution",
	} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?", table, column).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("column %s.%s count = %d", table, column, count)
		}
	}
	var preserved int
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = 'RJ09999997'").Scan(&preserved); err != nil {
		t.Fatal(err)
	}
	if preserved != 1 {
		t.Fatalf("preserved work count = %d", preserved)
	}
}

func TestMigrateAddsQueryIndexes(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "indexed.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	for table, index := range map[string]string{
		"metadata_snapshot": "idx_metadata_snapshot_work_provider_latest",
		"work":              "idx_work_primary_code_upper",
		"work_edition":      "idx_work_edition_primary_code_upper",
		"party_series_work": "idx_party_series_work_code_upper",
	} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM pragma_index_list(?) WHERE name = ?", table, index).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("index %s on %s count = %d, want 1", index, table, count)
		}
	}
}
