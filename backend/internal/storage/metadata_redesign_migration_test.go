package storage

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestMetadataMigrationUnfreezesOnlyMatchingFamilyTitles(t *testing.T) {
	db := openMigrationManagerDB(t)
	dir := filepath.Join("..", "..", "migrations")
	if err := Migrate(db, copyNumberedMigrationsThrough(t, dir, 47)); err != nil {
		t.Fatal(err)
	}
	run := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	for ordinal := 0; ordinal < 4; ordinal++ {
		run("INSERT INTO work(id,primary_code,title) VALUES (?,?,'Synthetic work')", ordinal+1, testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
	}
	var provider int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code='dlsite'").Scan(&provider); err != nil {
		t.Fatal(err)
	}
	run("INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES (1,1,?),(2,4,?)", testfixture.WorkCode(testfixture.PrefixRJ, 0), testfixture.WorkCode(testfixture.PrefixRJ, 3))
	for ordinal := 0; ordinal < 4; ordinal++ {
		logical := 1
		if ordinal == 3 {
			logical = 2
		}
		run("INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,is_canonical) VALUES (?,?,?,?,?)", ordinal+1, logical, provider, testfixture.WorkCode(testfixture.PrefixRJ, ordinal), ordinal == 0 || ordinal == 3)
	}
	run("INSERT INTO dlsite_metadata_variant(logical_work_id,work_id,provider_id,external_id,title) VALUES (1,1,?,?,'Synthetic origin'),(1,2,?,?,?), (2,4,?,?,'Unrelated title')", provider, testfixture.WorkCode(testfixture.PrefixRJ, 0), provider, testfixture.WorkCode(testfixture.PrefixRJ, 1), "\u3000Synthetic translated title\n", provider, testfixture.WorkCode(testfixture.PrefixRJ, 3))
	for id, title := range map[int]string{1: "\tSynthetic translated title ", 2: "Synthetic translated title", 3: "Unrelated title", 4: "Authored title"} {
		raw, _ := json.Marshal(title)
		run("INSERT INTO work_manual_override(work_id,field_name,value_json) VALUES (?,'title',?)", id, string(raw))
	}
	run("INSERT INTO work_manual_override(work_id,field_name,value_json) VALUES (1,'circle','{\"name\":\"Synthetic origin\"}'),(1,'series','{\"name\":\"Synthetic translated title\"}'),(1,'voice_actors','[]')")
	run("INSERT INTO work(id,primary_code,title) VALUES (5,?,'Synthetic malformed override')", testfixture.WorkCode(testfixture.PrefixRJ, 4))
	run("INSERT INTO work_manual_override(work_id,field_name,value_json) VALUES (5,'title','{invalid json')")
	run("DELETE FROM work_search_dirty")
	if err := Migrate(db, dir); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[int]int{1: 0, 2: 0, 3: 1, 4: 1, 5: 1} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM work_manual_override WHERE work_id=? AND field_name='title'", id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != want {
			t.Fatalf("work %d title overrides=%d want %d", id, count, want)
		}
	}
	var others, dirty int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_manual_override WHERE work_id=1 AND field_name<>'title'").Scan(&others); err != nil {
		t.Fatal(err)
	}
	if others != 3 {
		t.Fatalf("removed non-title overrides: %d", others)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_search_dirty WHERE work_id IN (1,2)").Scan(&dirty); err != nil {
		t.Fatal(err)
	}
	if dirty != 2 {
		t.Fatal("title migration did not invalidate search")
	}
}
