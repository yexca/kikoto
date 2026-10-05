package metasync

import (
	"context"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestSnapshotFallbackOnlyFillsMissingDictionaryCells(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Example newer base'),(1,'zh-cn','Example newer localized')`); err != nil {
		t.Fatal(err)
	}
	raws := []string{
		`{"_kikoto":{"request_locale":"zh-cn"},"product":{"genres":[{"id":1,"name":"Example older localized","name_base":"Example older base"},{"id":2,"name":"Example missing localized","name_base":"Example missing base"}]}}`,
		`{"_kikoto":{"request_locale":"origin"},"product":{"genres":[{"id":3,"name":"Example unknown language"}]}}`,
	}
	for i, raw := range raws {
		code := testfixture.WorkCode(testfixture.PrefixRJ, i)
		result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Example Work')", code)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		if _, err := db.Exec("INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,?,? FROM metadata_provider WHERE code='dlsite'", id, code, raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := BackfillMetadataTags(ctx, db, nil); err != nil {
		t.Fatal(err)
	}
	for _, cell := range []struct {
		id             int
		language, want string
	}{
		{1, "ja-jp", "Example newer base"}, {1, "zh-cn", "Example newer localized"},
		{2, "ja-jp", "Example missing base"}, {2, "zh-cn", "Example missing localized"}, {3, "", "Example unknown language"},
	} {
		var name string
		if err := db.QueryRow("SELECT name FROM dlsite_genre_name WHERE genre_id=? AND language=?", cell.id, cell.language).Scan(&name); err != nil || name != cell.want {
			t.Fatalf("dictionary cell %+v = %q, %v", cell, name, err)
		}
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM dlsite_genre_name WHERE genre_id=3 AND language<>''").Scan(&count); err != nil || count != 0 {
		t.Fatalf("guessed language: %d, %v", count, err)
	}
}

func TestMalformedSnapshotsDoNotBlockBackfillOrManualTags(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	raws := []string{
		`invalid`, `{"product":[]}`, `{"product":{"genres":{}}}`, `{"product":{"genres":["Example valid",42]}}`,
		`{"product":{"tags":["` + strings.Repeat("x", 513) + `"]}}`,
		`{"product":{"tags":[` + strings.Repeat(`"Example tag",`, 256) + `"Example excess"]}}`,
		`{"product":{"tags":["Example valid tag"]}}`,
	}
	works := []int64{}
	for i, raw := range raws {
		code := testfixture.WorkCode(testfixture.PrefixRJ, i)
		result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Example Work')", code)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		works = append(works, id)
		if _, err := db.Exec("INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,?,? FROM metadata_provider WHERE code='dlsite'", id, code, raw); err != nil {
			t.Fatal(err)
		}
	}
	if err := BackfillMetadataTags(ctx, db, nil); err != nil {
		t.Fatal(err)
	}
	for i, id := range works {
		tags, err := metadatatags.Read(ctx, db, id)
		want := 0
		if i == len(works)-1 {
			want = 1
		}
		if err != nil || len(tags) != want {
			t.Fatalf("work %d tags=%v, %v", i, tags, err)
		}
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	tag, err := metadatatags.CreateTx(ctx, tx, "Example manual tag", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := metadatatags.SetOverridesTx(ctx, tx, works[0], []metadatatags.Override{{TagID: tag, Action: "add"}}, 0); err != nil {
		t.Fatal(err)
	}
	if err := ProjectWorkMetadataTagsTx(ctx, tx, works[0], nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	tags, err := metadatatags.Read(ctx, db, works[0])
	if err != nil || len(tags) != 1 || tags[0].ID != tag {
		t.Fatalf("manual edit=%v, %v", tags, err)
	}
	if n, err := ProcessMetadataTagQueue(ctx, db, 64, nil); err != nil || n != 0 {
		t.Fatalf("backfill acknowledgement=%d, %v", n, err)
	}
}

func TestSnapshotWritesQueueLatestTagsAndRemoteInputStaysSeparate(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES ('RJ00000000','Example Work')")
	if err != nil {
		t.Fatal(err)
	}
	work, _ := result.LastInsertId()
	if _, err := db.Exec("INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,'RJ00000000',? FROM metadata_provider WHERE code='dlsite'", work, `{"product":{"tags":["Example first"]}}`); err != nil {
		t.Fatal(err)
	}
	if n, err := ProcessMetadataTagQueue(ctx, db, 1, nil); err != nil || n != 1 {
		t.Fatalf("initial queue=%d %v", n, err)
	}
	if _, err := db.Exec("UPDATE metadata_snapshot SET snapshot_json=? WHERE work_id=?", `{"product":{"tags":["Example latest"]}}`, work); err != nil {
		t.Fatal(err)
	}
	old, err := metadatatags.Read(ctx, db, work)
	if err != nil || len(old) != 1 || old[0].DisplayName != "Example first" {
		t.Fatalf("pending links=%v %v", old, err)
	}
	if n, err := ProcessMetadataTagQueue(ctx, db, 1, nil); err != nil || n != 1 {
		t.Fatalf("updated queue=%d %v", n, err)
	}
	latest, err := metadatatags.Read(ctx, db, work)
	if err != nil || len(latest) != 1 || latest[0].DisplayName != "Example latest" {
		t.Fatalf("latest links=%v %v", latest, err)
	}
	if _, err := db.Exec("INSERT INTO metadata_provider(code,display_name) VALUES ('example_remote_a','Example Remote A')"); err != nil {
		t.Fatal(err)
	}
	result, err = db.Exec("INSERT INTO work(primary_code,title) VALUES ('RJ00000001','Example Remote Work')")
	if err != nil {
		t.Fatal(err)
	}
	remote, _ := result.LastInsertId()
	if _, err := db.Exec("INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,'RJ00000001',? FROM metadata_provider WHERE code='example_remote_a'", remote, `{"tags":[{"name":"Example remote tag"}]}`); err != nil {
		t.Fatal(err)
	}
	if _, err := ProcessMetadataTagQueue(ctx, db, 1, nil); err != nil {
		t.Fatal(err)
	}
	tags, err := metadatatags.Read(ctx, db, remote)
	if err != nil || len(tags) != 0 {
		t.Fatalf("remote tags imported=%v %v", tags, err)
	}
	projected, err := metadatatags.Projected(ctx, db, remote)
	if err != nil || projected {
		t.Fatalf("remote snapshot suppressed=%v %v", projected, err)
	}
}
