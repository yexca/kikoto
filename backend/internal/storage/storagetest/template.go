// Package storagetest gives tests a private database with the packaged schema
// without running the migration chain for every test.
package storagetest

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/migrations"
)

// Template migrates the packaged catalog once per test process, applies its
// seed, and checkpoints the result into a database image. Every Open copies
// that image into the test's own writable file, so no database or WAL is
// shared between tests. Tests of a migration or of the migration chain build
// their own databases instead.
type Template struct {
	image func() ([]byte, error)
}

var migrated = NewTemplate(nil)

// NewTemplate returns a template of the packaged schema plus the rows seed
// writes. A nil seed leaves the freshly migrated schema.
func NewTemplate(seed func(*sql.DB) error) *Template {
	return &Template{image: sync.OnceValues(func() ([]byte, error) {
		return buildImage(seed)
	})}
}

// Open copies the migrated schema into a private file and opens it with the
// production connection pool.
func Open(t testing.TB) *sql.DB {
	t.Helper()
	return migrated.Open(t)
}

// OpenFile is Open at a path the test chooses, for a test that reopens the
// file or hands its path to the code under test.
func OpenFile(t testing.TB, path string) *sql.DB {
	t.Helper()
	return migrated.OpenFile(t, path)
}

// Open copies the template into a private file and opens it with the
// production connection pool. The database closes when the test ends.
func (template *Template) Open(t testing.TB) *sql.DB {
	t.Helper()
	return template.OpenFile(t, filepath.Join(t.TempDir(), "test.db"))
}

// OpenFile is Open at a path the test chooses. The file must not exist yet.
func (template *Template) OpenFile(t testing.TB, path string) *sql.DB {
	t.Helper()
	image, err := template.image()
	if err != nil {
		t.Fatalf("prepare test database: %v", err)
	}
	if err := os.WriteFile(path, image, 0o600); err != nil {
		t.Fatalf("copy test database: %v", err)
	}
	db, err := storage.Open(path)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func buildImage(seed func(*sql.DB) error) ([]byte, error) {
	dir, err := os.MkdirTemp("", "kikoto-test-schema-")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(dir) }()
	path := filepath.Join(dir, "schema.db")
	db, err := storage.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	// The embedded catalog is the one the binary ships; storage.Migrate reads
	// the same files from disk with the same options and version.
	if err := storage.MigrateFS(db, migrations.Files, buildinfo.Version); err != nil {
		return nil, err
	}
	if seed != nil {
		if err := seed(db); err != nil {
			return nil, fmt.Errorf("seed test schema: %w", err)
		}
	}
	var busy, logPages, checkpointed int
	if err := db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logPages, &checkpointed); err != nil {
		return nil, err
	}
	if busy != 0 {
		return nil, fmt.Errorf("test schema checkpoint remained busy")
	}
	if err := db.Close(); err != nil {
		return nil, err
	}
	return os.ReadFile(path)
}
