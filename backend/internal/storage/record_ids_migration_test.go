package storage

import (
	"path/filepath"
	"testing"
)

// Migration 101 keeps every record folder, asset, and per-user row under its
// id, and from then on a removed id is never handed out again, even once the
// catalog is empty.
func TestMigrationKeepsRecordIDsAndNeverReusesThem(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 100)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'viewer', 'user')`,
		`INSERT INTO record_folder (id, root_id, parent_id, name, relative_path, path_key, depth) VALUES
			(4, 1, NULL, 'trip', 'trip', 'trip', 0),
			(5, 1, 4, 'day', 'trip/day', 'trip/day', 1)`,
		`INSERT INTO record_asset (id, root_id, folder_id, name, relative_path, path_key, kind, has_audio, has_cover) VALUES
			(7, 1, 5, 'clip.mp4', 'trip/day/clip.mp4', 'trip/day/clip.mp4', 'video', 1, NULL),
			(8, 1, 4, 'song.mp3', 'trip/song.mp3', 'trip/song.mp3', 'audio', 1, 1)`,
		`INSERT INTO record_asset_progress (user_id, asset_id, position_seconds) VALUES (1, 7, 60)`,
		`INSERT INTO record_asset_state (user_id, asset_id, favorite) VALUES (1, 8, 1)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	var parent, folder, hasCover, position, favorite int
	if err := db.QueryRow(`SELECT
		(SELECT parent_id FROM record_folder WHERE id = 5),
		(SELECT folder_id FROM record_asset WHERE id = 7),
		(SELECT has_cover FROM record_asset WHERE id = 8),
		(SELECT position_seconds FROM record_asset_progress WHERE asset_id = 7),
		(SELECT favorite FROM record_asset_state WHERE asset_id = 8)`).Scan(&parent, &folder, &hasCover, &position, &favorite); err != nil {
		t.Fatal(err)
	}
	if parent != 4 || folder != 5 || hasCover != 1 || position != 60 || favorite != 1 {
		t.Fatalf("after the migration: parent %d, folder %d, cover %d, position %d, favorite %d", parent, folder, hasCover, position, favorite)
	}

	// Forgetting the whole catalog keeps the ids it used.
	for _, statement := range []string{`DELETE FROM record_asset`, `DELETE FROM record_folder`} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO record_folder (root_id, name, relative_path, path_key) VALUES (1, 'trip', 'trip', 'trip')`); err != nil {
		t.Fatal(err)
	}
	var folderID int64
	if err := db.QueryRow(`SELECT id FROM record_folder`).Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO record_asset (root_id, folder_id, name, relative_path, path_key, kind) VALUES (1, ?, 'clip.mp4', 'trip/clip.mp4', 'trip/clip.mp4', 'video')`, folderID); err != nil {
		t.Fatal(err)
	}
	var assetID int64
	if err := db.QueryRow(`SELECT id FROM record_asset`).Scan(&assetID); err != nil {
		t.Fatal(err)
	}
	if folderID <= 5 || assetID <= 8 {
		t.Fatalf("new folder id %d and asset id %d reuse ids of the forgotten catalog", folderID, assetID)
	}
}
