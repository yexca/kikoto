package storage

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"
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

func sqliteDSN(path string) string {
	if path == ":memory:" {
		path = "file::memory:"
	}
	values := url.Values{}
	values.Add("_pragma", "foreign_keys(1)")
	values.Add("_pragma", "journal_mode(WAL)")
	values.Add("_pragma", "busy_timeout(5000)")
	values.Set("_txlock", "immediate")
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	return path + separator + values.Encode()
}
