package storage

import (
	"context"
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// DefaultReadConnections is the reader pool size of a file-backed database
// when OpenOptions leaves it unset.
const DefaultReadConnections = 8

type OpenOptions struct {
	// ReadConnections bounds the reader pool; zero or less uses
	// DefaultReadConnections.
	ReadConnections int
}

// Open opens path with the default pool sizes.
func Open(path string) (*sqlutil.DB, error) {
	return OpenWithOptions(path, OpenOptions{})
}

// OpenWithOptions opens path as a single writer connection and a pool of
// query-only reader connections. SQLite admits one writer at a time, so writes
// queue for the writer connection in Go instead of each holding a pooled
// connection while SQLite waits for the write lock. An in-memory database
// exists only within its one connection and so shares it for both.
func OpenWithOptions(path string, options OpenOptions) (*sqlutil.DB, error) {
	if !strings.HasPrefix(path, "file:") && path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
	}

	if path == ":memory:" {
		pool, err := openPool(sqliteDSN(path, false), 1)
		if err != nil {
			return nil, err
		}
		return sqlutil.SharedDB(pool), nil
	}
	readConnections := options.ReadConnections
	if readConnections <= 0 {
		readConnections = DefaultReadConnections
	}
	// The writer opens first so that a new database file is created and
	// switched to WAL before any query-only connection opens it.
	writer, err := openPool(sqliteDSN(path, false), 1)
	if err != nil {
		return nil, err
	}
	readers, err := openPool(sqliteDSN(path, true), readConnections)
	if err != nil {
		_ = writer.Close()
		return nil, err
	}
	return sqlutil.NewDB(readers, writer), nil
}

func openPool(dsn string, connections int) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(connections)
	db.SetMaxIdleConns(connections)
	if !strings.HasPrefix(dsn, "file::memory:") {
		// File-backed connections are cheap to reopen. Bounding their idle and
		// total lifetimes ensures that an unexpectedly contaminated connection
		// cannot retain a SQLite lock indefinitely while sitting in the pool.
		db.SetConnMaxIdleTime(time.Minute)
		db.SetConnMaxLifetime(30 * time.Minute)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// UseTempDirectory makes SQLite create its temporary files in dir, which must
// exist and be writable, instead of the system temporary directory. VACUUM,
// index builds, and large sorts spill there once they outgrow the page cache,
// so dir needs room for about one copy of the database. The setting belongs
// to the process rather than to db: call it once at startup, before other
// goroutines use SQLite.
func UseTempDirectory(ctx context.Context, db *sqlutil.DB, dir string) error {
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, "PRAGMA temp_store_directory = '"+strings.ReplaceAll(absolute, "'", "''")+"'")
	return err
}

// Per-connection SQLite tuning. Each open connection may fill a 16 MiB page
// cache, so the default file-backed pools of one writer and eight readers
// bound it to roughly 144 MiB in total, and map one shared 256 MiB window per
// connection (address space, not resident memory). WAL with synchronous=NORMAL keeps the database consistent
// after a crash; only the most recent commits may roll back on power loss.
const (
	sqliteBusyTimeoutMillis = 30000
	sqliteCacheSizeKiB      = 16000
	sqliteMmapSizeBytes     = 256 << 20
)

func sqliteDSN(path string, queryOnly bool) string {
	if path == ":memory:" {
		path = "file::memory:"
	}
	values := url.Values{}
	values.Add("_pragma", "foreign_keys(1)")
	values.Add("_pragma", "journal_mode(WAL)")
	values.Add("_pragma", "busy_timeout("+strconv.Itoa(sqliteBusyTimeoutMillis)+")")
	values.Add("_pragma", "synchronous(NORMAL)")
	// A negative cache_size is a KiB budget rather than a page count.
	values.Add("_pragma", "cache_size(-"+strconv.Itoa(sqliteCacheSizeKiB)+")")
	values.Add("_pragma", "mmap_size("+strconv.Itoa(sqliteMmapSizeBytes)+")")
	values.Set("_txlock", "immediate")
	if queryOnly {
		// A misrouted write fails instead of waiting for the write lock on a
		// reader connection.
		values.Set("_query_only", "1")
	}
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return path + separator + values.Encode()
}
