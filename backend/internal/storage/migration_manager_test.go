package storage

import (
	"bytes"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/migrations"
)

var numberedMigrationFilePattern = regexp.MustCompile(`^[0-9]{3}_[a-z0-9][a-z0-9_]*\.sql$`)

const latestNumberedMigrationVersion = 32

func TestMigrationChecksumNormalizesLineEndings(t *testing.T) {
	lf := []byte("CREATE TABLE probe (id INTEGER);\n-- stable\n")
	crlf := bytes.ReplaceAll(lf, []byte("\n"), []byte("\r\n"))
	if got, want := migrationChecksum(crlf), migrationChecksum(lf); got != want {
		t.Fatalf("line-ending checksum = %q, want %q", got, want)
	}
}

func TestMigrateFreshDatabaseReusesBaselineAcrossAppReleases(t *testing.T) {
	db := openMigrationManagerDB(t)
	if err := MigrateFS(db, migrations.Files, "v0.5.1"); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	var current, baseline int
	var baselineChecksum, dirty string
	if err := db.QueryRow(`
		SELECT current_version, baseline_version, baseline_checksum, COALESCE(dirty_version, '')
		FROM schema_state WHERE id = 1
	`).Scan(&current, &baseline, &baselineChecksum, &dirty); err != nil {
		t.Fatal(err)
	}
	if current != latestNumberedMigrationVersion || baseline != latestNumberedMigrationVersion || baselineChecksum == "" || dirty != "" {
		t.Fatalf("schema state = current %d, baseline %d, checksum %q, dirty %q; want %d/%d/non-empty/empty", current, baseline, baselineChecksum, dirty, latestNumberedMigrationVersion, latestNumberedMigrationVersion)
	}

	var historyCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migration").Scan(&historyCount); err != nil {
		t.Fatal(err)
	}
	if historyCount != 1 {
		t.Fatalf("migration history count = %d, want baseline only", historyCount)
	}
	var filename string
	if err := db.QueryRow("SELECT filename FROM schema_migration WHERE version = ?", latestNumberedMigrationVersion).Scan(&filename); err != nil {
		t.Fatal(err)
	}
	if filename != "baseline/032_v0.5.0.sql" {
		t.Fatalf("baseline history filename = %q", filename)
	}
}

func TestMigrateUpgradesExistingDatabaseThroughNumberedChain(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	previousCatalog := copyNumberedMigrations(t, sourceDir)
	if err := os.Remove(filepath.Join(previousCatalog, "032_shared_availability_watch.sql")); err != nil {
		t.Fatal(err)
	}

	db := openMigrationManagerDB(t)
	if err := Migrate(db, previousCatalog); err != nil {
		t.Fatalf("create existing database: %v", err)
	}
	var before int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migration").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if before != latestNumberedMigrationVersion-1 {
		t.Fatalf("existing migration history count = %d, want %d", before, latestNumberedMigrationVersion-1)
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatalf("upgrade existing database: %v", err)
	}
	var after int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migration").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != latestNumberedMigrationVersion {
		t.Fatalf("upgraded migration history count = %d, want %d", after, latestNumberedMigrationVersion)
	}
	var filename string
	if err := db.QueryRow("SELECT filename FROM schema_migration WHERE version = ?", latestNumberedMigrationVersion).Scan(&filename); err != nil {
		t.Fatal(err)
	}
	if filename != "032_shared_availability_watch.sql" {
		t.Fatalf("applied migration = %q, want 032_shared_availability_watch.sql", filename)
	}
}

