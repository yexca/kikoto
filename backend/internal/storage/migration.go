package storage

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
)

const (
	migrationTable = "schema_migration"
	schemaStateID  = 1
)

var (
	migrationFilenamePattern = regexp.MustCompile(`^([0-9]{3})_[a-z0-9][a-z0-9_]*\.sql$`)
	baselineFilenamePattern  = regexp.MustCompile(`^([0-9]{3})_v[0-9]+\.[0-9]+\.[0-9]+\.sql$`)
)

type migrationAsset struct {
	version  int
	filename string
	checksum string
	sql      []byte
	baseline bool
}

// retiredBaselineLedgerAssets keeps existing development databases upgradeable
// after their pre-release baseline SQL snapshots are removed. These entries
// validate a recorded ledger row only; fresh databases can use only a packaged
// baseline file, which may have been produced by an earlier app release when
// the numbered SQL chain has not changed.
var retiredBaselineLedgerAssets = []migrationAsset{
	{
		version:  31,
		filename: "baseline/031_current.sql",
		checksum: "acdfad4639ff583b908f22d27e772261c675f233a671ecceae511a3e150ce77e",
		baseline: true,
	},
	{
		version:  32,
		filename: "baseline/032_current.sql",
		checksum: "6de662434d1520b2b78873d146252782ae32e59b6113f79007fa3dd4fee2b744",
		baseline: true,
	},
}

type migrationCatalog struct {
	migrations []migrationAsset
	byFilename map[string]migrationAsset
	baseline   *migrationAsset
	current    int
}

type migrationHistory struct {
	current         int
	hasRecords      bool
	baselineVersion int
	baselineHash    string
}

type schemaState struct {
	currentVersion  int
	baselineVersion int
	baselineHash    string
	dirtyVersion    sql.NullInt64
}

// Migrate applies migrations from a filesystem directory. Tests use this
// entry point to construct databases at historical migration boundaries.
func Migrate(db *sql.DB, dir string) error {
	return MigrateFS(db, os.DirFS(dir), buildinfo.Version)
}

// MigrateFS validates and applies a migration catalog. Pristine databases use
// the highest-version packaged baseline snapshot; existing databases continue
// through the immutable numbered chain. The baseline's release suffix does not
// need to match appVersion when no numbered SQL changed.
func MigrateFS(db *sql.DB, migrationFS fs.FS, appVersion string) error {
	if db == nil {
		return errors.New("migrate database: nil database")
	}
	if migrationFS == nil {
		return errors.New("migrate database: nil migration filesystem")
	}
	catalog, classification, err := prepareMigrationCatalog(db, migrationFS)
	if err != nil {
		return err
	}
	history, state, err := prepareMigrationState(db, catalog, classification)
	if err != nil {
		return err
	}
	state, applied, err := applyMigrationCatalog(db, catalog, classification, history, state, appVersion)
	if err != nil {
		return err
	}

	if state.currentVersion != catalog.current {
		return fmt.Errorf("database schema version is %d after migration, want %d", state.currentVersion, catalog.current)
	}
	if applied {
		if err := verifyForeignKeys(db); err != nil {
			return err
		}
	}
	return nil
}

func prepareMigrationCatalog(db *sql.DB, migrationFS fs.FS) (migrationCatalog, databaseClassification, error) {
	catalog, err := loadMigrationCatalog(migrationFS)
	if err != nil {
		return migrationCatalog{}, databaseClassification{}, err
	}
	classification, err := classifyDatabase(db)
	if err != nil {
		return migrationCatalog{}, databaseClassification{}, err
	}
	if classification.futureVersion > catalog.current {
		return migrationCatalog{}, databaseClassification{}, fmt.Errorf(
			"database schema version %d is newer than this binary supports (%d); use a compatible Kikoto version",
			classification.futureVersion, catalog.current,
		)
	}
	if classification.hasApplicationTables && !classification.hasMigrationTable {
		return migrationCatalog{}, databaseClassification{}, errors.New("database contains Kikoto tables but has no migration history; refusing to infer a schema version")
	}
	if err := ensureMigrationMetadata(db); err != nil {
		return migrationCatalog{}, databaseClassification{}, err
	}
	return catalog, classification, nil
}

