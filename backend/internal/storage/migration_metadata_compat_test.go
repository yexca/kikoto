package storage

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/migrations"
)

func copyMetadataMigrationsThrough(t *testing.T, version int) string {
	t.Helper()
	dir := copyNumberedMigrationsThrough(t, filepath.Join("..", "..", "migrations"), 50)
	for index, filename := range []string{
		"051_metadata_tag_projection_queue.sql",
		"052_language_scoped_titles.sql",
		"053_favorite_list_icon.sql",
	} {
		if 51+index > version {
			break
		}
		contents, err := migrations.Files.ReadFile("compat/metadata/" + filename)
		if err != nil {
			t.Fatal(err)
		}
		writeMigration(t, dir, filename, string(contents))
	}
	return dir
}

func migrationLedgerSnapshot(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	rows, err := db.Query(`SELECT filename, version, checksum, app_version, duration_ms, applied_at FROM schema_migration`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	result := map[string]string{}
	for rows.Next() {
		var filename, checksum, appVersion, appliedAt string
		var version, duration int
		if err := rows.Scan(&filename, &version, &checksum, &appVersion, &duration, &appliedAt); err != nil {
			t.Fatal(err)
		}
		result[filename] = fmt.Sprintf("%d/%s/%s/%d/%s", version, checksum, appVersion, duration, appliedAt)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestMigratePreservesBothDevelopmentHistories(t *testing.T) {
	fresh := openMigrationManagerDB(t)
	if err := MigrateFS(fresh, migrations.Files, "fresh"); err != nil {
		t.Fatal(err)
	}
	wantSchema := schemaSnapshot(t, fresh)
	for _, testCase := range []struct {
		name     string
		version  int
		metadata bool
		baseline bool
	}{
		{"main numbered 051", 51, false, false},
		{"main baseline 051", 51, false, true},
		{"metadata numbered 051", 51, true, false},
		{"metadata baseline 051", 51, true, true},
		{"metadata numbered 052", 52, true, false},
		{"metadata baseline 052", 52, true, true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			dir := copyNumberedMigrationsThrough(t, filepath.Join("..", "..", "migrations"), testCase.version)
			if testCase.metadata {
				dir = copyMetadataMigrationsThrough(t, testCase.version)
			} else if testCase.baseline {
				contents, err := migrations.Files.ReadFile("baseline/051_v0.7.1.sql")
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(dir, "baseline"), 0o700); err != nil {
					t.Fatal(err)
				}
				writeMigration(t, dir, "baseline/051_v0.7.1.sql", string(contents))
			}
			db := openMigrationManagerDB(t)
			if err := Migrate(db, dir); err != nil {
				t.Fatal(err)
			}
			if testCase.metadata && testCase.baseline {
				replaceMigrationHistoryWithRetiredBaseline(t, db, fmt.Sprintf("baseline/%03d_v0.7.1.sql", testCase.version))
			}
			if _, err := db.Exec(`INSERT INTO work(primary_code,title) VALUES (?,'Example Work')`, testfixture.WorkCode(testfixture.PrefixRJ, 0)); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO work_manual_override(work_id,field_name,value_json,created_at,updated_at)
				SELECT id,'title','"Authored title"','2026-01-01','2026-01-02' FROM work;
				INSERT INTO user_account(id,username,role) VALUES (1,'example-user','user');
				INSERT INTO favorite_list(user_id,name) VALUES (1,'Example list');`); err != nil {
				t.Fatal(err)
			}
			wantIcon := ""
			if !testCase.metadata {
				wantIcon = "star"
				if _, err := db.Exec(`UPDATE favorite_list SET icon='star'`); err != nil {
					t.Fatal(err)
				}
			}
			if testCase.metadata {
				if _, err := db.Exec(`INSERT INTO work_metadata_tag_dirty(work_id,retry_count,retry_after) SELECT id,3,123 FROM work`); err != nil {
					t.Fatal(err)
				}
				if testCase.version == 52 {
					if _, err := db.Exec(`INSERT INTO work_manual_override(work_id,field_name,language,value_json)
						SELECT id,'title','zh-cn','"Chinese title"' FROM work`); err != nil {
						t.Fatal(err)
					}
				}
			}
			before := migrationLedgerSnapshot(t, db)
			oldState, err := readSchemaState(db)
			if err != nil {
				t.Fatal(err)
			}
			if err := MigrateFS(db, migrations.Files, "merged"); err != nil {
				t.Fatalf("upgrade historical database: %v", err)
			}
			after := migrationLedgerSnapshot(t, db)
			for filename, record := range before {
				if after[filename] != record {
					t.Fatalf("historical ledger entry %q changed: %q -> %q", filename, record, after[filename])
				}
			}
			state, err := readSchemaState(db)
			if err != nil {
				t.Fatal(err)
			}
			if state.currentVersion != latestNumberedMigrationVersion || state.baselineHash != oldState.baselineHash || state.baselineVersion != oldState.baselineVersion || state.dirtyVersion.Valid {
				t.Fatalf("upgrade changed baseline state or failed to reach %03d: %+v", latestNumberedMigrationVersion, state)
			}
			if got := schemaSnapshot(t, db); !reflect.DeepEqual(got, wantSchema) {
				for name, definition := range wantSchema {
					if got[name] != definition {
						t.Errorf("schema %s differs: got %s; want %s", name, got[name], definition)
					}
				}
				t.Fatalf("historical schema differs from fresh schema (objects %d/%d)", len(got), len(wantSchema))
			}
			var title, created, updated, icon string
			if err := db.QueryRow(`SELECT value_json,created_at,updated_at FROM work_manual_override WHERE language=''`).Scan(&title, &created, &updated); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(`SELECT icon FROM favorite_list`).Scan(&icon); err != nil {
				t.Fatal(err)
			}
			if title != `"Authored title"` || created != "2026-01-01" || updated != "2026-01-02" || icon != wantIcon {
				t.Fatalf("user data changed: %q/%q/%q/%q", title, created, updated, icon)
			}
			if testCase.metadata {
				var retries, retryAfter int
				if err := db.QueryRow(`SELECT retry_count,retry_after FROM work_metadata_tag_dirty`).Scan(&retries, &retryAfter); err != nil || retries != 3 || retryAfter != 123 {
					t.Fatalf("projection queue changed: %d/%d, %v", retries, retryAfter, err)
				}
				if testCase.version == 52 {
					if err := db.QueryRow(`SELECT value_json FROM work_manual_override WHERE language='zh-cn'`).Scan(&title); err != nil || title != `"Chinese title"` {
						t.Fatalf("scoped title changed: %q, %v", title, err)
					}
				}
			}
			data := dataSnapshot(t, db)
			if err := MigrateFS(db, migrations.Files, "restart"); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(after, migrationLedgerSnapshot(t, db)) || !reflect.DeepEqual(data, dataSnapshot(t, db)) {
				t.Fatal("restart changed migration history or application data")
			}
		})
	}
}

func TestMigrateRejectsInvalidDevelopmentHistoryBeforeUpgrade(t *testing.T) {
	for _, testCase := range []struct {
		name, mutation, wantError string
		baseline                  bool
	}{
		{"tampered numbered", `UPDATE schema_migration SET checksum='tampered' WHERE version=51`, "checksum", false},
		{"ambiguous baseline", `UPDATE schema_migration SET checksum='' WHERE version=51`, "cannot identify", true},
		{"tampered baseline", `UPDATE schema_migration SET checksum='tampered' WHERE version=51`, "checksum", true},
		{"mixed numbered chains", `UPDATE schema_migration SET filename='051_favorite_list_icon.sql' WHERE version=51`, "unknown migration", false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			db := openMigrationManagerDB(t)
			version := 52
			if testCase.baseline {
				version = 51
			}
			if err := Migrate(db, copyMetadataMigrationsThrough(t, version)); err != nil {
				t.Fatal(err)
			}
			if testCase.baseline {
				replaceMigrationHistoryWithRetiredBaseline(t, db, "baseline/051_v0.7.1.sql")
			}
			if _, err := db.Exec(testCase.mutation); err != nil {
				t.Fatal(err)
			}
			before := schemaSnapshot(t, db)
			history := migrationLedgerSnapshot(t, db)
			if err := MigrateFS(db, migrations.Files, "merged"); err == nil || !strings.Contains(err.Error(), testCase.wantError) {
				t.Fatalf("invalid history error = %v, want %s", err, testCase.wantError)
			}
			if !reflect.DeepEqual(before, schemaSnapshot(t, db)) || !reflect.DeepEqual(history, migrationLedgerSnapshot(t, db)) {
				t.Fatal("invalid history altered schema or ledger")
			}
		})
	}
}

func TestMetadataHistorySharesFutureCanonicalTail(t *testing.T) {
	dir := copyNumberedMigrations(t, filepath.Join("..", "..", "migrations"))
	if err := os.MkdirAll(filepath.Join(dir, "compat", "metadata"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"051_metadata_tag_projection_queue.sql", "052_language_scoped_titles.sql", "053_favorite_list_icon.sql"} {
		contents, err := migrations.Files.ReadFile("compat/metadata/" + filename)
		if err != nil {
			t.Fatal(err)
		}
		writeMigration(t, dir, "compat/metadata/"+filename, string(contents))
	}
	writeMigration(t, dir, fmt.Sprintf("%03d_future_probe.sql", latestNumberedMigrationVersion+1), "CREATE TABLE future_probe (id INTEGER PRIMARY KEY);")
	for _, metadata := range []bool{false, true} {
		t.Run(fmt.Sprintf("metadata=%v", metadata), func(t *testing.T) {
			db := openMigrationManagerDB(t)
			previous := copyNumberedMigrationsThrough(t, filepath.Join("..", "..", "migrations"), 51)
			if metadata {
				previous = copyMetadataMigrationsThrough(t, 52)
			}
			if err := Migrate(db, previous); err != nil {
				t.Fatal(err)
			}
			if err := Migrate(db, dir); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec("INSERT INTO future_probe(id) VALUES (1)"); err != nil {
				t.Fatalf("shared future migration was not applied: %v", err)
			}
		})
	}
}

func TestMetadataArchiveRetainsHistoricalSQL(t *testing.T) {
	for _, testCase := range []struct{ archived, canonical, checksum string }{
		{"051_metadata_tag_projection_queue.sql", "052_metadata_tag_projection_queue.sql", "f09280931ce9fdaa0e24be650fe22aeab48e07adadfbb7069ab9272e58ec3bee"},
		{"052_language_scoped_titles.sql", "053_language_scoped_titles.sql", "3c1e944cfbe06d6e5e0e580f655a0e9790edc5adb2b3e871f1ca0d7a6a602f11"},
		{"053_favorite_list_icon.sql", "051_favorite_list_icon.sql", "873fe9ce8e5f92796feddc3b16920ebfd8c123170b082cba603395adc3cba317"},
	} {
		for _, filename := range []string{"compat/metadata/" + testCase.archived, testCase.canonical} {
			contents, err := migrations.Files.ReadFile(filename)
			if err != nil {
				t.Fatal(err)
			}
			if migrationChecksum(contents) != testCase.checksum {
				t.Fatalf("historical SQL changed: %s", filename)
			}
		}
	}
}

func TestMetadataHistoryConcurrentUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "metadata-upgrade.db")
	first, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Close() }()
	if err := Migrate(first, copyMetadataMigrationsThrough(t, 52)); err != nil {
		t.Fatal(err)
	}
	before := migrationLedgerSnapshot(t, first)
	second, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = second.Close() }()
	results := make(chan error, 2)
	go func() { results <- MigrateFS(first, migrations.Files, "first") }()
	go func() { results <- MigrateFS(second, migrations.Files, "second") }()
	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatalf("concurrent historical upgrade: %v", err)
		}
	}
	after := migrationLedgerSnapshot(t, first)
	if len(after) != latestNumberedMigrationVersion || after["053_favorite_list_icon.sql"] == "" || after["054_remote_metadata_fallback.sql"] == "" || after["055_genre_name_learning.sql"] == "" || after["056_user_metadata_language.sql"] == "" {
		t.Fatalf("concurrent upgrade did not append each missing migration once: %v", after)
	}
	for filename, record := range before {
		if after[filename] != record {
			t.Fatalf("concurrent upgrade changed historical entry %s", filename)
		}
	}
}
