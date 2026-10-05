package circleidentity

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/migrations"
)

func circleMergeDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "circles.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if err := storage.MigrateFS(db, migrations.Files, "test"); err != nil {
		t.Fatal(err)
	}
	run := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	run("INSERT INTO user_account(id,username,role) VALUES (1,'circle-user','user')")
	for ordinal := 0; ordinal < 2; ordinal++ {
		run("INSERT INTO work(id,primary_code,title) VALUES (?,?,'Synthetic circle work')", ordinal+1, testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
	}
	run("INSERT INTO party(id,display_name,provider_name) VALUES (1,'Synthetic target','Synthetic target'),(2,'Synthetic source','Synthetic source')")
	var provider int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code='dlsite'").Scan(&provider); err != nil {
		t.Fatal(err)
	}
	run("INSERT INTO party_external_id(party_id,provider_id,id_type,external_id,is_primary) VALUES (1,?,'maker_id','RG00000000',1),(2,?,'maker_id','RG00000001',1)", provider, provider)
	run("INSERT INTO party_alias(party_id,alias) VALUES (1,'Target alias'),(2,'Source alias')")
	run("INSERT INTO work_party(work_id,party_id,role,source) VALUES (1,1,'circle','dlsite_snapshot'),(1,2,'circle','dlsite_snapshot'),(2,2,'circle','dlsite_snapshot')")
	run("INSERT INTO party_series(id,party_id,provider_id,title_id,name) VALUES (1,1,?,'SRI0000000000','Shared series'),(2,2,?,'SRI0000000000','Source shared series'),(3,2,?,'SRI0000000001','Source series')", provider, provider, provider)
	run("INSERT INTO party_series_work(series_id,primary_code) VALUES (1,?),(2,?),(3,?)", testfixture.WorkCode(testfixture.PrefixRJ, 0), testfixture.WorkCode(testfixture.PrefixRJ, 1), testfixture.WorkCode(testfixture.PrefixRJ, 1))
	run("INSERT INTO party_catalog_item(party_id,provider_id,primary_code,title,last_seen_at) VALUES (1,?,?,'Old catalog title','2026-01-01'),(2,?,?,'New catalog title','2026-01-02'),(2,?,?,'Source catalog title','2026-01-02')", provider, testfixture.WorkCode(testfixture.PrefixRJ, 0), provider, testfixture.WorkCode(testfixture.PrefixRJ, 0), provider, testfixture.WorkCode(testfixture.PrefixRJ, 1))
	for i := 0; i < 4; i++ {
		run("INSERT INTO party_metadata_snapshot(party_id,provider_id,external_id,snapshot_json,fetched_at) VALUES (?,?,'synthetic-maker','{}',?)", 1+i%2, provider, "2026-01-0"+string(rune('1'+i)))
	}
	run("INSERT INTO user_party_state(user_id,party_id,note,favorite,rating) VALUES (1,1,'Target note',0,NULL),(1,2,'Source note',1,5)")
	run("INSERT INTO user_party_tag(id,user_id,name) VALUES (1,1,'Synthetic first'),(2,1,'Synthetic second')")
	run("INSERT INTO user_party_tag_assignment(user_id,party_id,user_party_tag_id) VALUES (1,1,1),(1,2,2)")
	run("INSERT INTO party_catalog_refresh_state(party_id,provider_code,last_status) VALUES (1,'dlsite','succeeded'),(2,'dlsite','succeeded')")
	return db
}
func circleRecords(t *testing.T, db *sql.DB) map[string][]string {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	records, err := capture(context.Background(), tx, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string][]string{}
	for name, rows := range records {
		if name == "party_merge_review" {
			continue
		}
		for _, row := range rows {
			raw, err := json.Marshal(row)
			if err != nil {
				t.Fatal(err)
			}
			result[name] = append(result[name], string(raw))
		}
		sort.Strings(result[name])
	}
	return result
}

