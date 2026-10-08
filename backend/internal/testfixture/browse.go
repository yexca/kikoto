package testfixture

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"testing"
)

// SeedBrowse gives the SQL and HTTP measurements exactly the same records.
// It owns no deployment data, workers, statistics refresh or derived summaries.
func SeedBrowse(t testing.TB, db *sql.DB) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	exec := func(query string, args ...any) {
		if _, err := tx.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO user_account(id,username,role) VALUES(1,'synthetic-user','user');
		INSERT INTO file_source(id,code,display_name,source_type) VALUES(1,'example_local','Example Local','local_folder');
		INSERT OR IGNORE INTO metadata_provider(id,code,display_name) VALUES(2,'dlsite','DLsite')`)
	exec(`INSERT INTO user_session(id,user_id,expires_at) VALUES(?,1,'2999-01-01 00:00:00')`, fmt.Sprintf("%x", sha256.Sum256([]byte("synthetic-token"))))
	for i := range 400 {
		code := WorkCodeAt(i)
		exec(`INSERT INTO work(id,primary_code,title,created_at) VALUES(?,?,?,'2026-01-01 00:00:00')`, i+1, code, fmt.Sprintf("Example Work %03d", i))
		exec(`INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES(?,?,?)`, i+1, i+1, code)
		exec(`INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,is_canonical) VALUES(?,?,2,?,1)`, i+1, i+1, code)
		exec(`INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) VALUES(?,2,'example',?)`, i+1, fmt.Sprintf(`{"workno":%q}`, code))
		exec(`INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability,raw_json) VALUES(?,1,'local','available','{"file_tree_scanned":true}')`, i+1)
		for j := range 20 {
			id := i*20 + j + 1
			exec(`INSERT INTO media_item(id,work_id,kind,title,fingerprint) VALUES(?,?,'audio',?,?)`, id, i+1, fmt.Sprintf("track-%02d.mp3", j), fmt.Sprintf("example:%d", id))
			exec(`INSERT INTO media_file_location(media_item_id,file_source_id,location_type,path,availability) VALUES(?,1,'local',?,'available')`, id, fmt.Sprintf("%s/track-%02d.mp3", code, j))
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

// Modernc enables STAT4 as well as STAT1. Clearing only row estimates leaves
// histogram statistics behind, so it does not represent a missing-stats state.
func ClearBrowseStatistics(t testing.TB, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`ANALYZE`); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sqlite_stat1", "sqlite_stat4"} {
		var exists bool
		if err := db.QueryRow(`SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=?)`, table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if exists {
			if _, err := db.Exec("DELETE FROM " + table); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := db.Exec(`ANALYZE sqlite_schema`); err != nil {
		t.Fatal(err)
	}
}
