package storage

import (
	"path/filepath"
	"testing"
)

// Migration 066 rebuilds user_account to accept the contributor role. The
// rebuild must not cascade into the rows that reference an account, and the
// pool must keep enforcing foreign keys afterwards.
func TestContributorRoleMigrationKeepsAccountsAndReferences(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 65)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, display_name, role, ui_locale) VALUES (101, 'synthetic-listener', 'Listener', 'user', 'ja')`,
		`INSERT INTO user_account (id, username, display_name, role) VALUES (102, 'synthetic-admin', 'Admin', 'admin')`,
		`INSERT INTO user_session (id, user_id, expires_at) VALUES ('synthetic-session-key', 101, '2999-01-01 00:00:00')`,
		`INSERT INTO favorite_list (id, user_id, name) VALUES (201, 101, 'Synthetic list')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	var role, locale string
	if err := db.QueryRow(`SELECT role, ui_locale FROM user_account WHERE id = 101`).Scan(&role, &locale); err != nil {
		t.Fatal(err)
	}
	if role != "user" || locale != "ja" {
		t.Fatalf("account 101 = %s/%s, want user/ja", role, locale)
	}
	var sessions, lists int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_session WHERE user_id = 101`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM favorite_list WHERE user_id = 101`).Scan(&lists); err != nil {
		t.Fatal(err)
	}
	if sessions != 1 || lists != 1 {
		t.Fatalf("after migration: sessions %d, lists %d; want 1 and 1", sessions, lists)
	}

	if _, err := db.Exec(`UPDATE user_account SET role = 'contributor' WHERE id = 101`); err != nil {
		t.Fatalf("contributor role rejected: %v", err)
	}
	if _, err := db.Exec(`UPDATE user_account SET role = 'synthetic-role' WHERE id = 101`); err == nil {
		t.Fatal("unknown role accepted")
	}
	if _, err := db.Exec(`INSERT INTO favorite_list (user_id, name) VALUES (999, 'Orphan')`); err == nil {
		t.Fatal("foreign key enforcement is off after migration")
	}
	if _, err := db.Exec(`DELETE FROM user_account WHERE id = 101`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM favorite_list WHERE user_id = 101`).Scan(&lists); err != nil {
		t.Fatal(err)
	}
	if lists != 0 {
		t.Fatalf("deleting an account left %d lists; references no longer cascade", lists)
	}
}
