package storage

import (
	"database/sql"
	"strings"
	"testing"
	"testing/fstest"
)

const (
	probeV1 = "CREATE TABLE probe (id INTEGER PRIMARY KEY);"
	probeV3 = "CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT);\nCREATE INDEX idx_probe_value ON probe(value);"
)

// developmentBaselineCatalog has a released baseline at 001, development
// baselines at 002 and 003, and a numbered chain ending at 003.
func developmentBaselineCatalog() fstest.MapFS {
	return fstest.MapFS{
		"001_create_probe.sql":    {Data: []byte(probeV1)},
		"002_add_probe_value.sql": {Data: []byte("ALTER TABLE probe ADD COLUMN value TEXT;")},
		"003_add_probe_index.sql": {Data: []byte("CREATE INDEX idx_probe_value ON probe(value);")},
		"baseline/001_v0.1.0.sql": {Data: []byte(probeV1)},
		"compat/002_dev.sql":      {Data: []byte("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT);")},
		"compat/003_dev.sql":      {Data: []byte(probeV3)},
		"compat/README.md":        {Data: []byte("Development baselines.")},
	}
}

func migrationLedger(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.Query("SELECT filename FROM schema_migration ORDER BY version")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
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
	return strings.Join(filenames, ",")
}

func TestMigrateProductionIgnoresDevelopmentBaselines(t *testing.T) {
	db := openMigrationManagerDB(t)
	if err := MigrateFS(db, developmentBaselineCatalog(), "test"); err != nil {
		t.Fatalf("MigrateFS() error = %v", err)
	}
	if got, want := migrationLedger(t, db), "baseline/001_v0.1.0.sql,002_add_probe_value.sql,003_add_probe_index.sql"; got != want {
		t.Fatalf("production ledger = %q, want %q", got, want)
	}
}

func TestMigrateDevelopmentUsesNewestDevelopmentBaseline(t *testing.T) {
	db := openMigrationManagerDB(t)
	options := MigrateOptions{Development: true}
	if err := MigrateFSWithOptions(db, developmentBaselineCatalog(), "test", options); err != nil {
		t.Fatalf("MigrateFSWithOptions() error = %v", err)
	}
	if got, want := migrationLedger(t, db), "compat/003_dev.sql"; got != want {
		t.Fatalf("development ledger = %q, want %q", got, want)
	}
	var baselineVersion int
	if err := db.QueryRow("SELECT baseline_version FROM schema_state WHERE id = 1").Scan(&baselineVersion); err != nil {
		t.Fatal(err)
	}
	if baselineVersion != 3 {
		t.Fatalf("baseline version = %d, want 3", baselineVersion)
	}

	// A restart validates the recorded development baseline by checksum.
	if err := MigrateFSWithOptions(db, developmentBaselineCatalog(), "test", options); err != nil {
		t.Fatalf("development restart error = %v", err)
	}
	changed := developmentBaselineCatalog()
	changed["compat/003_dev.sql"] = &fstest.MapFile{Data: []byte(probeV3 + "\n-- changed\n")}
	if err := MigrateFSWithOptions(db, changed, "test", options); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("changed development baseline error = %v, want checksum refusal", err)
	}
}

func TestMigrateRefusesUnavailableDevelopmentBaselineLedger(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		development bool
		catalog     func() fstest.MapFS
		wantError   string
	}{
		{
			name:      "production",
			catalog:   developmentBaselineCatalog,
			wantError: "database was created from development baseline compat/003_dev.sql; start it with KIKOTO_MODE=development or recreate the database",
		},
		{
			name:        "development without the file",
			development: true,
			catalog: func() fstest.MapFS {
				catalog := developmentBaselineCatalog()
				delete(catalog, "compat/003_dev.sql")
				return catalog
			},
			wantError: "database was created from development baseline compat/003_dev.sql, which this build does not package; recreate the database",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			db := openMigrationManagerDB(t)
			if err := MigrateFSWithOptions(db, developmentBaselineCatalog(), "test", MigrateOptions{Development: true}); err != nil {
				t.Fatalf("create development database: %v", err)
			}
			err := MigrateFSWithOptions(db, testCase.catalog(), "test", MigrateOptions{Development: testCase.development})
			if err == nil || err.Error() != testCase.wantError {
				t.Fatalf("restart error = %v, want %q", err, testCase.wantError)
			}
		})
	}
}

func TestLoadMigrationCatalogRejectsInvalidDevelopmentBaselines(t *testing.T) {
	for _, testCase := range []struct {
		name      string
		filename  string
		wantError string
	}{
		{
			name:      "same version as a released baseline",
			filename:  "compat/001_dev.sql",
			wantError: "development baseline compat/001_dev.sql is not newer than the highest released baseline (001); remove it",
		},
		{
			name:      "above the numbered chain",
			filename:  "compat/004_dev.sql",
			wantError: "migration baseline compat/004_dev.sql exceeds current version 003",
		},
		{
			name:      "released filename in compat",
			filename:  "compat/003_v0.2.0.sql",
			wantError: `invalid migration baseline filename "compat/003_v0.2.0.sql"`,
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			catalog := developmentBaselineCatalog()
			catalog[testCase.filename] = &fstest.MapFile{Data: []byte(probeV1)}
			if _, err := loadMigrationCatalog(catalog, true); err == nil || err.Error() != testCase.wantError {
				t.Fatalf("development catalog error = %v, want %q", err, testCase.wantError)
			}
			if _, err := loadMigrationCatalog(catalog, false); err != nil {
				t.Fatalf("production catalog must ignore compat/: %v", err)
			}
		})
	}
}