func prepareMigrationState(db *sql.DB, catalog migrationCatalog, classification databaseClassification) (migrationHistory, schemaState, error) {
	baselineVersion := 0
	if catalog.baseline != nil {
		baselineVersion = catalog.baseline.version
	}
	var history migrationHistory
	var state schemaState
	// A second process may commit the ledger and state between these reads.
	// Revalidate once so concurrent startup observes one coherent checkpoint.
	for attempt := 0; attempt < 2; attempt++ {
		var err error
		history, err = validateAndAdoptHistory(db, catalog)
		if err != nil {
			return migrationHistory{}, schemaState{}, err
		}
		if classification.hasApplicationTables && !history.hasRecords {
			return migrationHistory{}, schemaState{}, errors.New("database contains Kikoto tables but migration history is empty; refusing to infer a schema version")
		}
		state, err = ensureSchemaState(db, history, catalog.current, baselineVersion)
		if err == nil {
			return history, state, nil
		}
		if attempt == 0 && isConcurrentStateMismatch(err) {
			continue
		}
		return migrationHistory{}, schemaState{}, err
	}
	return migrationHistory{}, schemaState{}, errors.New("could not establish migration state")
}

func applyMigrationCatalog(db *sql.DB, catalog migrationCatalog, classification databaseClassification, history migrationHistory, state schemaState, appVersion string) (schemaState, bool, error) {
	applied := false
	if history.current == 0 && !classification.hasApplicationTables && catalog.baseline != nil {
		changed, err := applyMigrationAsset(db, *catalog.baseline, state.currentVersion, appVersion)
		if err != nil {
			return state, false, err
		}
		applied = applied || changed
		if changed {
			state.currentVersion = catalog.baseline.version
			state.baselineVersion = catalog.baseline.version
			state.baselineHash = catalog.baseline.checksum
		} else {
			state, err = readSchemaState(db)
			if err != nil {
				return state, false, err
			}
		}
	}
	for _, migration := range catalog.migrations {
		if migration.version <= state.currentVersion {
			continue
		}
		if migration.version != state.currentVersion+1 {
			return state, false, fmt.Errorf(
				"migration history ends at %03d but the next available migration is %03d (%s)",
				state.currentVersion, migration.version, migration.filename,
			)
		}
		changed, err := applyMigrationAsset(db, migration, state.currentVersion, appVersion)
		if err != nil {
			return state, false, err
		}
		applied = applied || changed
		if changed {
			state.currentVersion = migration.version
			continue
		}
		state, err = readSchemaState(db)
		if err != nil {
			return state, false, err
		}
	}
	return state, applied, nil
}

func isConcurrentStateMismatch(err error) bool {
	message := err.Error()
	return strings.Contains(message, "schema state records version") ||
		strings.Contains(message, "schema baseline state does not match migration history")
}

