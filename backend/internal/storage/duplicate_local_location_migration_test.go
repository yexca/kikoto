package storage

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// Migration 100 leaves one local location per work, file source, and path. A
// Fetch recorded the path on remote items and a scan recorded it again on a
// local item: the oldest remote item keeps the fresher location and the local
// fingerprint, the other items are removed, and of their per-user state and
// names the most recent entry wins. An item that still has another location
// keeps it, and a playback cursor follows the location it names.
func TestMigrationMergesDuplicateLocalLocations(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 99)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'listener', 'admin')`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES
			(1, 'local', 'Local', 'local_folder', 1),
			(2, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1),
			(3, 'example_remote_b', 'Example Remote B', 'kikoeru_compatible', 1)`,
		`INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000000', 'Example Work 0'),
			(2, 'RJ00000001', 'Example Work 1'),
			(3, 'RJ00000002', 'Example Work 2')`,
		`INSERT INTO media_item (id, work_id, parent_id, kind, title, track_no, file_version, fingerprint) VALUES
			(9, 1, NULL, 'folder', 'Disc', 1, '', 'remote:2:RJ00000000:Disc'),
			(10, 1, 9, 'audio', 'track.mp3', 1, '', 'remote:2:RJ00000000:Disc/track.mp3'),
			(11, 1, NULL, 'audio', 'track', 1, '100:1', 'local:RJ00000000:Disc/track.mp3'),
			(12, 1, NULL, 'audio', 'track.mp3', 1, '', 'remote:3:RJ00000000:Disc/track.mp3'),
			(20, 2, NULL, 'audio', 'track', 1, '100:1', 'local:RJ00000001:track.mp3'),
			(30, 3, NULL, 'audio', 'track.mp3', 1, '', 'remote:2:RJ00000002:track.mp3'),
			(31, 3, NULL, 'audio', 'track', 1, '100:1', 'local:RJ00000002:track.mp3')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, file_version, duration_seconds, availability, last_checked_at) VALUES
			(100, 10, 1, 'local', 'Library/RJ00000000/Disc/track.mp3', '', NULL, 'available', '2026-01-01 00:00:00'),
			(101, 11, 1, 'local', 'Library/RJ00000000/Disc/track.mp3', '100:1', 60, 'available', '2026-01-02 00:00:00'),
			(102, 12, 1, 'local', 'Library/RJ00000000/Disc/track.mp3', '', NULL, 'available', '2026-01-01 12:00:00'),
			(200, 20, 1, 'local', 'Library/RJ00000001/track.mp3', '100:1', 60, 'available', '2026-01-02 00:00:00'),
			(300, 30, 1, 'local', 'Library/RJ00000002/track.mp3', '', NULL, 'available', '2026-01-01 00:00:00'),
			(301, 31, 1, 'local', 'Library/RJ00000002/track.mp3', '100:1', 60, 'available', '2026-01-02 00:00:00'),
			(302, 31, 1, 'local', 'Library/Copy RJ00000002/track.mp3', '100:1', 60, 'available', '2026-01-02 00:00:00')`,
		`INSERT INTO user_media_progress (user_id, media_item_id, position_seconds, last_played_at) VALUES
			(1, 10, 5, '2026-01-01 00:00:00'),
			(1, 11, 20, '2026-01-02 00:00:00'),
			(1, 12, 30, '2026-01-03 00:00:00')`,
		`INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, file_source_id, location_id, location_type, position_seconds)
			VALUES (1, 1, 11, 1, 101, 'local', 30), (1, 3, 31, 1, 301, 'local', 10)`,
		`INSERT INTO media_item_display_name (media_item_id, language, name, updated_at) VALUES
			(11, 'zh-cn', 'Example Track', '2026-01-02 00:00:00'),
			(12, 'zh-cn', 'Example Track 2', '2026-01-03 00:00:00')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	type location struct{ id, itemID int64 }
	locationsAt := func(path string) []location {
		t.Helper()
		rows, err := db.Query(`SELECT id, media_item_id FROM media_file_location WHERE location_type = 'local' AND path = ? ORDER BY id`, path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		found := []location{}
		for rows.Next() {
			var entry location
			if err := rows.Scan(&entry.id, &entry.itemID); err != nil {
				t.Fatal(err)
			}
			found = append(found, entry)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return found
	}
	if got := locationsAt("Library/RJ00000000/Disc/track.mp3"); len(got) != 1 || got[0] != (location{101, 10}) {
		t.Fatalf("fetched path locations = %v, want location 101 on item 10", got)
	}
	var fingerprint, title, version string
	var parentID sql.NullInt64
	if err := db.QueryRow(`SELECT fingerprint, title, file_version, parent_id FROM media_item WHERE id = 10`).Scan(&fingerprint, &title, &version, &parentID); err != nil {
		t.Fatal(err)
	}
	if fingerprint != "local:RJ00000000:Disc/track.mp3" || title != "track" || version != "100:1" || parentID.Valid {
		t.Fatalf("kept item = fingerprint %q, title %q, version %q, parent %v", fingerprint, title, version, parentID)
	}
	var removed int
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_item WHERE id IN (11, 12)`).Scan(&removed); err != nil {
		t.Fatal(err)
	}
	var position float64
	if err := db.QueryRow(`SELECT position_seconds FROM user_media_progress WHERE user_id = 1 AND media_item_id = 10`).Scan(&position); err != nil {
		t.Fatal(err)
	}
	var cursorItem, cursorLocation int64
	if err := db.QueryRow(`SELECT media_item_id, location_id FROM user_work_playback_cursor WHERE user_id = 1 AND work_id = 1`).Scan(&cursorItem, &cursorLocation); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := db.QueryRow(`SELECT name FROM media_item_display_name WHERE media_item_id = 10 AND language = 'zh-cn'`).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if removed != 0 || position != 30 || cursorItem != 10 || cursorLocation != 101 || name != "Example Track 2" {
		t.Fatalf("merge = duplicate items %d, progress %v, cursor %d/%d, name %q", removed, position, cursorItem, cursorLocation, name)
	}

	if got := locationsAt("Library/RJ00000001/track.mp3"); len(got) != 1 || got[0] != (location{200, 20}) {
		t.Fatalf("untouched path locations = %v", got)
	}
	if got := locationsAt("Library/RJ00000002/track.mp3"); len(got) != 1 || got[0] != (location{301, 30}) {
		t.Fatalf("shared path locations = %v, want location 301 on item 30", got)
	}
	if got := locationsAt("Library/Copy RJ00000002/track.mp3"); len(got) != 1 || got[0] != (location{302, 31}) {
		t.Fatalf("copy locations = %v, want location 302 on item 31", got)
	}
	if err := db.QueryRow(`SELECT media_item_id, location_id FROM user_work_playback_cursor WHERE user_id = 1 AND work_id = 3`).Scan(&cursorItem, &cursorLocation); err != nil {
		t.Fatal(err)
	}
	if cursorItem != 30 || cursorLocation != 301 {
		t.Fatalf("cursor on the moved location = item %d, location %d; want item 30, location 301", cursorItem, cursorLocation)
	}
	if err := db.QueryRow(`SELECT fingerprint FROM media_item WHERE id = 30`).Scan(&fingerprint); err != nil {
		t.Fatal(err)
	}
	if fingerprint != "remote:2:RJ00000002:track.mp3" {
		t.Fatalf("item with a taken local fingerprint = %q", fingerprint)
	}
}

