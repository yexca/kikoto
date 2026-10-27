package httpapi

import (
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

// Tests start from a configured standard library, like an instance that
// finished onboarding. Onboarding tests clear the mode themselves.
var migratedTestDatabase = storagetest.NewTemplate(func(db *sqlutil.DB) error {
	_, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('library_mode', '"standard"')`)
	return err
})

// openMigratedTestDB limits the reader pool to one connection, like the
// writer. A request path that keeps a cursor or transaction open while issuing
// another query on the same pool needs a second pooled connection; in
// production, a few such concurrent requests can exhaust the pool and wait on
// each other indefinitely. With one connection the same path blocks
// deterministically, so a test hanging in database/sql.(*DB).conn points at a
// query issued before the prior one closed.
func openMigratedTestDB(t *testing.T) *sqlutil.DB {
	t.Helper()
	db := openMigratedTestDBWithProductionPool(t)
	db.SetMaxOpenConns(1)
	return db
}

// openMigratedTestDBWithProductionPool keeps the production connection pool
// for tests that deliberately exercise concurrent connections, such as a
// reader proceeding while another connection holds the write lock.
func openMigratedTestDBWithProductionPool(t *testing.T) *sqlutil.DB {
	t.Helper()
	return migratedTestDatabase.Open(t)
}

func TestMigratedTestDatabasePools(t *testing.T) {
	if db := openMigratedTestDB(t); db.Readers().Stats().MaxOpenConnections != 1 || db.Writer().Stats().MaxOpenConnections != 1 {
		t.Fatal("test database must use one connection per pool to expose nested pool acquisition")
	}
	if production := openMigratedTestDBWithProductionPool(t); production.Readers().Stats().MaxOpenConnections != storage.DefaultReadConnections {
		t.Fatal("production-pool test database must retain the production reader pool")
	}
}
