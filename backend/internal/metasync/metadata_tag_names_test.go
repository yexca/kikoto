package metasync

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestNormalProductSyncRefreshesOnlyLearnedTagNames(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Synthetic sync work')", code)
	if err != nil {
		t.Fatal(err)
	}
	work, _ := result.LastInsertId()
	if _, err := db.Exec("INSERT INTO app_setting(key,value_json) VALUES ('dlsite_metadata_languages','[\"en-us\",\"origin\"]')"); err != nil {
		t.Fatal(err)
	}
	// An unrelated concept deliberately has an old chosen name. Normal sync
	// must not recalculate the whole dictionary while refreshing one genre.
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	unrelated, err := metadatatags.CreateTx(ctx, tx, "Synthetic untouched", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := metadatatags.SetNameTx(ctx, tx, unrelated, "", "Synthetic pending unrelated", 0); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{}).WithMetadataPriority([]string{"en-us", "origin"})
	product := dlsite.Product{WorkNo: code, ProductName: "Synthetic synced title", RequestLocale: "ja-jp", Genres: []dlsite.Genre{{ID: 1, Name: "Synthetic Japanese genre", NameBase: "Synthetic Japanese genre"}}}
	assertName := func(want string) {
		t.Helper()
		var name string
		if err := db.QueryRow("SELECT tag.display_name FROM metadata_tag AS concept JOIN tag ON tag.id=concept.tag_id WHERE concept.dlsite_genre_id=1").Scan(&name); err != nil {
			t.Fatal(err)
		}
		if name != want {
			t.Fatalf("normal sync name %q, want %q", name, want)
		}
		if err := db.QueryRow("SELECT display_name FROM tag WHERE id=?", unrelated).Scan(&name); err != nil {
			t.Fatal(err)
		}
		if name != "Synthetic untouched" {
			t.Fatalf("sync refreshed unrelated name to %q", name)
		}
	}
	if err := syncer.applyProduct(ctx, work, product); err != nil {
		t.Fatal(err)
	}
	assertName("Synthetic Japanese genre")
	product.RequestLocale = "en-us"
	product.Genres[0].Name = "Synthetic learned English"
	if err := syncer.applyProduct(ctx, work, product); err != nil {
		t.Fatal(err)
	}
	assertName("Synthetic learned English")
	// A response whose attempt predates the stored result must not learn names
	// or run a global refresh. Its outcome is recorded without changing input.
	stale, err := syncer.beginAttempt(ctx)
	if err != nil {
		t.Fatal(err)
	}
	product.Genres[0].Name = "Synthetic latest English"
	if err := syncer.applyProduct(ctx, work, product); err != nil {
		t.Fatal(err)
	}
	product.Genres[0].Name = "Synthetic stale English"
	if err := syncer.applyProduct(stale, work, product); err != nil {
		t.Fatal(err)
	}
	assertName("Synthetic latest English")
}

func TestBackfillNormalizesSnapshotOnlyTagsAndPreservesAuthoritativeRemoval(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	for ordinal, raw := range []string{
		`{"product":{"genres":[{"id":1,"name":"Synthetic snapshot genre"}]}}`,
		`{"product":{"tags":["Synthetic snapshot name only"]}}`,
	} {
		code := testfixture.WorkCode(testfixture.PrefixRJ, ordinal)
		result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Synthetic snapshot work')", code)
		if err != nil {
			t.Fatal(err)
		}
		work, _ := result.LastInsertId()
		if _, err := db.Exec("INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,?,? FROM metadata_provider WHERE code='dlsite'", work, code, raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := BackfillMetadataTags(ctx, db, nil); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query("SELECT id FROM work ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	var works []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		works = append(works, id)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	for _, work := range works {
		tags, err := metadatatags.Read(ctx, db, work)
		if err != nil || len(tags) != 1 {
			t.Fatalf("snapshot tags = %+v, %v", tags, err)
		}
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: tags[0].ID, Action: "remove"}}, 0); err != nil {
			t.Fatal(err)
		}
		if err := ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		projected, err := metadatatags.Projected(ctx, db, work)
		if err != nil || !projected {
			t.Fatalf("empty projection marker = %v, %v", projected, err)
		}
		tags, err = metadatatags.Read(ctx, db, work)
		if err != nil || len(tags) != 0 {
			t.Fatalf("removed tags = %+v, %v", tags, err)
		}
		// The durable original base must still let a reset restore all inputs.
		tx, err = db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := metadatatags.SetOverridesTx(ctx, tx, work, nil, 0); err != nil {
			t.Fatal(err)
		}
		if err := ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		tags, err = metadatatags.Read(ctx, db, work)
		if err != nil || len(tags) != 1 {
			t.Fatalf("restored tags = %+v, %v", tags, err)
		}
	}
	// Snapshot input queues replacement while retaining the authoritative old
	// result; an explicit empty provider set clears tags when projection commits.
	if _, err := db.Exec("UPDATE metadata_snapshot SET snapshot_json=? WHERE work_id=?", `{"product":{"genres":[]}}`, works[0]); err != nil {
		t.Fatal(err)
	}
	projected, err := metadatatags.Projected(ctx, db, works[0])
	if err != nil || !projected {
		t.Fatalf("new snapshot lost committed marker: %v, %v", projected, err)
	}
	var pending int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty WHERE work_id=?", works[0]).Scan(&pending); err != nil || pending != 1 {
		t.Fatalf("new snapshot did not queue replacement: %d, %v", pending, err)
	}
	previous, err := metadatatags.Read(ctx, db, works[0])
	if err != nil || len(previous) != 1 {
		t.Fatalf("new snapshot lost previous tags before commit: %v, %v", previous, err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := ProjectWorkMetadataTagsTx(ctx, tx, works[0], nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_tag WHERE work_id=?", works[0]).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("explicit empty snapshot retained %d tags", count)
	}
}
