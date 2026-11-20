package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A location a folder edit moved to another file in place streams that file at
// once, not the earlier path a cached target still names.
func TestMediaStreamTargetFollowsALocationMovedInPlace(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	for _, statement := range []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'Track', 'stream-cache')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'local', 'Library/RJ00000000/first.mp3', 'available')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	if target, _, err := server.loadMediaStreamTarget(ctx, 1); err != nil || target.RelativePath != "Library/RJ00000000/first.mp3" {
		t.Fatalf("first target = %+v, %v", target, err)
	}
	if target, cached, err := server.loadMediaStreamTarget(ctx, 1); err != nil || !cached || target.RelativePath != "Library/RJ00000000/first.mp3" {
		t.Fatalf("unchanged target = %+v, cached %v, %v", target, cached, err)
	}
	if _, err := db.Exec(`UPDATE media_file_location SET path = 'Library/RJ00000000/second.mp3' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	target, cached, err := server.loadMediaStreamTarget(ctx, 1)
	if err != nil || cached || target.RelativePath != "Library/RJ00000000/second.mp3" {
		t.Fatalf("moved target = %+v, cached %v, %v", target, cached, err)
	}
	if _, err := db.Exec(`UPDATE media_file_location SET availability = 'missing' WHERE id = 1`); err != nil {
		t.Fatal(err)
	}
	if target, _, err := server.loadMediaStreamTarget(ctx, 1); err != nil || target.Availability != "missing" {
		t.Fatalf("retired target = %+v, %v", target, err)
	}
}
