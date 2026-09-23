package storage

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

func Open(path string) (*sql.DB, error) {
	if !strings.HasPrefix(path, "file:") && path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, err
		}
	}

	db, err := sql.Open("sqlite", sqliteDSN(path))
	if err != nil {
		return nil, err
	}
	if path == ":memory:" {
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	} else {
		db.SetMaxOpenConns(4)
		db.SetMaxIdleConns(4)
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

// Per-connection SQLite tuning. The file-backed pool holds at most four
// connections, so the page cache is bounded to roughly 64 MiB in total and the
// shared memory map to one 256 MiB window per connection (address space, not
// resident memory). WAL with synchronous=NORMAL keeps the database consistent
// after a crash; only the most recent commits may roll back on power loss.
const (
	sqliteBusyTimeoutMillis = 5000
	sqliteCacheSizeKiB      = 16000
	sqliteMmapSizeBytes     = 256 << 20
)

func sqliteDSN(path string) string {
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
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return path + separator + values.Encode()
}
