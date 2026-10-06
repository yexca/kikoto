package metadatatags_test

import (
	"context"
	"database/sql"
	"reflect"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestMergedTagVisibilitySearchNamesAndUndo(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	works := []int64{}
	for ordinal := 0; ordinal < 2; ordinal++ {
		works = append(works, execTag(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Synthetic merge work')", testfixture.WorkCode(testfixture.PrefixRJ, ordinal)))
	}
	execTag(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Synthetic source dictionary'),(1,'zh-cn','合成来源标签')")
	var source, target int64
	tagTx(t, db, func(tx *sql.Tx) error {
		var err error
		source, err = metadatatags.EnsureGenreTx(ctx, tx, 1)
		if err != nil {
			return err
		}
		if err := metadatatags.SetNameTx(ctx, tx, source, "en-us", "Synthetic source alias", 0); err != nil {
			return err
		}
		target, err = metadatatags.CreateTx(ctx, tx, "Synthetic target alias", 0)
		return err
	})
	execTag(t, db, "INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,1)", works[0])
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.SetOverridesTx(ctx, tx, works[1], []metadatatags.Override{{TagID: target, Action: "add"}}, 0); err != nil {
			return err
		}
		for _, work := range works {
			if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
				return err
			}
		}
		return nil
	})
	store := library.NewStore(db)
	search := func(name string, want int) {
		t.Helper()
		page, err := store.ListPage(ctx, library.ListOptions{Query: "tag:\"" + name + "\"", PageSize: 100})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != want {
			t.Fatalf("search %q = %d, want %d", name, page.Total, want)
		}
	}
	search("Synthetic source alias", 1)
	change := func(run func(*sql.Tx) error) {
		t.Helper()
		tagTx(t, db, func(tx *sql.Tx) error {
			if err := run(tx); err != nil {
				return err
			}
			for _, work := range works {
				if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
					return err
				}
			}
			return nil
		})
	}
	// Hiding a source is dormant while it resolves to a visible target.
	change(func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", source); err != nil {
			return err
		}
		return metadatatags.MergeTx(ctx, tx, source, target)
	})
	for _, work := range works {
		requireWorkTags(t, db, work, target)
	}
	for _, name := range []string{"Synthetic target alias", "Synthetic source alias", "Synthetic source dictionary", "合成来源标签"} {
		search(name, 2)
	}
	// A source-language change invalidates documents linked to the terminal tag,
	// even though their chosen display name and effective links do not change.
	tagTx(t, db, func(tx *sql.Tx) error {
		return metadatatags.SetNameTx(ctx, tx, source, "en-us", "Synthetic renamed alias", 0)
	})
	search("Synthetic renamed alias", 2)
	search("Synthetic source alias", 0)
	tagTx(t, db, func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE dlsite_genre_name SET name='Synthetic updated dictionary' WHERE genre_id=1 AND language='ja-jp'"); err != nil {
			return err
		}
		_, err := metadatatags.EnsureGenreTx(ctx, tx, 1)
		return err
	})
	search("Synthetic updated dictionary", 2)
	search("Synthetic source dictionary", 0)
	change(func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", target)
		return err
	})
	for _, work := range works {
		requireWorkTags(t, db, work)
	}
	search("Synthetic renamed alias", 0)
	change(func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE metadata_tag SET hidden=0 WHERE tag_id=?", target)
		return err
	})
	change(func(tx *sql.Tx) error { return metadatatags.MergeTx(ctx, tx, source, 0) })
	requireWorkTags(t, db, works[0]) // original hidden flag applies again
	requireWorkTags(t, db, works[1], target)
	search("Synthetic renamed alias", 0)
	change(func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE metadata_tag SET hidden=0 WHERE tag_id=?", source)
		return err
	})
	requireWorkTags(t, db, works[0], source)
	search("Synthetic renamed alias", 1)
	search("Synthetic target alias", 1)
}

