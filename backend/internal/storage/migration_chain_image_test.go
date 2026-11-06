package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// chainImages keeps checkpointed images of databases that the real numbered
// migrations of migrations/ built through a version, so the tests of one
// process replay each numbered migration once rather than once per test. A
// test only ever receives a private copy of an image.
var chainImages = struct {
	sync.Mutex
	byVersion map[int][]byte
}{byVersion: map[int][]byte{}}

// While a build passes a multiple of chainImageStride it keeps that image too,
// so a later test at a lower version replays at most one stride.
const chainImageStride = 8

// openMigratedThrough returns a private database that the numbered migrations
// of migrations/ built through version, the same database Migrate builds
// from copyNumberedMigrationsThrough. Applying a catalog to a database that
// an earlier catalog built continues the same numbered chain, so the image a
// test copies does not depend on which test built it.
func openMigratedThrough(t *testing.T, version int) *sqlutil.DB {
	t.Helper()
	image := chainImage(t, version)
	path := filepath.Join(t.TempDir(), "migration-manager.db")
	if err := os.WriteFile(path, image, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func chainImage(t *testing.T, version int) []byte {
	t.Helper()
	chainImages.Lock()
	defer chainImages.Unlock()
	if image, ok := chainImages.byVersion[version]; ok {
		return image
	}
	from := 0
	for cached := range chainImages.byVersion {
		if cached < version && cached > from {
			from = cached
		}
	}
	path := filepath.Join(t.TempDir(), "chain.db")
	if from > 0 {
		if err := os.WriteFile(path, chainImages.byVersion[from], 0o600); err != nil {
			t.Fatal(err)
		}
	}
	db, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	sourceDir := filepath.Join("..", "..", "migrations")
	steps := []int{}
	for step := (from/chainImageStride + 1) * chainImageStride; step < version; step += chainImageStride {
		steps = append(steps, step)
	}
	for _, step := range append(steps, version) {
		if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, step)); err != nil {
			t.Fatalf("create schema version %03d database: %v", step, err)
		}
		image, err := checkpointedImage(db, path)
		if err != nil {
			t.Fatalf("snapshot schema version %03d database: %v", step, err)
		}
		chainImages.byVersion[step] = image
	}
	return chainImages.byVersion[version]
}

func TestMigratedThroughStackedImageMatchesEmptyDatabaseBuild(t *testing.T) {
	const lower, version = 5, 13
	openMigratedThrough(t, lower)
	stacked := openMigratedThrough(t, version)
	fresh := openMigrationManagerDB(t)
	if err := Migrate(fresh, copyNumberedMigrationsThrough(t, filepath.Join("..", "..", "migrations"), version)); err != nil {
		t.Fatal(err)
	}
	if got, want := chainImageSummary(t, stacked), chainImageSummary(t, fresh); got != want {
		t.Fatalf("stacked image differs from an empty-database build:\n%s\nwant:\n%s", got, want)
	}
}

// chainImageSummary lists the schema, the migration ledger without its
// timings, and the row count of every table.
func chainImageSummary(t *testing.T, db *sqlutil.DB) string {
	t.Helper()
	var summary strings.Builder
	collect := func(query string) []string {
		rows, err := db.Query(query)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		var lines []string
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				t.Fatal(err)
			}
			lines = append(lines, line)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return lines
	}
	for _, line := range collect(`SELECT type || ' ' || name || ' ' || coalesce(sql, '') FROM sqlite_master ORDER BY type, name`) {
		summary.WriteString(line + "\n")
	}
	for _, line := range collect(`SELECT printf('%03d %s %s %s', version, filename, checksum, app_version) FROM schema_migration ORDER BY version, filename`) {
		summary.WriteString(line + "\n")
	}
	for _, table := range collect(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`) {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM "` + table + `"`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(&summary, "%s rows %d\n", table, count)
	}
	return summary.String()
}

// checkpointedImage moves every committed page into the database file, which
// then holds the whole database without its write-ahead log.
func checkpointedImage(db *sqlutil.DB, path string) ([]byte, error) {
	var busy, logPages, checkpointed int
	if err := db.QueryRow("PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logPages, &checkpointed); err != nil {
		return nil, err
	}
	if busy != 0 {
		return nil, fmt.Errorf("checkpoint remained busy")
	}
	return os.ReadFile(path)
}