// RecordSuccessfulStart records an application version only after startup has
// completed its migration and bootstrap gates.
func RecordSuccessfulStart(db *sql.DB, appVersion string) error {
	if db == nil {
		return errors.New("record successful application start: nil database")
	}
	result, err := db.Exec(`
		UPDATE schema_state
		SET last_successful_app_version = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, appVersion, schemaStateID)
	if err != nil {
		return fmt.Errorf("record successful application start: %w", err)
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("record successful application start: %w", err)
	}
	if updated != 1 {
		return errors.New("record successful application start: schema state is missing")
	}
	return nil
}

func loadMigrationCatalog(migrationFS fs.FS) (migrationCatalog, error) {
	migrations, _, err := loadNumberedMigrationAssets(migrationFS)
	if err != nil {
		return migrationCatalog{}, err
	}
	catalog := migrationCatalog{byFilename: make(map[string]migrationAsset)}
	for _, asset := range migrations {
		catalog.migrations = append(catalog.migrations, asset)
		catalog.byFilename[asset.filename] = asset
	}
	if len(catalog.migrations) == 0 {
		return migrationCatalog{}, errors.New("migration catalog contains no numbered SQL files")
	}
	sort.Slice(catalog.migrations, func(i, j int) bool {
		return catalog.migrations[i].version < catalog.migrations[j].version
	})
	if err := validateMigrationSequence(catalog.migrations); err != nil {
		return migrationCatalog{}, err
	}
	catalog.current = catalog.migrations[len(catalog.migrations)-1].version

	baselines, err := loadMigrationBaselines(migrationFS, catalog.current)
	if err != nil {
		return migrationCatalog{}, err
	}
	for index := range baselines {
		baseline := baselines[index]
		catalog.byFilename[baseline.filename] = baseline
	}
	for _, baseline := range retiredBaselineLedgerAssets {
		if baseline.version <= catalog.current {
			catalog.byFilename[baseline.filename] = baseline
		}
	}
	if len(baselines) > 0 {
		catalog.baseline = &baselines[len(baselines)-1]
	}
	return catalog, nil
}

func loadNumberedMigrationAssets(migrationFS fs.FS) ([]migrationAsset, map[int]string, error) {
	entries, err := fs.ReadDir(migrationFS, ".")
	if err != nil {
		return nil, nil, fmt.Errorf("read migrations: %w", err)
	}
	assets := []migrationAsset{}
	versions := map[int]string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		matches := migrationFilenamePattern.FindStringSubmatch(entry.Name())
		if matches == nil {
			return nil, nil, fmt.Errorf("invalid migration filename %q", entry.Name())
		}
		version, _ := strconv.Atoi(matches[1])
		if previous, exists := versions[version]; exists {
			return nil, nil, fmt.Errorf("migration version %03d is used by both %s and %s", version, previous, entry.Name())
		}
		asset, err := readMigrationAsset(migrationFS, entry.Name(), version, false)
		if err != nil {
			return nil, nil, err
		}
		versions[version] = entry.Name()
		assets = append(assets, asset)
	}
	return assets, versions, nil
}

func validateMigrationSequence(migrations []migrationAsset) error {
	for index, migration := range migrations {
		expected := index + 1
		if migration.version != expected {
			return fmt.Errorf("migration catalog has a gap: expected version %03d, found %03d", expected, migration.version)
		}
	}
	return nil
}

func loadMigrationBaselines(migrationFS fs.FS, currentVersion int) ([]migrationAsset, error) {
	entries, err := fs.ReadDir(migrationFS, "baseline")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read migration baselines: %w", err)
	}
	baselines := []migrationAsset{}
	versions := map[int]string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		matches := baselineFilenamePattern.FindStringSubmatch(entry.Name())
		if matches == nil {
			return nil, fmt.Errorf("invalid migration baseline filename %q", entry.Name())
		}
		version, _ := strconv.Atoi(matches[1])
		if version == 0 {
			return nil, errors.New("migration baseline version must be greater than zero")
		}
		if version > currentVersion {
			return nil, fmt.Errorf("migration baseline version %03d exceeds current version %03d", version, currentVersion)
		}
		if previous, exists := versions[version]; exists {
			return nil, fmt.Errorf("migration baseline version %03d is used by both %s and %s", version, previous, entry.Name())
		}
		asset, err := readMigrationAsset(migrationFS, "baseline/"+entry.Name(), version, true)
		if err != nil {
			return nil, err
		}
		versions[version] = entry.Name()
		baselines = append(baselines, asset)
	}
	sort.Slice(baselines, func(i, j int) bool { return baselines[i].version < baselines[j].version })
	return baselines, nil
}

func readMigrationAsset(migrationFS fs.FS, filename string, version int, baseline bool) (migrationAsset, error) {
	contents, err := fs.ReadFile(migrationFS, filename)
	if err != nil {
		return migrationAsset{}, fmt.Errorf("read migration %s: %w", filename, err)
	}
	if len(bytes.TrimSpace(contents)) == 0 {
		return migrationAsset{}, fmt.Errorf("migration %s is empty", filename)
	}
	checksum := migrationChecksum(contents)
	return migrationAsset{version: version, filename: filename, checksum: checksum, sql: contents, baseline: baseline}, nil
}

func migrationChecksum(contents []byte) string {
	return fmt.Sprintf("%x", sha256.Sum256(canonicalMigrationBytes(contents)))
}

func canonicalMigrationBytes(contents []byte) []byte {
	contents = bytes.ReplaceAll(contents, []byte("\r\n"), []byte("\n"))
	return bytes.ReplaceAll(contents, []byte("\r"), []byte("\n"))
}

type databaseClassification struct {
	hasApplicationTables bool
	hasMigrationTable    bool
	futureVersion        int
}

func classifyDatabase(db *sql.DB) (databaseClassification, error) {
	rows, err := db.Query(`
		SELECT name
		FROM sqlite_schema
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
	`)
	if err != nil {
		return databaseClassification{}, fmt.Errorf("inspect database schema: %w", err)
	}
	classification := databaseClassification{}
	hasStateTable := false
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return databaseClassification{}, fmt.Errorf("inspect database schema: %w", err)
		}
		switch name {
		case migrationTable:
			classification.hasMigrationTable = true
		case "schema_state":
			hasStateTable = true
		default:
			classification.hasApplicationTables = true
		}
	}
	if err := rows.Err(); err != nil {
		return databaseClassification{}, fmt.Errorf("inspect database schema: %w", err)
	}
	if err := rows.Close(); err != nil {
		return databaseClassification{}, fmt.Errorf("inspect database schema: %w", err)
	}
	if hasStateTable {
		if err := db.QueryRow("SELECT current_version FROM schema_state WHERE id = ?", schemaStateID).Scan(&classification.futureVersion); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return databaseClassification{}, fmt.Errorf("read schema state: %w", err)
		}
	}
	return classification, nil
}

func ensureMigrationMetadata(db *sql.DB) error {
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migration (
			filename TEXT PRIMARY KEY,
			version INTEGER,
			checksum TEXT NOT NULL DEFAULT '',
			app_version TEXT NOT NULL DEFAULT '',
			duration_ms INTEGER NOT NULL DEFAULT 0,
			applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration history: %w", err)
	}
	columns, err := tableColumns(db, migrationTable)
	if err != nil {
		return err
	}
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "version", definition: "INTEGER"},
		{name: "checksum", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "app_version", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "duration_ms", definition: "INTEGER NOT NULL DEFAULT 0"},
	} {
		if columns[column.name] {
			continue
		}
		if _, err := db.Exec("ALTER TABLE schema_migration ADD COLUMN " + column.name + " " + column.definition); err != nil {
			// Another process may have added the column after the initial
			// inspection. Re-read before treating the duplicate as a failure.
			latest, inspectErr := tableColumns(db, migrationTable)
			if inspectErr == nil && latest[column.name] {
				columns = latest
				continue
			}
			return fmt.Errorf("add schema_migration.%s: %w", column.name, err)
		}
		columns[column.name] = true
	}
	if _, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_state (
			id INTEGER PRIMARY KEY CHECK(id = 1),
			current_version INTEGER NOT NULL DEFAULT 0 CHECK(current_version >= 0),
			baseline_version INTEGER NOT NULL DEFAULT 0 CHECK(baseline_version >= 0),
			baseline_checksum TEXT NOT NULL DEFAULT '',
			dirty_version INTEGER CHECK(dirty_version > 0),
			last_migration_app_version TEXT NOT NULL DEFAULT '',
			last_successful_app_version TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create schema state: %w", err)
	}
	return nil
}

func tableColumns(db *sql.DB, table string) (map[string]bool, error) {
	rows, err := db.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return nil, fmt.Errorf("inspect %s columns: %w", table, err)
	}
	defer rows.Close()
	columns := make(map[string]bool)
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, columnType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return nil, fmt.Errorf("inspect %s columns: %w", table, err)
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("inspect %s columns: %w", table, err)
	}
	return columns, nil
}

type migrationHistoryRow struct {
	filename string
	version  sql.NullInt64
	checksum string
	asset    migrationAsset
}

func validateAndAdoptHistory(db *sql.DB, catalog migrationCatalog) (migrationHistory, error) {
	historyRows, err := loadMigrationHistoryRows(db, catalog)
	if err != nil {
		return migrationHistory{}, err
	}
	sort.Slice(historyRows, func(i, j int) bool { return historyRows[i].asset.version < historyRows[j].asset.version })
	history, err := adoptMigrationHistoryRows(db, historyRows)
	if err != nil {
		return migrationHistory{}, err
	}
	if err := validateMigrationHistorySequence(historyRows, &history); err != nil {
		return migrationHistory{}, err
	}
	if _, err := db.Exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_migration_version
		ON schema_migration(version)
		WHERE version IS NOT NULL
	`); err != nil {
		return migrationHistory{}, fmt.Errorf("index migration versions: %w", err)
	}
	return history, nil
}

