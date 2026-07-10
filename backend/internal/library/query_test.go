package library

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestStoreListPageFiltersScopeAndSearch(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	first, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ01234567', 'Local work')")
	if err != nil {
		t.Fatal(err)
	}
	localWorkID, _ := first.LastInsertId()
	if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ07654321', 'Database work')"); err != nil {
		t.Fatal(err)
	}
	source, err := db.Exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('test-local', 'Test local', 'local')")
	if err != nil {
		t.Fatal(err)
	}
	sourceID, _ := source.LastInsertId()
	if _, err := db.Exec("INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (?, ?, 'local', 'available')", localWorkID, sourceID); err != nil {
		t.Fatal(err)
	}

	page, err := NewStore(db).ListPage(context.Background(), ListOptions{
		Page: 1, PageSize: 24, Scope: "local", Query: "RJ01234567", Sort: "code", Direction: "asc",
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].PrimaryCode != "RJ01234567" {
		t.Fatalf("ListPage() = total %d, works %#v", page.Total, page.Works)
	}
	if page.Works[0].SourcePresence == "" {
		t.Fatal("ListPage() omitted source presence")
	}
}

func TestStoreListPageNormalizesPagination(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "pagination.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	page, err := NewStore(db).ListPage(context.Background(), ListOptions{Page: -1, PageSize: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if page.Page != 1 || page.PageSize != 24 {
		t.Fatalf("ListPage() normalized to page %d size %d, want 1 and 24", page.Page, page.PageSize)
	}
}
