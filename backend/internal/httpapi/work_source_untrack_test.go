package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRunWorkSourceUntrackDoesNotExposeCachePaths(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (1, 1, 'tracked', 'available');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'track.mp3', 'untrack-cache-test');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'cache', 'media/example_remote/RJ/RJ00000000/track.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}

	result, err := server.runWorkSourceUntrack(context.Background(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	document, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(document), "cachePaths") || strings.Contains(string(document), "media/example_remote") {
		t.Fatalf("untrack response leaks cache layout: %s", document)
	}
}