func loadMigrationHistoryRows(db *sql.DB, catalog migrationCatalog) ([]migrationHistoryRow, error) {
	rows, err := db.Query(`
		SELECT filename, version, checksum
		FROM schema_migration
		ORDER BY applied_at, filename
	`)
	if err != nil {
		return nil, fmt.Errorf("read migration history: %w", err)
	}
	defer rows.Close()
	var historyRows []migrationHistoryRow
	for rows.Next() {
		var row migrationHistoryRow
		if err := rows.Scan(&row.filename, &row.version, &row.checksum); err != nil {
			return nil, fmt.Errorf("read migration history: %w", err)
		}
		asset, exists := catalog.byFilename[row.filename]
		if !exists {
			if version := versionFromUnknownFilename(row.filename); version > catalog.current {
				return nil, fmt.Errorf(
					"database migration %s is newer than this binary supports (%03d)",
					row.filename,
					catalog.current,
				)
			}
			return nil, fmt.Errorf("database contains unknown migration record %q", row.filename)
		}
		row.asset = asset
		historyRows = append(historyRows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read migration history: %w", err)
	}
	return historyRows, nil
}

func adoptMigrationHistoryRows(db *sql.DB, historyRows []migrationHistoryRow) (migrationHistory, error) {
	history := migrationHistory{}
	seenVersions := make(map[int]string)
	for _, row := range historyRows {
		history.hasRecords = true
		asset := row.asset
		if previous, exists := seenVersions[asset.version]; exists {
			return migrationHistory{}, fmt.Errorf("database records migration version %03d more than once (%s and %s)", asset.version, previous, row.filename)
		}
		seenVersions[asset.version] = row.filename
		if row.version.Valid && int(row.version.Int64) != asset.version {
			return migrationHistory{}, fmt.Errorf("migration %s records version %d, want %d", row.filename, row.version.Int64, asset.version)
		}
		if row.checksum != "" && row.checksum != asset.checksum {
			return migrationHistory{}, fmt.Errorf("migration %s checksum does not match the packaged migration", row.filename)
		}
		if !row.version.Valid || row.checksum == "" {
			if _, err := db.Exec(`
				UPDATE schema_migration
				SET version = ?, checksum = ?, app_version = CASE WHEN app_version = '' THEN 'legacy' ELSE app_version END
				WHERE filename = ?
			`, asset.version, asset.checksum, row.filename); err != nil {
				return migrationHistory{}, fmt.Errorf("adopt legacy migration %s: %w", row.filename, err)
			}
		}
		if asset.baseline {
			if history.baselineVersion != 0 {
				return migrationHistory{}, errors.New("database records more than one migration baseline")
			}
			history.baselineVersion = asset.version
			history.baselineHash = asset.checksum
		}
	}
	return history, nil
}

func validateMigrationHistorySequence(historyRows []migrationHistoryRow, history *migrationHistory) error {
	if len(historyRows) == 0 {
		return nil
	}
	expected := 1
	if historyRows[0].asset.baseline {
		expected = historyRows[0].asset.version
	}
	for index, row := range historyRows {
		if (index > 0 || !row.asset.baseline) && row.asset.version != expected {
			return fmt.Errorf("database migration history has a gap: expected %03d, found %03d", expected, row.asset.version)
		}
		expected = row.asset.version + 1
		history.current = row.asset.version
	}
	return nil
}

func versionFromUnknownFilename(filename string) int {
	base := filename
	if slash := strings.LastIndex(base, "/"); slash >= 0 {
		base = base[slash+1:]
	}
	underscore := strings.IndexByte(base, '_')
	if underscore <= 0 {
		return 0
	}
	version, _ := strconv.Atoi(base[:underscore])
	return version
}

func ensureSchemaState(db *sql.DB, history migrationHistory, catalogCurrent, catalogBaselineVersion int) (schemaState, error) {
	state, err := readSchemaState(db)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err := db.Exec(`
			INSERT INTO schema_state (
				id, current_version, baseline_version, baseline_checksum
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(id) DO NOTHING
		`, schemaStateID, history.current, history.baselineVersion, history.baselineHash); err != nil {
			return schemaState{}, fmt.Errorf("initialize schema state: %w", err)
		}
		state, err = readSchemaState(db)
		if err != nil {
			return schemaState{}, fmt.Errorf("read initialized schema state: %w", err)
		}
	}
	if err != nil {
		return schemaState{}, fmt.Errorf("read schema state: %w", err)
	}
	if state.currentVersion > catalogCurrent {
		return schemaState{}, fmt.Errorf(
			"database schema version %d is newer than this binary supports (%d); use a compatible Kikoto version",
			state.currentVersion,
			catalogCurrent,
		)
	}
	if state.currentVersion != history.current {
		return schemaState{}, fmt.Errorf("schema state records version %d but migration history ends at %d", state.currentVersion, history.current)
	}
	if state.baselineVersion != history.baselineVersion || state.baselineHash != history.baselineHash {
		return schemaState{}, errors.New("schema baseline state does not match migration history")
	}
	if state.dirtyVersion.Valid {
		dirty := int(state.dirtyVersion.Int64)
		if dirty > catalogCurrent {
			return schemaState{}, fmt.Errorf("database has an unfinished future migration %03d", dirty)
		}
		validNext := dirty == state.currentVersion+1
		validBaselineRetry := state.currentVersion == 0 && history.current == 0 &&
			((catalogBaselineVersion > 0 && dirty == catalogBaselineVersion) ||
				(catalogBaselineVersion == 0 && dirty == 1))
		if !validNext && !validBaselineRetry {
			return schemaState{}, fmt.Errorf("database dirty migration %03d is inconsistent with current version %03d", dirty, state.currentVersion)
		}
	}
	return state, nil
}