// A lyrics translation names the lyrics file it was made from and the audio
// track it belongs to. When both files of a fetched work are merged, the
// translation follows the kept lyrics location and the kept audio item; it
// never takes the lyrics item for its audio track.
func TestMigrationMergingDuplicatesKeepsATranslationOnItsAudioTrack(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 99)
	for _, statement := range []string{
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES
			(1, 'local', 'Local', 'local_folder', 1),
			(2, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1)`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work 0')`,
		`INSERT INTO work_folder_location (id, work_id, file_source_id, root_path) VALUES (1, 1, 1, 'Library/RJ00000000')`,
		`INSERT INTO media_item (id, work_id, kind, title, track_no, file_version, fingerprint) VALUES
			(10, 1, 'audio', 'track.mp3', 1, '', 'remote:2:RJ00000000:track.mp3'),
			(11, 1, 'audio', 'track', 1, '100:1', 'local:RJ00000000:track.mp3'),
			(20, 1, 'text', 'track.vtt', 0, '', 'remote:2:RJ00000000:track.vtt'),
			(21, 1, 'text', 'track.vtt', 0, '100:1', 'local:RJ00000000:track.vtt')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, file_version, availability, last_checked_at) VALUES
			(100, 10, 1, 'local', 'Library/RJ00000000/track.mp3', '', 'available', '2026-01-01 00:00:00'),
			(101, 11, 1, 'local', 'Library/RJ00000000/track.mp3', '100:1', 'available', '2026-01-02 00:00:00'),
			(200, 20, 1, 'local', 'Library/RJ00000000/track.vtt', '', 'available', '2026-01-01 00:00:00'),
			(201, 21, 1, 'local', 'Library/RJ00000000/track.vtt', '100:1', 'available', '2026-01-02 00:00:00')`,
		`INSERT INTO llm_lyrics_asset (id, work_id, source_location_id, audio_media_item_id, folder_id, language, source_hash, value_text, extension)
			VALUES ('translation', 1, 200, 11, 1, 'en', 'hash', 'WEBVTT', '.vtt')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}
	var sourceLocation, audioItem int64
	if err := db.QueryRow(`SELECT source_location_id, audio_media_item_id FROM llm_lyrics_asset WHERE id = 'translation'`).Scan(&sourceLocation, &audioItem); err != nil {
		t.Fatal(err)
	}
	if sourceLocation != 201 || audioItem != 10 {
		t.Fatalf("translation = lyrics location %d, audio item %d; want 201 and 10", sourceLocation, audioItem)
	}
}
