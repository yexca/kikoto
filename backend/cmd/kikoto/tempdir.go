package main

import (
	"context"
	"database/sql"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/yexca/kikoto/backend/internal/storage"
)

// useCacheTempDir moves temporary files into dir, inside the cache root: an
// uploaded Kikoeru database, and what SQLite spills while it compacts, sorts,
// or builds an index. Container deployments keep the system temporary
// directory small and memory-backed, which a database-sized file does not
// fit. Whatever an interrupted run left in dir is removed first. It returns
// the directory in use, or "" for the system temporary directory when the
// cache root cannot hold one.
func useCacheTempDir(ctx context.Context, db *sql.DB, dir string) string {
	if dir == "" {
		return ""
	}
	if err := resetTempDir(ctx, db, dir); err != nil {
		slog.Warn("temporary directory unavailable; using the system temporary directory", "path", dir, "error", err)
		return ""
	}
	return dir
}

func resetTempDir(ctx context.Context, db *sql.DB, dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	// An upload can hold every account of another server.
	if err := os.Mkdir(dir, 0o700); err != nil {
		return err
	}
	return storage.UseTempDirectory(ctx, db, dir)
}