func TestMigrateUpgradesRetiredBaselineLedger(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	for _, testCase := range []struct {
		name            string
		baseline        string
		previousVersion int
		wantHistory     string
	}{
		{
			name:            "schema version 031 applies the remaining numbered migration",
			baseline:        "baseline/031_current.sql",
			previousVersion: 31,
			wantHistory:     "baseline/031_current.sql,032_shared_availability_watch.sql",
		},
		{
			name:            "schema version 032 remains valid without replaying migrations",
			baseline:        "baseline/032_current.sql",
			previousVersion: 32,
			wantHistory:     "baseline/032_current.sql",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			previousCatalog := copyNumberedMigrations(t, sourceDir)
			if testCase.previousVersion < latestNumberedMigrationVersion {
				if err := os.Remove(filepath.Join(previousCatalog, "032_shared_availability_watch.sql")); err != nil {
					t.Fatal(err)
				}
			}

			db := openMigrationManagerDB(t)
			if err := Migrate(db, previousCatalog); err != nil {
				t.Fatalf("create schema version %03d database: %v", testCase.previousVersion, err)
			}
			replaceMigrationHistoryWithRetiredBaseline(t, db, testCase.baseline)
			if err := Migrate(db, sourceDir); err != nil {
				t.Fatalf("upgrade retired baseline ledger: %v", err)
			}

			rows, err := db.Query("SELECT filename FROM schema_migration ORDER BY version")
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			var filenames []string
			for rows.Next() {
				var filename string
				if err := rows.Scan(&filename); err != nil {
					t.Fatal(err)
				}
				filenames = append(filenames, filename)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(filenames, ","); got != testCase.wantHistory {
				t.Fatalf("upgraded migration history = %q, want %q", got, testCase.wantHistory)
			}
		})
	}
}

func TestMigrateCanRerunOnSingleConnectionMemoryDatabase(t *testing.T) {
	db, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := MigrateFS(db, migrations.Files, "memory-first"); err != nil {
		t.Fatalf("first MigrateFS() error = %v", err)
	}
	if err := MigrateFS(db, migrations.Files, "memory-second"); err != nil {
		t.Fatalf("second MigrateFS() error = %v", err)
	}
}

func TestMigrateAdoptsLegacyMigrationLedger(t *testing.T) {
	db := openMigrationManagerDB(t)
	migrationDir := filepath.Join("..", "..", "migrations")
	initialSQL, err := os.ReadFile(filepath.Join(migrationDir, "001_initial.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(initialSQL)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		CREATE TABLE schema_migration (
			filename TEXT PRIMARY KEY,
			applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO schema_migration (filename) VALUES ('001_initial.sql');
	`); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("Migrate() legacy ledger error = %v", err)
	}
	var current, history int
	if err := db.QueryRow("SELECT current_version FROM schema_state WHERE id = 1").Scan(&current); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migration WHERE checksum <> '' AND version IS NOT NULL").Scan(&history); err != nil {
		t.Fatal(err)
	}
	if current != latestNumberedMigrationVersion || history != latestNumberedMigrationVersion {
		t.Fatalf("adopted legacy state = version %d, checksummed history %d; want %d/%d", current, history, latestNumberedMigrationVersion, latestNumberedMigrationVersion)
	}
}

func TestMigrateBaselineMatchesCompleteIncrementalChain(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	incrementalDir := copyNumberedMigrations(t, migrationDir)

	incremental := openMigrationManagerDB(t)
	if err := Migrate(incremental, incrementalDir); err != nil {
		t.Fatalf("incremental Migrate() error = %v", err)
	}
	baseline := openMigrationManagerDB(t)
	if err := Migrate(baseline, migrationDir); err != nil {
		t.Fatalf("baseline Migrate() error = %v", err)
	}

	if got, want := schemaSnapshot(t, baseline), schemaSnapshot(t, incremental); !equalStringMaps(got, want) {
		t.Fatalf("baseline schema differs from complete incremental chain\n%s", diffStringMaps(got, want))
	}
	if got, want := dataSnapshot(t, baseline), dataSnapshot(t, incremental); !equalStringMaps(got, want) {
		t.Fatalf("baseline seed data differs from complete incremental chain\n%s", diffStringMaps(got, want))
	}
}

func TestMigrateLocalizedMetadataDeduplicatesLegacySnapshots(t *testing.T) {
	migrationDir := copyNumberedMigrations(t, filepath.Join("..", "..", "migrations"))
	if err := os.Remove(filepath.Join(migrationDir, "031_dlsite_localized_metadata.sql")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(migrationDir, "032_shared_availability_watch.sql")); err != nil {
		t.Fatal(err)
	}
	db := openMigrationManagerDB(t)
	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("pre-localized migration error = %v", err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Legacy title')")
	if err != nil {
		t.Fatal(err)
	}
	workID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	result, err = db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ00000000')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, metadata_language, is_canonical)
		VALUES (?, ?, ?, 'RJ00000000', 'JPN', 1)
	`, workID, logicalID, providerID); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 3; index++ {
		if _, err := db.Exec(`
			INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
			VALUES (?, ?, 'RJ00000000', ?)
		`, workID, providerID, fmt.Sprintf(`{"product_name":"legacy-%d"}`, index)); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatalf("localized migration error = %v", err)
	}
	var variants, snapshots int
	if err := db.QueryRow("SELECT COUNT(*) FROM dlsite_metadata_variant").Scan(&variants); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot WHERE work_id = ?", workID).Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if variants != 1 || snapshots != 2 {
		t.Fatalf("legacy localized migration rows = variants %d snapshots %d, want 1/2", variants, snapshots)
	}
}

