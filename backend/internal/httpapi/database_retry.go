package httpapi

import (
	"context"
	"database/sql"
	"time"
)

const databaseBusyRetryAttempts = 4

func withDatabaseBusyRetry(ctx context.Context, operation func() error) error {
	var err error
	for attempt := 0; attempt < databaseBusyRetryAttempts; attempt++ {
		err = operation()
		if err == nil || !isDatabaseBusyError(err) || attempt == databaseBusyRetryAttempts-1 {
			return err
		}
		delay := time.Duration(25*(1<<attempt)) * time.Millisecond
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return err
}

func beginTxWithDatabaseBusyRetry(ctx context.Context, db *sql.DB) (*sql.Tx, error) {
	var tx *sql.Tx
	err := withDatabaseBusyRetry(ctx, func() error {
		var err error
		tx, err = db.BeginTx(ctx, nil)
		return err
	})
	return tx, err
}
