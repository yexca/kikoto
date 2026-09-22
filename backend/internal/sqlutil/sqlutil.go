// Package sqlutil holds small database/sql helpers shared by persistence
// packages. It must not import any application package.
package sqlutil

import (
	"context"
	"database/sql"
)

// Execer is satisfied by *sql.DB, *sql.Tx, and *sql.Conn.
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// RowQuerier is satisfied by *sql.DB, *sql.Tx, and *sql.Conn.
type RowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// InsertID executes an INSERT and returns the new row id.
func InsertID(ctx context.Context, db Execer, query string, args ...any) (int64, error) {
	result, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

// SelectID scans a single id column. It returns sql.ErrNoRows when the query
// matches nothing.
func SelectID(ctx context.Context, db RowQuerier, query string, args ...any) (int64, error) {
	var id int64
	if err := db.QueryRowContext(ctx, query, args...).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

// String returns nil for SQL NULL and a pointer to the value otherwise.
func String(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

// Int64 returns nil for SQL NULL and a pointer to the value otherwise.
func Int64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

// Float64 returns nil for SQL NULL and a pointer to the value otherwise.
func Float64(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

// Bool returns nil for SQL NULL and a pointer to the value otherwise.
func Bool(value sql.NullBool) *bool {
	if !value.Valid {
		return nil
	}
	return &value.Bool
}
