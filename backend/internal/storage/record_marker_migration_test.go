package storage

import (
	"path/filepath"
	"testing"
)

// Migrations 103 and 104 keep the record catalog: the rebuilt root keeps its
// identity and state, its folders, files, and progress stay, earlier progress
// gives way to any ordered save, and a root can record a missing marker.
func TestRecordMigrationsKeepTheCatalog(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 102)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'example-user', 'user')`,
		`INSERT OR IGNORE INTO record_root (id) VALUES (1)`,
		`UPDATE record_root SET configured_path = '/record', marker_id = 'synthetic-marker', state = 'online' WHERE id = 1`,
		`INSERT INTO record_folder (id, root_id, name, relative_path, path_key) VALUES (1, 1, '', '.', '.')`,
		`INSERT INTO record_asset (id, root_id, folder_id, name, relative_path, path_key, kind) VALUES (1, 1, 1, 'clip.mp4', 'clip.mp4', 'clip.mp4', 'video')`,
		`INSERT INTO record_asset_progress (user_id, asset_id, position_seconds) VALUES (1, 1, 42)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}
	var marker, state string
	var assets int
	var order int64
	var position float64
	if err := db.QueryRow(`SELECT marker_id, state, (SELECT COUNT(*) FROM record_asset WHERE root_id = 1) FROM record_root WHERE id = 1`).Scan(&marker, &state, &assets); err != nil {
		t.Fatal(err)
	}
	if marker != "synthetic-marker" || state != "online" || assets != 1 {
		t.Fatalf("record root after the migrations = %q %q with %d assets", marker, state, assets)
	}
	if err := db.QueryRow(`SELECT position_seconds, report_order FROM record_asset_progress WHERE user_id = 1 AND asset_id = 1`).Scan(&position, &order); err != nil || position != 42 || order != 0 {
		t.Fatalf("progress after the migrations = %v order %d, %v", position, order, err)
	}
	if _, err := db.Exec(`UPDATE record_root SET state = 'marker_missing' WHERE id = 1`); err != nil {
		t.Fatalf("record a missing marker: %v", err)
	}
}
