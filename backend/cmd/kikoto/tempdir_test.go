package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func openTempDirTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "kikoto.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// The SQLite temporary directory is process-wide state.
		_, _ = db.Exec("PRAGMA temp_store_directory = ''")
		_ = db.Close()
	})
	return db
}

func TestUseCacheTempDirDiscardsFilesOfAnInterruptedRun(t *testing.T) {
	cacheRoot := filepath.Join(t.TempDir(), "cache")
	db := openTempDirTestDB(t)
	dir := filepath.Join(cacheRoot, ".kikoto-tmp")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "kikoto-kikoeru-interrupted.sqlite3"), []byte("upload"), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := useCacheTempDir(context.Background(), db, dir); got != dir {
		t.Fatalf("temporary directory = %q, want %q", got, dir)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("temporary directory after startup = %v, %v, want it empty", entries, err)
	}
	var sqliteDir string
	if err := db.QueryRow("PRAGMA temp_store_directory").Scan(&sqliteDir); err != nil || sqliteDir != dir {
		t.Fatalf("SQLite temporary directory = %q, %v, want %q", sqliteDir, err, dir)
	}
}

func TestUseCacheTempDirFallsBackWhenTheCacheRootCannotHoldOne(t *testing.T) {
	blocked := filepath.Join(t.TempDir(), "cache")
	db := openTempDirTestDB(t)
	if err := os.WriteFile(blocked, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	if got := useCacheTempDir(context.Background(), db, filepath.Join(blocked, ".kikoto-tmp")); got != "" {
		t.Fatalf("temporary directory = %q, want the system temporary directory", got)
	}
	if got := useCacheTempDir(context.Background(), db, ""); got != "" {
		t.Fatalf("temporary directory without a cache root = %q", got)
	}
}
