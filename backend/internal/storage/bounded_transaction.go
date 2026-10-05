package storage

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"sync"
	"time"
)

// BeginBoundedTx leases a connection and bounds each SQLite busy wait, because
// sqlite's busy handler can outlast a Go context deadline. The caller must call
// release after committing or abandoning the transaction. Other pooled
// connections retain their configured busy policy.
func BeginBoundedTx(ctx context.Context, db *sql.DB) (*sql.Tx, func(), error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, nil, err
	}
	var original int
	if err := conn.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&original); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	var tx *sql.Tx
	var once sync.Once
	release := func() {
		once.Do(func() {
			if tx != nil {
				_ = tx.Rollback()
			}
			restoreCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
			defer cancel()
			if _, err := conn.ExecContext(restoreCtx, fmt.Sprintf("PRAGMA busy_timeout=%d", original)); err != nil {
				// Do not return a connection with a modified wait policy to the pool.
				_ = conn.Raw(func(any) error { return driver.ErrBadConn })
			}
			_ = conn.Close()
		})
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout=%d", min(original, 100))); err != nil {
		release()
		return nil, nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			release()
			return nil, nil, err
		}
		tx, err = conn.BeginTx(ctx, nil)
		if err == nil {
			return tx, release, nil
		}
		if contextErr := ctx.Err(); contextErr != nil {
			release()
			return nil, nil, contextErr
		}
		var sqliteErr interface{ Code() int }
		if !errors.As(err, &sqliteErr) || (sqliteErr.Code()&255 != 5 && sqliteErr.Code()&255 != 6) {
			release()
			return nil, nil, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
}
