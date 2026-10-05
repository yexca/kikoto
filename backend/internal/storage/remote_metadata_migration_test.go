package storage

import (
	"path/filepath"
	"testing"
)

// Migration 054 must reconcile existing remote-only data through the durable
// queue without touching works that only have DLsite metadata or rewriting
// their stored fields.
func TestRemoteMetadataFallbackMigrationQueuesRemoteWorks(t *testing.T) {
	source := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, source, 53)); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work 0'), (2, 'RJ00000001', 'Example Work 1')`,
		`INSERT INTO metadata_provider (id, code, display_name) VALUES (90, 'kikoeru_source_example_remote_a', 'Example Remote A')`,
		`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (1, 90, 'RJ00000000', '{"source_id":"RJ00000000"}')`,
		`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
			SELECT 2, id, 'RJ00000001', '{}' FROM metadata_provider WHERE code = 'dlsite'`,
		`DELETE FROM work_metadata_tag_dirty`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, source); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query("SELECT work_id FROM work_metadata_tag_dirty ORDER BY work_id")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	queued := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		queued = append(queued, id)
	}
	if len(queued) != 1 || queued[0] != 1 {
		t.Fatalf("queued works = %v, want only the remote work", queued)
	}
	var title string
	var provenance int
	if err := db.QueryRow("SELECT title FROM work WHERE id = 1").Scan(&title); err != nil || title != "Example Work 0" {
		t.Fatalf("migration rewrote work fields: %q %v", title, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_field_source").Scan(&provenance); err != nil || provenance != 0 {
		t.Fatalf("migration wrote provenance itself: %d %v", provenance, err)
	}
	if _, err := db.Exec(`INSERT INTO work_metadata_field_source (work_id, field_name, provider_id) VALUES (1, 'subtitle', 90)`); err == nil {
		t.Fatal("unknown provenance field accepted")
	}
}
