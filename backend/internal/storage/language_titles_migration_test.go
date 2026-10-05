package storage

import (
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/migrations"
	"path/filepath"
	"testing"
)

func TestLanguageTitleMigrationPreservesRetiredBaselineDataAndSearchTriggers(t *testing.T) {
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, filepath.Join("..", "..", "migrations"), 51)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Example Work')", testfixture.WorkCode(testfixture.PrefixRJ, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_manual_override(work_id,field_name,value_json,asset_path,created_at,updated_at)
 SELECT id,'title','"Authored original"','', '2026-01-01','2026-01-02' FROM work;
 INSERT INTO work_manual_override(work_id,field_name,value_json,asset_path)
 SELECT id,'cover','{}','synthetic-cover.png' FROM work;`); err != nil {
		t.Fatal(err)
	}
	replaceMigrationHistoryWithRetiredBaseline(t, db, "baseline/051_v0.7.1.sql")
	if err := MigrateFS(db, migrations.Files, "test"); err != nil {
		t.Fatal(err)
	}
	var title, language, created, updated, asset string
	if err := db.QueryRow(`SELECT value_json,language,created_at,updated_at FROM work_manual_override WHERE field_name='title'`).Scan(&title, &language, &created, &updated); err != nil {
		t.Fatal(err)
	}
	if title != `"Authored original"` || language != "" || created != "2026-01-01" || updated != "2026-01-02" {
		t.Fatalf("existing title changed: %q %q %q %q", title, language, created, updated)
	}
	if err := db.QueryRow(`SELECT asset_path FROM work_manual_override WHERE field_name='cover'`).Scan(&asset); err != nil || asset != "synthetic-cover.png" {
		t.Fatalf("cover changed: %q %v", asset, err)
	}
	var id int64
	if err := db.QueryRow("SELECT id FROM work").Scan(&id); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{
		`INSERT INTO work_manual_override(work_id,field_name,language,value_json) VALUES (?,'title','zh-cn','"Chinese title"')`,
		`UPDATE work_manual_override SET language='zh-tw' WHERE work_id=? AND language='zh-cn'`,
		`DELETE FROM work_manual_override WHERE work_id=? AND language='zh-tw'`,
	} {
		if _, err := db.Exec("DELETE FROM work_search_dirty"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(mutation, id); err != nil {
			t.Fatal(err)
		}
		var dirty int
		if err := db.QueryRow("SELECT COUNT(*) FROM work_search_dirty WHERE work_id=?", id).Scan(&dirty); err != nil || dirty != 1 {
			t.Fatalf("search invalidation: %d %v", dirty, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO work_manual_override(work_id,field_name,language) VALUES (?,'circle','zh-cn')`, id); err == nil {
		t.Fatal("non-title language accepted")
	}
	if _, err := db.Exec("DELETE FROM work WHERE id=?", id); err != nil {
		t.Fatalf("cascade after table rebuild: %v", err)
	}
	var remaining int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_manual_override").Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("cascade: %d %v", remaining, err)
	}
}
