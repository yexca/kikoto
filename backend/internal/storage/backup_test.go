package storage

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"
)

func TestBackupIntoWritesVerifiedCopy(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir, "source.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("CREATE TABLE note (body TEXT); INSERT INTO note VALUES ('kept')"); err != nil {
		t.Fatal(err)
	}
	backupPath := filepath.Join(dir, "backups", BackupFileName(BackupKindManual, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), ""))
	size, err := BackupInto(context.Background(), db, backupPath)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if size <= 0 {
		t.Fatalf("backup size = %d", size)
	}
	if _, err := os.Stat(backupPath + backupPartialName); !os.IsNotExist(err) {
		t.Fatalf("partial backup was left behind: %v", err)
	}
	copyDB, err := Open(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	defer copyDB.Close()
	var body string
	if err := copyDB.QueryRow("SELECT body FROM note").Scan(&body); err != nil || body != "kept" {
		t.Fatalf("backup body = %q, err = %v", body, err)
	}
}

func TestPruneBackupsKeepsNewestOfOneKind(t *testing.T) {
	dir := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	names := []string{
		BackupFileName(BackupKindScheduled, base, ""),
		BackupFileName(BackupKindScheduled, base.Add(time.Hour), ""),
		BackupFileName(BackupKindScheduled, base.Add(2*time.Hour), ""),
		BackupFileName(BackupKindPreMigration, base, "v001-to-v002"),
		"notes.db",
	}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := PruneBackups(dir, BackupKindScheduled, 2)
	if err != nil || removed != 1 {
		t.Fatalf("removed = %d, err = %v", removed, err)
	}
	if _, err := os.Stat(filepath.Join(dir, names[0])); !os.IsNotExist(err) {
		t.Fatalf("oldest scheduled backup should be removed: %v", err)
	}
	for _, kept := range names[1:] {
		if _, err := os.Stat(filepath.Join(dir, kept)); err != nil {
			t.Fatalf("%s should be kept: %v", kept, err)
		}
	}
	backups, err := ListBackups(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(backups) != 3 || backups[0].Name != names[2] || backups[2].Kind != BackupKindPreMigration {
		t.Fatalf("backups = %+v", backups)
	}
}

func TestMigrateFSRunsBeforeUpgradeOnlyForExistingDatabase(t *testing.T) {
	first := fstest.MapFS{"001_initial.sql": {Data: []byte("CREATE TABLE app_item (id INTEGER PRIMARY KEY);")}}
	upgraded := fstest.MapFS{
		"001_initial.sql": first["001_initial.sql"],
		"002_add.sql":     {Data: []byte("ALTER TABLE app_item ADD COLUMN name TEXT NOT NULL DEFAULT '';")},
	}
	db, err := Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	calls := [][2]int{}
	hook := MigrateOptions{BeforeUpgrade: func(from, to int) error {
		calls = append(calls, [2]int{from, to})
		return nil
	}}
	if err := MigrateFSWithOptions(db, first, "test", hook); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 0 {
		t.Fatalf("fresh database must not trigger a pre-upgrade hook: %v", calls)
	}
	if err := MigrateFSWithOptions(db, upgraded, "test", hook); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 || calls[0] != [2]int{1, 2} {
		t.Fatalf("calls = %v, want one 1 -> 2", calls)
	}
	if err := MigrateFSWithOptions(db, upgraded, "test", hook); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 1 {
		t.Fatalf("an up-to-date database must not trigger the hook again: %v", calls)
	}
}

func TestMigrateFSStopsWhenBeforeUpgradeFails(t *testing.T) {
	first := fstest.MapFS{"001_initial.sql": {Data: []byte("CREATE TABLE app_item (id INTEGER PRIMARY KEY);")}}
	upgraded := fstest.MapFS{
		"001_initial.sql": first["001_initial.sql"],
		"002_add.sql":     {Data: []byte("ALTER TABLE app_item ADD COLUMN name TEXT NOT NULL DEFAULT '';")},
	}
	db, err := Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := MigrateFS(db, first, "test"); err != nil {
		t.Fatal(err)
	}
	err = MigrateFSWithOptions(db, upgraded, "test", MigrateOptions{BeforeUpgrade: func(int, int) error {
		return os.ErrPermission
	}})
	if err == nil {
		t.Fatal("a failed pre-upgrade backup must stop the migration")
	}
	var version int
	if err := db.QueryRow("SELECT current_version FROM schema_state").Scan(&version); err != nil || version != 1 {
		t.Fatalf("schema version = %d, err = %v; want the upgrade not applied", version, err)
	}
}