func TestMigrateSharedAvailabilityWatchMergesTargetsAndPausesConflictingSchedule(t *testing.T) {
	migrationDir := copyNumberedMigrations(t, filepath.Join("..", "..", "migrations"))
	if err := os.Remove(filepath.Join(migrationDir, "032_shared_availability_watch.sql")); err != nil {
		t.Fatal(err)
	}
	db := openMigrationManagerDB(t)
	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("pre-shared Availability Watch migration error = %v", err)
	}
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-one', 'admin')`,
		`INSERT INTO user_account (id, username, role) VALUES (2, 'watch-two', 'admin')`,
		`INSERT INTO availability_watch (id, owner_user_id, enabled, interval_minutes, action, exclude_extensions_json, updated_at) VALUES (1, 1, 1, 60, 'monitor', '["wav"]', '2026-01-01 00:00:00')`,
		`INSERT INTO availability_watch (id, owner_user_id, enabled, interval_minutes, action, exclude_extensions_json, updated_at) VALUES (2, 2, 1, 90, 'track', '["flac"]', '2026-01-02 00:00:00')`,
		`INSERT INTO availability_watch_target (watch_id, work_code, state) VALUES (1, 'RJ00000000', 'monitoring')`,
		`INSERT INTO availability_watch_target (watch_id, work_code, state) VALUES (2, 'RJ00000000', 'ready')`,
		`INSERT INTO availability_watch_target (watch_id, work_code, state) VALUES (2, 'RJ00000001', 'monitoring')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatalf("shared Availability Watch migration error = %v", err)
	}
	var watchID, configuredBy, interval, enabled int
	var action string
	if err := db.QueryRow(`
		SELECT watch.id, watch.configured_by_user_id, watch.action,
			CAST(json_extract(trigger.schedule_json, '$.intervalMinutes') AS INTEGER), trigger.enabled
		FROM availability_watch AS watch
		INNER JOIN workflow_definition AS definition ON definition.code = 'availability_watch'
		INNER JOIN workflow_trigger AS trigger ON trigger.workflow_definition_id = definition.id
		WHERE trigger.trigger_type = 'schedule'
	`).Scan(&watchID, &configuredBy, &action, &interval, &enabled); err != nil {
		t.Fatal(err)
	}
	if watchID != 1 || configuredBy != 2 || action != "track" || interval != 90 || enabled != 0 {
		t.Fatalf("shared watch = id %d owner %d action %q interval %d enabled %d", watchID, configuredBy, action, interval, enabled)
	}
	var targets int
	if err := db.QueryRow(`SELECT COUNT(*) FROM availability_watch_target WHERE watch_id = 1 AND active = 1`).Scan(&targets); err != nil {
		t.Fatal(err)
	}
	if targets != 2 {
		t.Fatalf("active merged targets = %d, want 2", targets)
	}
}

func TestMigrateRejectsChangedAppliedMigration(t *testing.T) {
	migrationDir := copyNumberedMigrations(t, filepath.Join("..", "..", "migrations"))
	db := openMigrationManagerDB(t)
	if err := Migrate(db, migrationDir); err != nil {
		t.Fatalf("initial Migrate() error = %v", err)
	}
	path := filepath.Join(migrationDir, "030_media_cleanup_hardening.sql")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(contents, []byte("\n-- changed after release\n")...), 0o600); err != nil {
		t.Fatal(err)
	}

	err = Migrate(db, migrationDir)
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("Migrate() after changing an applied migration error = %v, want checksum refusal", err)
	}
}

func TestMigrateRejectsFutureSchema(t *testing.T) {
	db := openMigrationManagerDB(t)
	if err := Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatalf("initial Migrate() error = %v", err)
	}
	if _, err := db.Exec("UPDATE schema_state SET current_version = ? WHERE id = 1", latestNumberedMigrationVersion+1); err != nil {
		t.Fatal(err)
	}

	err := Migrate(db, filepath.Join("..", "..", "migrations"))
	if err == nil || !strings.Contains(err.Error(), "newer than this binary supports") {
		t.Fatalf("Migrate() with future schema error = %v, want future-schema refusal", err)
	}
}

func TestMigrateRetainsDirtyStateAndRetriesFailedMigration(t *testing.T) {
	migrationDir := t.TempDir()
	writeMigration(t, migrationDir, "001_create_probe.sql", "CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);")
	writeMigration(t, migrationDir, "002_failed_probe.sql", "INSERT INTO probe (value) VALUES ('rolled back'); SELECT no_such_table.value FROM no_such_table;")
	writeMigration(t, migrationDir, "003_add_probe_index.sql", "CREATE INDEX idx_probe_value ON probe(value);")
	db := openMigrationManagerDB(t)

	err := MigrateFS(db, os.DirFS(migrationDir), "test-failing-start")
	if err == nil {
		t.Fatal("MigrateFS() unexpectedly succeeded with failing migration")
	}
	var current int
	var dirty sql.NullInt64
	if err := db.QueryRow("SELECT current_version, dirty_version FROM schema_state WHERE id = 1").Scan(&current, &dirty); err != nil {
		t.Fatal(err)
	}
	if current != 1 || !dirty.Valid || dirty.Int64 != 2 {
		t.Fatalf("failed migration state = current %d, dirty %v; want 1/2", current, dirty)
	}
	var probeRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM probe").Scan(&probeRows); err != nil {
		t.Fatal(err)
	}
	if probeRows != 0 {
		t.Fatalf("failed migration left %d probe rows, want rollback", probeRows)
	}

	writeMigration(t, migrationDir, "002_failed_probe.sql", "INSERT INTO probe (value) VALUES ('recovered');")
	if err := MigrateFS(db, os.DirFS(migrationDir), "test-retry"); err != nil {
		t.Fatalf("retry MigrateFS() error = %v", err)
	}
	if err := db.QueryRow("SELECT current_version FROM schema_state WHERE id = 1").Scan(&current); err != nil {
		t.Fatal(err)
	}
	if current != 3 {
		t.Fatalf("recovered schema version = %d, want 3", current)
	}
	if err := db.QueryRow("SELECT dirty_version FROM schema_state WHERE id = 1").Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if dirty.Valid {
		t.Fatalf("dirty migration after retry = %v, want NULL", dirty)
	}
	var recoveredValue string
	if err := db.QueryRow("SELECT value FROM probe").Scan(&recoveredValue); err != nil {
		t.Fatal(err)
	}
	if recoveredValue != "recovered" {
		t.Fatalf("recovered probe value = %q, want recovered", recoveredValue)
	}

	if err := RecordSuccessfulStart(db, "v-test"); err != nil {
		t.Fatalf("RecordSuccessfulStart() error = %v", err)
	}
	var successful string
	if err := db.QueryRow("SELECT last_successful_app_version FROM schema_state WHERE id = 1").Scan(&successful); err != nil {
		t.Fatal(err)
	}
	if successful != "v-test" {
		t.Fatalf("last successful app version = %q, want v-test", successful)
	}
}

func TestMigrateDoesNotAbandonFailedBaselineWhenCatalogChanges(t *testing.T) {
	migrationDir := t.TempDir()
	writeMigration(t, migrationDir, "001_create_probe.sql", "CREATE TABLE probe (id INTEGER PRIMARY KEY);")
	writeMigration(t, migrationDir, "002_add_probe_index.sql", "CREATE INDEX idx_probe_id ON probe(id);")
	if err := os.Mkdir(filepath.Join(migrationDir, "baseline"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeMigration(t, filepath.Join(migrationDir, "baseline"), "002_v0.5.0.sql", "CREATE TABLE probe (id INTEGER PRIMARY KEY); SELECT no_such_table.value FROM no_such_table;")
	db := openMigrationManagerDB(t)
	if err := MigrateFS(db, os.DirFS(migrationDir), "baseline-failure"); err == nil {
		t.Fatal("MigrateFS() unexpectedly succeeded with failing baseline")
	}
	if err := os.Remove(filepath.Join(migrationDir, "baseline", "002_v0.5.0.sql")); err != nil {
		t.Fatal(err)
	}
	err := MigrateFS(db, os.DirFS(migrationDir), "baseline-removed")
	if err == nil || !strings.Contains(err.Error(), "dirty migration") {
		t.Fatalf("MigrateFS() after removing failed baseline error = %v, want dirty-state refusal", err)
	}
}

func TestMigrateRefusesUntrackedApplicationSchema(t *testing.T) {
	db := openMigrationManagerDB(t)
	if _, err := db.Exec("CREATE TABLE untracked_application_state (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	err := Migrate(db, filepath.Join("..", "..", "migrations"))
	if err == nil || !strings.Contains(err.Error(), "no migration history") {
		t.Fatalf("Migrate() with untracked application schema error = %v", err)
	}
}

func TestMigrateRefusesEmptyHistoryForApplicationSchema(t *testing.T) {
	db := openMigrationManagerDB(t)
	if _, err := db.Exec(`
		CREATE TABLE user_created_state (id INTEGER PRIMARY KEY);
		CREATE TABLE schema_migration (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
	`); err != nil {
		t.Fatal(err)
	}
	err := Migrate(db, filepath.Join("..", "..", "migrations"))
	if err == nil || !strings.Contains(err.Error(), "migration history is empty") {
		t.Fatalf("Migrate() with empty history error = %v", err)
	}
}

func TestMigrateConcurrentStartupIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "concurrent-migration.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()

	results := make(chan error, 2)
	go func() { results <- MigrateFS(first, migrations.Files, "concurrent-first") }()
	go func() { results <- MigrateFS(second, migrations.Files, "concurrent-second") }()
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatalf("concurrent MigrateFS() error = %v", err)
		}
	}
	var current, history int
	if err := first.QueryRow("SELECT current_version FROM schema_state WHERE id = 1").Scan(&current); err != nil {
		t.Fatal(err)
	}
	if err := first.QueryRow("SELECT COUNT(*) FROM schema_migration").Scan(&history); err != nil {
		t.Fatal(err)
	}
	if current != latestNumberedMigrationVersion || history != 1 {
		t.Fatalf("concurrent migration state = version %d, history %d; want %d/1", current, history, latestNumberedMigrationVersion)
	}
}

func openMigrationManagerDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "migration-manager.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func copyNumberedMigrations(t *testing.T, sourceDir string) string {
	t.Helper()
	destination := t.TempDir()
	entries, err := os.ReadDir(sourceDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !numberedMigrationFilePattern.MatchString(entry.Name()) {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(sourceDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(destination, entry.Name()), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return destination
}

func writeMigration(t *testing.T, dir, filename, contents string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func replaceMigrationHistoryWithRetiredBaseline(t *testing.T, db *sql.DB, filename string) {
	t.Helper()
	var baseline migrationAsset
	for _, candidate := range retiredBaselineLedgerAssets {
		if candidate.filename == filename {
			baseline = candidate
			break
		}
	}
	if baseline.filename == "" {
		t.Fatalf("retired baseline %q is not declared", filename)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM schema_migration"); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`
		INSERT INTO schema_migration (filename, version, checksum, app_version, duration_ms)
		VALUES (?, ?, ?, 'retired-baseline', 0)
	`, baseline.filename, baseline.version, baseline.checksum); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(`
		UPDATE schema_state
		SET current_version = ?, baseline_version = ?, baseline_checksum = ?, dirty_version = NULL
		WHERE id = 1
	`, baseline.version, baseline.version, baseline.checksum); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func schemaSnapshot(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	rows, err := db.Query(`
		SELECT type, name, sql
		FROM sqlite_schema
		WHERE sql IS NOT NULL
		  AND name NOT LIKE 'sqlite_%'
		  AND name NOT IN ('schema_migration', 'schema_state')
	`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	snapshot := make(map[string]string)
	for rows.Next() {
		var kind, name, definition string
		if err := rows.Scan(&kind, &name, &definition); err != nil {
			t.Fatal(err)
		}
		snapshot[kind+":"+name] = normalizeSQL(definition)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func dataSnapshot(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	tables := applicationTables(t, db)
	snapshot := make(map[string]string)
	for _, table := range tables {
		columns := tableInfo(t, db, table)
		var names []string
		for _, column := range columns {
			if !strings.Contains(strings.ToUpper(column.defaultValue), "CURRENT_TIMESTAMP") {
				names = append(names, quoteIdentifierForTest(column.name))
			}
		}
		query := "SELECT " + strings.Join(names, ", ") + " FROM " + quoteIdentifierForTest(table)
		rows, err := db.Query(query)
		if err != nil {
			t.Fatal(err)
		}
		var values []string
		for rows.Next() {
			row := make([]any, len(names))
			pointers := make([]any, len(row))
			for i := range row {
				pointers[i] = &row[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				rows.Close()
				t.Fatal(err)
			}
			parts := make([]string, len(row))
			for i, value := range row {
				parts[i] = fmt.Sprintf("%T:%v", value, value)
			}
			values = append(values, strings.Join(parts, "|"))
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
		sort.Strings(values)
		snapshot[table] = strings.Join(values, "\n")
	}
	return snapshot
}

type testColumn struct {
	name         string
	defaultValue string
}

func applicationTables(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`
		SELECT name FROM sqlite_schema
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		  AND name NOT IN ('schema_migration', 'schema_state')
		ORDER BY name
	`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, table)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return tables
}

func tableInfo(t *testing.T, db *sql.DB, table string) []testColumn {
	t.Helper()
	rows, err := db.Query("PRAGMA table_info(" + quoteIdentifierForTest(table) + ")")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var columns []testColumn
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			t.Fatal(err)
		}
		if defaultValue.Valid {
			columns = append(columns, testColumn{name: name, defaultValue: defaultValue.String})
		} else {
			columns = append(columns, testColumn{name: name})
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return columns
}

func quoteIdentifierForTest(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func normalizeSQL(value string) string {
	return strings.Join(strings.Fields(strings.ToLower(value)), " ")
}

func equalStringMaps(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func diffStringMaps(left, right map[string]string) string {
	keys := make(map[string]struct{}, len(left)+len(right))
	for key := range left {
		keys[key] = struct{}{}
	}
	for key := range right {
		keys[key] = struct{}{}
	}
	var ordered []string
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	var differences []string
	for _, key := range ordered {
		if left[key] != right[key] {
			differences = append(differences, fmt.Sprintf("%s:\n  left: %q\n  right: %q", key, left[key], right[key]))
		}
	}
	return strings.Join(differences, "\n")
}
