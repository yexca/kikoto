package integration_test

import (
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

func openMigratedTestDB(t *testing.T, name string) *sqlutil.DB {
	t.Helper()
	return storagetest.OpenFile(t, filepath.Join(t.TempDir(), name))
}
