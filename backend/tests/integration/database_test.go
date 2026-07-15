package integration_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func openMigratedTestDB(t *testing.T, name string) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
