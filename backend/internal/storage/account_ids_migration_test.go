package storage

import (
	"path/filepath"
	"testing"
)

// Migration 099 keeps every account under its id, and from then on an account
// created later never receives the id of a deleted account: neither one
// deleted afterwards nor one deleted before whose workflow runs remain.
func TestMigrationKeepsAccountIDsAndNeverReusesThem(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 98)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'example-admin', 'admin'), (2, 'example-user', 'user')`,
		`INSERT INTO user_session (id, user_id, expires_at) VALUES ('synthetic-session', 2, '2999-01-01 00:00:00')`,
		// Account 5 was deleted before the migration; its run still names it.
		`INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type, input_json) VALUES ('remote_work_fetch', 'Example Fetch', 'succeeded', 'manual', '{"requested_by_user_id":5}')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	var sessions int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_session WHERE user_id = 2`).Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("sessions kept = %d, %v", sessions, err)
	}
	insertAccount := func(username string) int64 {
		t.Helper()
		result, err := db.Exec(`INSERT INTO user_account (username, role) VALUES (?, 'user')`, username)
		if err != nil {
			t.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	if id := insertAccount("example-user-3"); id <= 5 {
		t.Fatalf("new account id %d reuses the id of an account deleted before the migration", id)
	}
	last := insertAccount("example-user-4")
	if _, err := db.Exec(`DELETE FROM user_account WHERE id = ?`, last); err != nil {
		t.Fatal(err)
	}
	if id := insertAccount("example-user-5"); id <= last {
		t.Fatalf("new account id %d reuses the deleted account's id %d", id, last)
	}
}
