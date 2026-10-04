package metasync

import (
	"context"
	"errors"
	"testing"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestMetadataTagBackfillBatchesResumeWithoutCreatingWorks(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	tag, err := db.Exec("INSERT INTO tag(namespace,normalized_name,display_name,language) VALUES ('dlsite','synthetic legacy','Synthetic legacy','ja-jp')")
	if err != nil {
		t.Fatal(err)
	}
	oldID, _ := tag.LastInsertId()
	for ordinal := 0; ordinal < 70; ordinal++ {
		result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?, 'Synthetic backfill work')", testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		if _, err := db.Exec("INSERT INTO work_tag(work_id,tag_id,source) VALUES (?,?,'dlsite')", id, oldID); err != nil {
			t.Fatal(err)
		}
	}
	var frontier int64
	if err := db.QueryRow("SELECT MAX(id) FROM work").Scan(&frontier); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	_, err = projectMetadataBatch(ctx, tx, 0, frontier, nil)
	if err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var converted int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_tag INNER JOIN tag ON tag.id=work_tag.tag_id WHERE tag.namespace='metadata'").Scan(&converted); err != nil {
		t.Fatal(err)
	}
	if converted != 64 {
		t.Fatalf("first bounded batch converted %d works, want 64", converted)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if err := BackfillMetadataTags(cancelled, db, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled backfill error = %v", err)
	}
	var marker int
	if err := db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key='metadata_tag_projection_version'").Scan(&marker); err != nil {
		t.Fatal(err)
	}
	if marker != 0 {
		t.Fatal("incomplete backfill recorded completion")
	}
	if err := BackfillMetadataTags(ctx, db, nil); err != nil {
		t.Fatal(err)
	}
	var works, legacy int
	if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_tag WHERE tag_id=?", oldID).Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	if works != 70 || legacy != 0 {
		t.Fatalf("backfill works=%d legacy links=%d, want 70/0", works, legacy)
	}
	var before, after int64
	if err := db.QueryRow("SELECT revision FROM recommendation_input_revision WHERE id=1").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := BackfillMetadataTags(ctx, db, nil); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT revision FROM recommendation_input_revision WHERE id=1").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("completed backfill ran again")
	}
}

func TestMetadataTagCanonicalSelectionLeavesOtherEditionsOwnGenres(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec("DELETE FROM work"); err != nil {
		t.Fatal(err)
	}
	var provider int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code='dlsite'").Scan(&provider); err != nil {
		t.Fatal(err)
	}
	ids := []int64{}
	for ordinal := 0; ordinal < 3; ordinal++ {
		result, err := db.Exec("INSERT INTO work(primary_code,title) VALUES (?,'Synthetic edition')", testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		ids = append(ids, id)
	}
	result, err := db.Exec("INSERT INTO logical_work(canonical_work_id,canonical_code) VALUES (?,?)", ids[0], testfixture.WorkCode(testfixture.PrefixRJ, 0))
	if err != nil {
		t.Fatal(err)
	}
	logical, _ := result.LastInsertId()
	locales := []string{"ja-jp", "zh-cn", "en-us"}
	var concepts []int64
	for ordinal, id := range ids {
		code := testfixture.WorkCode(testfixture.PrefixRJ, ordinal)
		if _, err := db.Exec("INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,metadata_language,is_canonical) VALUES (?,?,?,?,?,?)", id, logical, provider, code, locales[ordinal], ordinal == 0); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO dlsite_metadata_variant(logical_work_id,work_id,provider_id,external_id,edition_language,request_locale,title) VALUES (?,?,?,?,?,?,?)", logical, id, provider, code, locales[ordinal], locales[ordinal], "Synthetic "+locales[ordinal]); err != nil {
			t.Fatal(err)
		}
		genre := int64(ordinal + 1)
		if _, err := db.Exec("INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,?)", id, genre); err != nil {
			t.Fatal(err)
		}
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		concept, err := metadatatags.EnsureGenreTx(ctx, tx, genre)
		if err != nil {
			_ = tx.Rollback()
			t.Fatal(err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
		concepts = append(concepts, concept)
	}
	assert := func(work, id int64) {
		t.Helper()
		tags, err := metadatatags.Read(ctx, db, work)
		if err != nil {
			t.Fatal(err)
		}
		if len(tags) != 1 || tags[0].ID != id {
			t.Fatalf("work %d tags %+v want %d", work, tags, id)
		}
	}
	if err := ProjectDLsiteMetadata(ctx, db, []string{"zh-cn", "origin"}); err != nil {
		t.Fatal(err)
	}
	assert(ids[0], concepts[1])
	assert(ids[1], concepts[1])
	assert(ids[2], concepts[2])
	if err := ProjectDLsiteMetadata(ctx, db, []string{"en-us", "origin"}); err != nil {
		t.Fatal(err)
	}
	assert(ids[0], concepts[2])
	assert(ids[1], concepts[1])
	assert(ids[2], concepts[2])
}