func TestEditionTagPresentationUsesOwnLanguageAndPriorityFallback(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	work := execTag(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Synthetic localized work')", testfixture.WorkCode(testfixture.PrefixRJ, 0))
	execTag(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Synthetic Japanese'),(1,'zh-cn','合成中文'),(1,'en-us','Synthetic English'),(2,'ja-jp','Synthetic removed'),(3,'ja-jp','Synthetic hidden')")
	var genre, removed, hidden, custom int64
	tagTx(t, db, func(tx *sql.Tx) error {
		var err error
		genre, err = metadatatags.EnsureGenreTx(ctx, tx, 1)
		if err != nil {
			return err
		}
		removed, err = metadatatags.EnsureGenreTx(ctx, tx, 2)
		if err != nil {
			return err
		}
		hidden, err = metadatatags.EnsureGenreTx(ctx, tx, 3)
		if err != nil {
			return err
		}
		custom, err = metadatatags.CreateTx(ctx, tx, "Synthetic custom", 0)
		if err != nil {
			return err
		}
		if err := metadatatags.SetNameTx(ctx, tx, genre, "en-us", "Synthetic manual English", 0); err != nil {
			return err
		}
		if _, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", hidden); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,1),(?,2),(?,3)", work, work, work); err != nil {
			return err
		}
		return metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: removed, Action: "remove"}, {TagID: custom, Action: "add"}}, 0)
	})
	// The stored display name is the original-language name; a viewer's
	// priority and an edition's own language only change the presentation.
	// Tags keep the stored-name order, where the genre sorts first.
	viewer := []string{"zh-cn", "origin"}
	assert := func(language string, priorities []string, want string) {
		t.Helper()
		names, err := metadatatags.PresentationFor(ctx, db, work, work, nil, priorities, language)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(names, []string{want, "Synthetic custom"}) {
			t.Fatalf("%s/%v tags = %v", language, priorities, names)
		}
	}
	assert("", nil, "Synthetic Japanese")
	assert("ja-jp", viewer, "Synthetic Japanese")
	assert("en-us", viewer, "Synthetic manual English")
	assert("ko-kr", viewer, "合成中文")
	assert("", viewer, "合成中文")
	assert("ko-kr", nil, "Synthetic Japanese")
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.MergeTx(ctx, tx, removed, genre); err != nil {
			return err
		}
		return nil
	})
	names, err := metadatatags.Presentation(ctx, db, work, work, nil, "en-us")
	if err != nil || !reflect.DeepEqual(names, []string{"Synthetic custom"}) {
		t.Fatalf("merged removal = %v, %v", names, err)
	}
}

func TestSharedTagCreationReusesAnyLanguageNameAndConcurrentDrafts(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	execTag(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Synthetic Japanese'),(1,'en-us','Synthetic Dictionary')")
	var existing int64
	tagTx(t, db, func(tx *sql.Tx) error {
		var err error
		existing, err = metadatatags.EnsureGenreTx(ctx, tx, 1)
		if err != nil {
			return err
		}
		return metadatatags.SetNameTx(ctx, tx, existing, "zh-cn", "合成手动名称", 0)
	})
	for _, name := range []string{" synthetic DICTIONARY ", " 合成手动名称 ", "SYNTHETIC JAPANESE"} {
		tagTx(t, db, func(tx *sql.Tx) error {
			id, err := metadatatags.CreateTx(ctx, tx, name, 0)
			if err == nil && id != existing {
				t.Fatalf("name %q created %d, want existing %d", name, id, existing)
			}
			return err
		})
	}
	var wg sync.WaitGroup
	ids := make(chan int64, 8)
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				errors <- err
				return
			}
			defer func() { _ = tx.Rollback() }()
			id, err := metadatatags.CreateTx(ctx, tx, "  Synthetic Concurrent  ", 0)
			if err == nil {
				err = tx.Commit()
			}
			if err != nil {
				errors <- err
			} else {
				ids <- id
			}
		})
	}
	wg.Wait()
	close(ids)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	var first int64
	for id := range ids {
		if first == 0 {
			first = id
		}
		if first != id {
			t.Fatalf("concurrent creation produced %d and %d", first, id)
		}
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_tag").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("concept count = %d, want 2", count)
	}
}
