package storage

import (
	"path/filepath"
	"testing"
)

// Migration 069 rebuilds media_lyrics_assignment so a track keeps one lyrics
// file per language. An assignment stored before it applies to every language.
func TestLyricsAssignmentLanguageMigrationKeepsAssignmentsForEveryLanguage(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 68)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (101, 'synthetic-editor', 'admin')`,
		`INSERT INTO work (id, primary_code, title) VALUES (11, 'RJ00000001', 'Example Work 1')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(21, 11, 'audio', 'Track 1', 'audio-21'),
			(22, 11, 'text', 'Track 1 lyrics', 'lyrics-22'),
			(23, 11, 'text', 'Track 1 translated lyrics', 'lyrics-23')`,
		`INSERT INTO media_lyrics_assignment (audio_media_item_id, lyrics_media_item_id, origin, assigned_by_user_id, updated_at)
			VALUES (21, 22, 'remote_fetch', 101, '2026-10-01 00:00:00')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}

	var language, origin, updatedAt string
	var lyricsID, assignedBy int64
	if err := db.QueryRow(`
		SELECT language, lyrics_media_item_id, origin, assigned_by_user_id, updated_at
		FROM media_lyrics_assignment
		WHERE audio_media_item_id = 21
	`).Scan(&language, &lyricsID, &origin, &assignedBy, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if language != "" || lyricsID != 22 || origin != "remote_fetch" || assignedBy != 101 || updatedAt != "2026-10-01 00:00:00" {
		t.Fatalf("migrated assignment = %q/%d/%s/%d/%s", language, lyricsID, origin, assignedBy, updatedAt)
	}

	if _, err := db.Exec(`INSERT INTO media_lyrics_assignment (audio_media_item_id, language, lyrics_media_item_id) VALUES (21, 'zh-cn', 23)`); err != nil {
		t.Fatalf("a second language was rejected: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO media_lyrics_assignment (audio_media_item_id, language, lyrics_media_item_id) VALUES (21, 'zh-cn', 22)`); err == nil {
		t.Fatal("one language accepted two lyrics files")
	}
	if _, err := db.Exec(`INSERT INTO media_lyrics_assignment (audio_media_item_id, language, lyrics_media_item_id) VALUES (21, 'tlh', 22)`); err == nil {
		t.Fatal("an unsupported language was accepted")
	}
	if _, err := db.Exec(`DELETE FROM media_item WHERE id = 23`); err != nil {
		t.Fatal(err)
	}
	var remaining int
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_lyrics_assignment WHERE audio_media_item_id = 21`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("deleting a lyrics file left %d assignments, want only the other language's", remaining)
	}
}
