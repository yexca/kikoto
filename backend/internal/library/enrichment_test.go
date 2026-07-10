package library

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestLoadMediaSelectionsPrefersAvailableLocalEdition(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "selection.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ01000001', 'Origin'), (2, 'RJ01000002', 'Translation')`,
		`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ01000001')`,
		`INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical, translation_kind) VALUES (1, 1, 'RJ01000001', 'RJ01000001', 1, 'origin'), (2, 1, 'RJ01000002', 'RJ01000001', 0, 'official')`,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Origin track'), (2, 2, 'audio', 'Local translated track')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 'remote_stream', 'origin.mp3', 'available'), (2, 2, 'local', 'translation.mp3', 'available')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	selections, err := NewStore(db).LoadMediaSelections(context.Background(), []int64{1})
	if err != nil {
		t.Fatal(err)
	}
	if got := selections[1]; got.WorkID != 2 || got.Code != "RJ01000002" || got.TranslationKind != "official" {
		t.Fatalf("selection = %+v", got)
	}
}
