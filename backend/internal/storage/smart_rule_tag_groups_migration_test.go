package storage

import (
	"path/filepath"
	"testing"
)

// Migration 080 moves the all-or-any switch of a smart list rule onto its
// conditions: an "all" rule's included tags become required tags, an "any"
// rule's become the any group, and excluded tags stay excluded.
func TestMigrationSortsSmartRuleTagsIntoGroups(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 79)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'collector', 'admin')`,
		`INSERT INTO favorite_list (id, user_id, name, kind) VALUES (10, 1, 'Example All', 'smart'), (11, 1, 'Example Any', 'smart')`,
		`INSERT INTO favorite_list_smart_rule (list_id, include_match) VALUES (10, 'all'), (11, 'any')`,
		`INSERT INTO favorite_list_smart_tag (list_id, tag_kind, tag_id, mode) VALUES
			(10, 'metadata', 101, 'include'), (10, 'user', 7, 'include'), (10, 'metadata', 102, 'exclude'),
			(11, 'metadata', 101, 'include'), (11, 'metadata', 103, 'include'), (11, 'user', 8, 'exclude')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	rows, err := db.Query("SELECT list_id, tag_kind, tag_id, mode FROM favorite_list_smart_tag ORDER BY list_id, rowid")
	if err != nil {
		t.Fatal(err)
	}
	type condition struct {
		listID int64
		kind   string
		tagID  int64
		mode   string
	}
	got := []condition{}
	for rows.Next() {
		var item condition
		if err := rows.Scan(&item.listID, &item.kind, &item.tagID, &item.mode); err != nil {
			t.Fatal(err)
		}
		got = append(got, item)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	want := []condition{
		{10, "metadata", 101, "require"},
		{10, "user", 7, "require"},
		{10, "metadata", 102, "exclude"},
		{11, "metadata", 101, "any"},
		{11, "metadata", 103, "any"},
		{11, "user", 8, "exclude"},
	}
	if len(got) != len(want) {
		t.Fatalf("conditions = %+v, want %+v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("conditions = %+v, want %+v", got, want)
		}
	}
	var ruleTables int
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'favorite_list_smart_rule'").Scan(&ruleTables); err != nil {
		t.Fatal(err)
	}
	if ruleTables != 0 {
		t.Fatal("favorite_list_smart_rule should be dropped")
	}
	if _, err := db.Exec("INSERT INTO favorite_list_smart_tag (list_id, tag_kind, tag_id, mode) VALUES (10, 'metadata', 104, 'include')"); err == nil {
		t.Fatal("the include mode should be refused")
	}
}
