package sqlutil

import (
	"context"
	"database/sql"
	"errors"
)

// readPool names the embedded reader pool so that DB promotes its query
// methods without exporting the pool itself as a field.
type readPool = sql.DB

// DB routes database work between a writer pool and a reader pool. SQLite
// admits one writer at a time, so a writer waiting for the write lock occupies
// only a writer connection while reads keep their own connections.
//
// Exec, Begin, BeginTx, and Conn use the writer pool; a read-only transaction
// and every query method use the readers. A statement that writes outside a
// transaction must therefore use Exec or Writer, never a query method.
type DB struct {
	*readPool
	writer *sql.DB
}

// NewDB routes writes to writer and reads to readers.
func NewDB(readers, writer *sql.DB) *DB {
	return &DB{readPool: readers, writer: writer}
}

// SharedDB routes reads and writes to one pool, for databases such as
// in-memory ones whose connections cannot be split.
func SharedDB(pool *sql.DB) *DB {
	return NewDB(pool, pool)
}

// Readers returns the pool that serves queries and read-only transactions.
func (db *DB) Readers() *sql.DB { return db.readPool }

// Writer returns the pool that serves writes. Use it for a statement that
// writes through a query method, such as INSERT ... RETURNING outside a
// transaction.
func (db *DB) Writer() *sql.DB { return db.writer }

func (db *DB) Exec(query string, args ...any) (sql.Result, error) {
	return db.writer.Exec(query, args...)
}

func (db *DB) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return db.writer.ExecContext(ctx, query, args...)
}

func (db *DB) Begin() (*sql.Tx, error) {
	return db.writer.Begin()
}

// BeginTx starts a read-only transaction on the readers and any other
// transaction on the writer.
func (db *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error) {
	if opts != nil && opts.ReadOnly {
		return db.readPool.BeginTx(ctx, opts)
	}
	return db.writer.BeginTx(ctx, opts)
}

// Conn leases a writer connection, because callers lease a connection to
// change its session state around maintenance writes.
func (db *DB) Conn(ctx context.Context) (*sql.Conn, error) {
	return db.writer.Conn(ctx)
}

// Close closes both pools.
func (db *DB) Close() error {
	if db.writer == db.readPool {
		return db.writer.Close()
	}
	return errors.Join(db.writer.Close(), db.readPool.Close())
}