func readSchemaState(db *sql.DB) (schemaState, error) {
	var state schemaState
	err := db.QueryRow(`
		SELECT current_version, baseline_version, baseline_checksum, dirty_version
		FROM schema_state
		WHERE id = ?
	`, schemaStateID).Scan(&state.currentVersion, &state.baselineVersion, &state.baselineHash, &state.dirtyVersion)
	if err != nil {
		return schemaState{}, err
	}
	return state, nil
}

func applyMigrationAsset(db *sql.DB, asset migrationAsset, expectedCurrent int, appVersion string) (bool, error) {
	result, err := db.Exec(`
		UPDATE schema_state
		SET dirty_version = ?, last_migration_app_version = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
		  AND current_version = ?
		  AND (dirty_version IS NULL OR dirty_version = ?)
	`, asset.version, appVersion, schemaStateID, expectedCurrent, asset.version)
	if err != nil {
		return false, fmt.Errorf("mark migration %s dirty: %w", asset.filename, err)
	}
	marked, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("mark migration %s dirty: %w", asset.filename, err)
	}
	if marked == 0 {
		var current int
		if err := db.QueryRow("SELECT current_version FROM schema_state WHERE id = ?", schemaStateID).Scan(&current); err != nil {
			return false, fmt.Errorf("read schema state while applying %s: %w", asset.filename, err)
		}
		if current >= asset.version {
			return false, verifyAppliedAsset(db, asset)
		}
	}

	started := time.Now()
	tx, err := db.Begin()
	if err != nil {
		return false, fmt.Errorf("begin migration %s: %w", asset.filename, err)
	}
	rollback := func() { _ = tx.Rollback() }
	var current int
	if err := tx.QueryRow("SELECT current_version FROM schema_state WHERE id = ?", schemaStateID).Scan(&current); err != nil {
		rollback()
		return false, fmt.Errorf("read schema state in migration %s: %w", asset.filename, err)
	}
	if current >= asset.version {
		rollback()
		return false, verifyAppliedAsset(db, asset)
	}
	if current != expectedCurrent {
		rollback()
		return false, fmt.Errorf("migration %s expected schema version %03d, found %03d", asset.filename, expectedCurrent, current)
	}
	if _, err := tx.Exec(string(asset.sql)); err != nil {
		rollback()
		return false, fmt.Errorf("apply %s: %w", asset.filename, err)
	}
	if err := verifyForeignKeys(tx); err != nil {
		rollback()
		return false, fmt.Errorf("verify %s: %w", asset.filename, err)
	}
	duration := time.Since(started).Milliseconds()
	if _, err := tx.Exec(`
		INSERT INTO schema_migration (
			filename, version, checksum, app_version, duration_ms
		) VALUES (?, ?, ?, ?, ?)
	`, asset.filename, asset.version, asset.checksum, appVersion, duration); err != nil {
		rollback()
		return false, fmt.Errorf("record migration %s: %w", asset.filename, err)
	}
	baselineVersion := 0
	baselineHash := ""
	if asset.baseline {
		baselineVersion = asset.version
		baselineHash = asset.checksum
	}
	if _, err := tx.Exec(`
		UPDATE schema_state
		SET current_version = ?,
			baseline_version = CASE WHEN ? > 0 THEN ? ELSE baseline_version END,
			baseline_checksum = CASE WHEN ? > 0 THEN ? ELSE baseline_checksum END,
			dirty_version = NULL,
			last_migration_app_version = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND current_version = ?
	`, asset.version, baselineVersion, baselineVersion, baselineVersion, baselineHash, appVersion, schemaStateID, expectedCurrent); err != nil {
		rollback()
		return false, fmt.Errorf("advance schema state for %s: %w", asset.filename, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit migration %s: %w", asset.filename, err)
	}
	return true, nil
}

type rowQueryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

func verifyAppliedAsset(queryer rowQueryer, asset migrationAsset) error {
	var version int
	var checksum string
	if err := queryer.QueryRow(`
		SELECT version, checksum
		FROM schema_migration
		WHERE filename = ?
	`, asset.filename).Scan(&version, &checksum); err != nil {
		return fmt.Errorf("verify concurrently applied migration %s: %w", asset.filename, err)
	}
	if version != asset.version || checksum != asset.checksum {
		return fmt.Errorf("concurrently applied migration %s does not match the packaged migration", asset.filename)
	}
	return nil
}

type queryer interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func verifyForeignKeys(queryer queryer) error {
	rows, err := queryer.Query("PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("verify migrated foreign keys: %w", err)
	}
	defer rows.Close()
	if rows.Next() {
		var table string
		var rowID sql.NullInt64
		var parent string
		var constraint int
		if err := rows.Scan(&table, &rowID, &parent, &constraint); err != nil {
			return fmt.Errorf("verify migrated foreign keys: %w", err)
		}
		return fmt.Errorf("foreign key check failed after migration: table %s row %v references %s", table, rowID, parent)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("verify migrated foreign keys: %w", err)
	}
	return nil
}
