package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestWorkMediaNamesTheFolderHoldingEachLocalLocation(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES
			(1, 'example_local', 'Example Local', 'local_folder', 1),
			(2, 'example_other', 'Example Other', 'local_folder', 1);
		INSERT INTO work (id, primary_code, title) VALUES (11, 'RJ00000001', 'Example Work 1');
		INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary) VALUES
			(31, 11, 1, 'library/Example Folder', 'external', 'active', 1),
			(32, 11, 1, 'library/Example Folder/Bonus', 'external', 'active', 0),
			(33, 11, 1, 'library/example folder', 'external', 'active', 0);
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(21, 11, 'audio', '01 track', 'local:RJ00000001:mp3/01 track.mp3'),
			(22, 11, 'audio', 'bonus', 'local:RJ00000001:bonus.mp3'),
			(23, 11, 'audio', '02 track', 'local:RJ00000001:02 track.mp3');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(41, 21, 1, 'local', 'library/Example Folder/mp3/01 track.mp3', 'available'),
			(42, 22, 1, 'local', 'library/Example Folder/Bonus/bonus.mp3', 'available'),
			(43, 23, 1, 'local', 'library/example folder/02 track.mp3', 'available'),
			(44, 23, 2, 'local', 'library/Example Folder/02 track.mp3', 'available'),
			(45, 23, 1, 'local', 'library/Example Folder Copy/02 track.mp3', 'available'),
			(46, 21, 1, 'cache', 'library/Example Folder/mp3/01 track.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	items, err := NewServer(db, config.Config{}).loadWorkMediaItems(context.Background(), 0, 11)
	if err != nil {
		t.Fatal(err)
	}
	type held struct {
		folderID int64
		relative string
	}
	got := map[int64]held{}
	for _, item := range items {
		for _, location := range item.Locations {
			entry := held{relative: location.RelativePath}
			if location.FolderID != nil {
				entry.folderID = *location.FolderID
			}
			got[location.ID] = entry
		}
	}
	want := map[int64]held{
		// A folder named without the work code holds its files.
		41: {31, "mp3/01 track.mp3"},
		// The deepest folder that holds a file is its folder.
		42: {32, "bonus.mp3"},
		// Paths that differ only in case are different folders.
		43: {33, "02 track.mp3"},
		// A folder holds only files on its own file source.
		44: {},
		// A folder does not hold a sibling whose name starts with its own.
		45: {},
		// Only local locations lie in a work folder.
		46: {},
	}
	for id, expected := range want {
		if got[id] != expected {
			t.Errorf("location %d = %+v, want %+v", id, got[id], expected)
		}
	}
}
