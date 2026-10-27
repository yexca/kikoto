package integration_test

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

func openMigratedTestDB(t *testing.T, name string) *sql.DB {
	t.Helper()
	return storagetest.OpenFile(t, filepath.Join(t.TempDir(), name))
}
