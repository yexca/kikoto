package storage

import (
	"path/filepath"
	"testing"
)

// Migration 096 makes Availability Watch monitor only: a stored Track or
// Fetch action becomes monitor, the action accepts nothing else, the stored
// extension exclusion is dropped, and the pool keeps its targets with an
// available target ready whatever was started for it.
func TestMigrationMakesAvailabilityWatchMonitorOnly(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 95)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watcher', 'admin')`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`,
		`INSERT INTO availability_watch (id, configured_by_user_id, action, source_id, exclude_extensions_json, revision)
			VALUES (1, 1, 'track_fetch', 1, '["wav"]', 4)`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state) VALUES
			(1, 1, 'RJ00000001', 'completed'),
			(2, 1, 'RJ00000002', 'monitoring'),
			(3, 1, 'RJ00000003', 'error')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	var action string
	var sourceID, revision int
	if err := db.QueryRow(`SELECT action, source_id, revision FROM availability_watch WHERE id = 1`).Scan(&action, &sourceID, &revision); err != nil {
		t.Fatal(err)
	}
	if action != "monitor" || sourceID != 1 || revision != 4 {
		t.Fatalf("watch = action %q, source %d, revision %d", action, sourceID, revision)
	}
	if _, err := db.Exec(`UPDATE availability_watch SET action = 'fetch' WHERE id = 1`); err == nil {
		t.Fatal("availability_watch accepted a fetch action")
	}
	var excludeColumns int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('availability_watch') WHERE name = 'exclude_extensions_json'`).Scan(&excludeColumns); err != nil {
		t.Fatal(err)
	}
	if excludeColumns != 0 {
		t.Fatal("availability_watch still stores an extension exclusion")
	}

	rows, err := db.Query(`SELECT work_code, state FROM availability_watch_target WHERE watch_id = 1 ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	got := map[string]string{}
	for rows.Next() {
		var code, state string
		if err := rows.Scan(&code, &state); err != nil {
			t.Fatal(err)
		}
		got[code] = state
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"RJ00000001": "ready", "RJ00000002": "monitoring", "RJ00000003": "error"}
	if len(got) != len(want) {
		t.Fatalf("targets = %v", got)
	}
	for code, state := range want {
		if got[code] != state {
			t.Fatalf("targets = %v, want %v", got, want)
		}
	}
}
