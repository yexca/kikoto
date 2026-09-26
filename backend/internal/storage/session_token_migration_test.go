package storage

import (
	"path/filepath"
	"testing"
)

// Migration 040 removes sessions stored as plaintext tokens before lookups
// switch to token digests, so no usable credential stays at rest.
func TestMigrationRemovesPlaintextSessions(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 39)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, display_name, role) VALUES (101, 'synthetic-listener', 'Listener', 'user')`,
		`INSERT INTO user_session (id, user_id, expires_at) VALUES ('synthetic-plaintext-token', 101, '2999-01-01 00:00:00')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}
	var sessions, accounts int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_session").Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM user_account WHERE id = 101").Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 || accounts != 1 {
		t.Fatalf("after migration: sessions %d, accounts %d; want 0 and 1", sessions, accounts)
	}
}
