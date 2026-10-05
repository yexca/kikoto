package storage

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestBoundedTransactionRestoresConnectionPolicyAfterCommitAndCancellation(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "bounded.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("CREATE TABLE bounded_values(value TEXT)"); err != nil {
		t.Fatal(err)
	}
	for _, commit := range []bool{true, false} {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		tx, release, err := BeginBoundedTx(ctx, db)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO bounded_values VALUES ('synthetic')"); err != nil {
			t.Fatal(err)
		}
		if commit {
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
		} else {
			cancel()
		}
		release()
		release()
		cancel()
		var timeout int
		if err := db.QueryRow("PRAGMA busy_timeout").Scan(&timeout); err != nil {
			t.Fatal(err)
		}
		if timeout != sqliteBusyTimeoutMillis {
			t.Fatalf("leased wait policy leaked: %d", timeout)
		}
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM bounded_values").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("canceled transaction kept writes: %d", count)
	}
}
