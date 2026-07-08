package storage

import (
	"context"
	"database/sql"
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