func TestCircleMergeMovesRelationsAndUndoRestoresEachOwner(t *testing.T) {
	db := circleMergeDB(t)
	ctx := context.Background()
	before := circleRecords(t, db)
	id, err := Merge(ctx, db, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, check := range []struct {
		query string
		want  int
	}{
		{"SELECT COUNT(*) FROM party WHERE id=2", 0},
		{"SELECT COUNT(*) FROM party_external_id WHERE party_id=1", 2},
		{"SELECT COUNT(*) FROM work_party WHERE party_id=1", 2},
		{"SELECT COUNT(*) FROM party_catalog_item WHERE party_id=1", 2},
		{"SELECT COUNT(*) FROM party_metadata_snapshot WHERE party_id=1", 2},
		{"SELECT COUNT(*) FROM party_series WHERE party_id=1", 2},
		{"SELECT COUNT(*) FROM party_series_work WHERE series_id=1", 2},
		{"SELECT COUNT(*) FROM user_party_tag_assignment WHERE party_id=1", 2},
		{"SELECT favorite FROM user_party_state WHERE party_id=1", 1},
		{"SELECT rating FROM user_party_state WHERE party_id=1", 5},
	} {
		var value int
		if err := db.QueryRow(check.query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		if value != check.want {
			t.Fatalf("%s = %d want %d", check.query, value, check.want)
		}
	}
	var title, note string
	if err := db.QueryRow("SELECT title FROM party_catalog_item WHERE party_id=1 AND primary_code=?", testfixture.WorkCode(testfixture.PrefixRJ, 0)).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "New catalog title" {
		t.Fatal(title)
	}
	if err := db.QueryRow("SELECT note FROM user_party_state WHERE party_id=1").Scan(&note); err != nil {
		t.Fatal(err)
	}
	if note != "Target note" {
		t.Fatal(note)
	}
	if err := Undo(ctx, db, 1, id); err != nil {
		t.Fatal(err)
	}
	if after := circleRecords(t, db); !reflect.DeepEqual(before, after) {
		t.Fatalf("Undo failed to restore original records:\nbefore=%v\nafter=%v", before, after)
	}
	reviews, err := Reviews(ctx, db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(reviews) != 1 || reviews[0].Status != "undone" {
		t.Fatalf("review=%+v", reviews)
	}
}

func TestCircleUndoKeepsNewUnrelatedAliasAndRejectsChangedPersonalData(t *testing.T) {
	for _, change := range []string{"unrelated alias", "personal note"} {
		t.Run(change, func(t *testing.T) {
			db := circleMergeDB(t)
			ctx := context.Background()
			id, err := Merge(ctx, db, 1, 2)
			if err != nil {
				t.Fatal(err)
			}
			if change == "unrelated alias" {
				if _, err := db.Exec("INSERT INTO party_alias(party_id,alias) VALUES (1,'New unrelated alias')"); err != nil {
					t.Fatal(err)
				}
				if err := Undo(ctx, db, 1, id); err != nil {
					t.Fatal(err)
				}
				var count int
				if err := db.QueryRow("SELECT COUNT(*) FROM party_alias WHERE party_id=1 AND alias='New unrelated alias'").Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 1 {
					t.Fatal("Undo discarded a new alias")
				}
			} else {
				if _, err := db.Exec("UPDATE user_party_state SET note='New personal edit' WHERE party_id=1"); err != nil {
					t.Fatal(err)
				}
				if err := Undo(ctx, db, 1, id); !errors.Is(err, ErrConflict) {
					t.Fatalf("Undo error %v want conflict", err)
				}
				var note string
				if err := db.QueryRow("SELECT note FROM user_party_state WHERE party_id=1").Scan(&note); err != nil {
					t.Fatal(err)
				}
				if note != "New personal edit" {
					t.Fatal("Undo replaced a new personal edit")
				}
			}
		})
	}
}

func TestCircleNestedMergeHistoryMovesAndReturnsOnUndo(t *testing.T) {
	db := circleMergeDB(t)
	ctx := context.Background()
	first, err := Merge(ctx, db, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO party(id,display_name,provider_name) VALUES (3,'Synthetic final circle','Synthetic final circle')"); err != nil {
		t.Fatal(err)
	}
	outer, err := Merge(ctx, db, 3, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := Undo(ctx, db, 3, first); !errors.Is(err, ErrConflict) {
		t.Fatalf("out-of-order undo error=%v", err)
	}
	if err := Undo(ctx, db, 3, outer); err != nil {
		t.Fatal(err)
	}
	if err := Undo(ctx, db, 1, first); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM party WHERE id IN (1,2,3)").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 3 {
		t.Fatalf("restored circles=%d", count)
	}
}
