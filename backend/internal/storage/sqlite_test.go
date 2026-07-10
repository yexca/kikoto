package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
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

	tagSQL, err := os.ReadFile(filepath.Join(migrationDir, "002_normalized_work_tags.sql"))
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
