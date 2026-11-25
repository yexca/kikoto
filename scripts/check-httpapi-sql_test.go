package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Run from backend/:
//
//	go test ../scripts/check-httpapi-sql.go ../scripts/check-httpapi-sql_test.go

// A statement passed through a wrapper counts at each call of the wrapper,
// whether the wrapper is a method, a function that calls another wrapper, or
// a named closure, and the call inside the wrapper does not count again.
func TestStatementsPassedThroughHelpersCountAtEachCall(t *testing.T) {
	dir := t.TempDir()
	source := `package api

import (
	"context"
	"database/sql"
	"net/url"

	"example.test/sqlutil"
)

type Server struct{ db *sql.DB }

func (s *Server) execQuietly(ctx context.Context, operation string, query string, args ...any) {
	_, _ = s.db.ExecContext(ctx, query, args...)
}

func (s *Server) touch(ctx context.Context, where string) {
	s.execQuietly(ctx, "touch", "UPDATE item SET seen = 1 WHERE "+where)
}

func (s *Server) handler(ctx context.Context, tx *sql.Tx, link *url.URL) {
	s.execQuietly(ctx, "one", "DELETE FROM item")
	s.execQuietly(ctx, "two", "DELETE FROM other")
	s.touch(ctx, "id = 1")
	s.touch(ctx, "id = 2")
	exec := func(statement string) { _, _ = tx.ExecContext(ctx, statement) }
	exec("UPDATE item SET a = 1")
	exec("UPDATE item SET b = 1")
	_ = s.db.QueryRowContext(ctx, "SELECT 1")
	_, _ = sqlutil.InsertID(ctx, tx, "INSERT INTO item DEFAULT VALUES")
	_ = link.Query()
	_ = func(name string) string { return name }("not a statement")
}
`
	if err := os.WriteFile(filepath.Join(dir, "api.go"), []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "api_test.go"), []byte("package api\n\nfunc init() { _, _ = (*Server)(nil).db.Exec(\"SELECT 1\") }\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	counts, helpers, err := countStatements(dir)
	if err != nil {
		t.Fatal(err)
	}
	// Two execQuietly calls, two touch calls, two exec calls, the row query
	// and the insert.
	if got := counts[filepath.ToSlash(filepath.Join(dir, "api.go"))]; got != 8 {
		t.Fatalf("statements = %d (%v), want 8", got, counts)
	}
	for name, position := range map[string]int{"execQuietly": 2, "touch": 1, "exec": 0} {
		if got, ok := helpers[name]; !ok || got != position {
			t.Fatalf("helper %s = %d, %t; want statement argument %d (helpers %v)", name, got, ok, position, helpers)
		}
	}
	if len(helpers) != 3 {
		t.Fatalf("helpers = %v, want execQuietly, touch, and exec", helpers)
	}
}
