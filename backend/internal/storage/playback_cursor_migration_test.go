package storage

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestPlaybackCursorMigrationBackfillsLatestCanonicalFamilyProgress(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	preCursorDir := t.TempDir()
	entries, err := os.ReadDir(migrationDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() >= "022_user_work_playback_cursor.sql" {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(migrationDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(preCursorDir, entry.Name()), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	db, err := Open(filepath.Join(t.TempDir(), "playback-cursor.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db, preCursorDir); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (801, 'cursor-user', 'Cursor User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(811, 'RJ09999811', 'Canonical work'),
			(812, 'RJ09999812', 'Translated work'),
			(813, 'RJ09999813', 'Standalone work');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (821, 811, 'RJ09999811');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, is_canonical) VALUES
			(811, 821, 'RJ09999811', 1),
			(812, 821, 'RJ09999812', 0);
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(831, 811, 'audio', 'Older canonical track', 'cursor-older'),
			(832, 812, 'audio', 'Latest translated track', 'cursor-latest'),
			(833, 813, 'audio', 'Standalone track', 'cursor-standalone');
		INSERT INTO user_media_progress (
			user_id, media_item_id, position_seconds, duration_seconds, completed, last_played_at, updated_at
		) VALUES
			(801, 831, 10, 100, 0, '2026-07-01 10:00:00', '2026-07-01 10:00:00'),
			(801, 832, 100, 100, 1, '2026-07-02 10:00:00', '2026-07-02 10:00:00'),
			(801, 833, 30, 90, 0, '2026-07-03 10:00:00', '2026-07-03 10:00:00');
	`); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_work_playback_cursor WHERE user_id = 801").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("cursor rows = %d, want one logical family plus one standalone work", count)
	}
	var mediaItemID int64
	var position float64
	var completed bool
	var fileSourceID, locationID sql.NullInt64
	if err := db.QueryRow(`
		SELECT media_item_id, file_source_id, location_id, position_seconds, completed
		FROM user_work_playback_cursor
		WHERE user_id = 801 AND work_id = 811
	`).Scan(&mediaItemID, &fileSourceID, &locationID, &position, &completed); err != nil {
		t.Fatal(err)
	}
	if mediaItemID != 832 || fileSourceID.Valid || locationID.Valid || position != 100 || !completed {
		t.Fatalf("canonical cursor = media %d, source %v, location %v, position %v, completed %t", mediaItemID, fileSourceID, locationID, position, completed)
	}
}
