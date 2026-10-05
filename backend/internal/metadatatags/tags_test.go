package metadatatags_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/migrations"
)

func openTagDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "tags.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if err := storage.MigrateFS(db, migrations.Files, "test"); err != nil {
		t.Fatal(err)
	}
	return db
}
func execTag(t *testing.T, db *sql.DB, query string, args ...any) int64 {
	t.Helper()
	result, err := db.Exec(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func tagTx(t *testing.T, db *sql.DB, run func(*sql.Tx) error) {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := run(tx); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}
func readTag(t *testing.T, db *sql.DB, id int64) metadatatags.Tag {
	t.Helper()
	tag, err := metadatatags.Load(context.Background(), db, id)
	if err != nil {
		t.Fatal(err)
	}
	return tag
}
func requireWorkTags(t *testing.T, db *sql.DB, workID int64, ids ...int64) {
	t.Helper()
	tags, err := metadatatags.Read(context.Background(), db, workID)
	if err != nil {
		t.Fatal(err)
	}
	found := map[int64]bool{}
	for _, tag := range tags {
		found[tag.ID] = true
	}
	if len(tags) != len(ids) {
		t.Fatalf("effective tags = %+v, want ids %v", tags, ids)
	}
	for _, id := range ids {
		if !found[id] {
			t.Fatalf("effective tags = %+v, missing %d", tags, id)
		}
	}
}

func TestLegacySnapshotTagsCanBeRemovedAndRestoredThroughSharedDictionaryIdentity(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	workID := execTag(t, db, "INSERT INTO work(primary_code,title) VALUES (?,?)", testfixture.WorkCode(testfixture.PrefixRJ, 0), "Synthetic legacy metadata work")
	execTag(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Synthetic inherited name'),(1,'zh-cn','示例继承标签')")
	legacy := []string{" Synthetic inherited name "}
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.ProjectWorkTx(ctx, tx, workID, workID, legacy); err != nil {
			return err
		}
		return metadatatags.RefreshNamesTx(ctx, tx, []string{"zh-cn"})
	})
	inherited, err := metadatatags.Inherited(ctx, db, workID, legacy)
	if err != nil {
		t.Fatal(err)
	}
	if len(inherited) != 1 || inherited[0].DisplayName != "示例继承标签" {
		t.Fatalf("inherited tags = %+v, want shared dictionary name", inherited)
	}
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.SetOverridesTx(ctx, tx, workID, []metadatatags.Override{{TagID: inherited[0].ID, Action: "remove"}}, 0); err != nil {
			return err
		}
		return metadatatags.ProjectWorkTx(ctx, tx, workID, workID, legacy)
	})
	chips, err := metadatatags.Presentation(ctx, db, workID, workID, legacy)
	if err != nil || len(chips) != 0 {
		t.Fatalf("removed snapshot tags = %v, error = %v", chips, err)
	}
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.SetOverridesTx(ctx, tx, workID, nil, 0); err != nil {
			return err
		}
		return metadatatags.ProjectWorkTx(ctx, tx, workID, workID, legacy)
	})
	requireWorkTags(t, db, workID, inherited[0].ID)
}

func TestSharedTagsLanguagesOverridesSearchAndRecommendation(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	user := execTag(t, db, "INSERT INTO user_account(username,role) VALUES ('tag-user','user')")
	works := []int64{}
	for ordinal := 0; ordinal < 3; ordinal++ {
		works = append(works, execTag(t, db, "INSERT INTO work(primary_code,title) VALUES (?,?)", testfixture.WorkCode(testfixture.PrefixRJ, ordinal), "Synthetic tag work"))
	}
	execTag(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','Example Japanese tag'),(1,'zh-cn','示例标签'),(1,'en-us','Example dictionary tag')")
	var genre, custom int64
	tagTx(t, db, func(tx *sql.Tx) error {
		var err error
		genre, err = metadatatags.EnsureGenreTx(ctx, tx, 1)
		if err != nil {
			return err
		}
		custom, err = metadatatags.CreateTx(ctx, tx, "Example custom tag", user)
		return err
	})
	for _, id := range works[:2] {
		execTag(t, db, "INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,1)", id)
	}
	execTag(t, db, "INSERT INTO user_work_state(user_id,work_id,listening_status) VALUES (?,?,'relisten')", user, works[0])
	if err := metasync.BackfillMetadataTags(ctx, db, []string{"zh-cn", "origin"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range works[:2] {
		requireWorkTags(t, db, id, genre)
	}
	if got := readTag(t, db, genre); got.DisplayName != "示例标签" || got.WorkCount != 2 {
		t.Fatalf("shared concept = %+v", got)
	}
	store := library.NewStore(db)
	first, err := store.PrepareRecommendationSession(ctx, user, "shared-tags-first")
	if err != nil {
		t.Fatal(err)
	}
	breakdown, err := store.RecommendationSnapshotBreakdown(ctx, first, works[1])
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Signals.PositiveTagMatches != 1 {
		t.Fatalf("cross-language recommendation = %+v", breakdown)
	}
	assertSearch := func(query string, want int) {
		t.Helper()
		page, err := store.ListPage(ctx, library.ListOptions{UserID: user, Query: query, PageSize: 100})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != want {
			t.Fatalf("search %q total %d, want %d", query, page.Total, want)
		}
	}
	assertSearch("tag:示例标签", 2)
	// A non-display manual name must invalidate search even though the chosen
	// Chinese display name and all work_tag relations remain unchanged.
	tagTx(t, db, func(tx *sql.Tx) error {
		return metadatatags.SetNameTx(ctx, tx, genre, "en-us", "Synthetic alternate tag", user)
	})
	assertSearch("tag:\"Synthetic alternate tag\"", 2)
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.SetOverridesTx(ctx, tx, works[1], []metadatatags.Override{{TagID: genre, Action: "remove"}}, user); err != nil {
			return err
		}
		return metasync.ProjectWorkMetadataTagsTx(ctx, tx, works[1], []string{"zh-cn"})
	})
	requireWorkTags(t, db, works[1])
	assertSearch("tag:示例标签", 1)
	assertSearch("tag:\"Synthetic alternate tag\"", 1)
	second, err := store.PrepareRecommendationSession(ctx, user, "shared-tags-second")
	if err != nil {
		t.Fatal(err)
	}
	if second.GenerationID == first.GenerationID {
		t.Fatal("tag change reused stale recommendation generation")
	}
	breakdown, err = store.RecommendationSnapshotBreakdown(ctx, second, works[1])
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Signals.PositiveTagMatches != 0 {
		t.Fatalf("removed tag recommendation = %+v", breakdown)
	}
	var version string
	if err := db.QueryRow("SELECT algorithm_version FROM recommendation_generation WHERE id=?", second.GenerationID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != library.RecommendationAlgorithmVersion {
		t.Fatal("algorithm version unexpectedly changed")
	}
	// A local work with no provider data can use a custom shared tag.
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.SetOverridesTx(ctx, tx, works[2], []metadatatags.Override{{TagID: custom, Action: "add"}}, user); err != nil {
			return err
		}
		return metasync.ProjectWorkMetadataTagsTx(ctx, tx, works[2], nil)
	})
	requireWorkTags(t, db, works[2], custom)
	tagTx(t, db, func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", genre)
		return err
	})
	if err := metasync.ProjectDLsiteMetadata(ctx, db, []string{"zh-cn"}); err != nil {
		t.Fatal(err)
	}
	requireWorkTags(t, db, works[0])
	assertSearch("tag:示例标签", 0)
	assertSearch("tag:\"Example Japanese tag\"", 0)
	// Refreshing unchanged projection must not invalidate another generation.
	var before, after int64
	if err := db.QueryRow("SELECT revision FROM recommendation_input_revision WHERE id=1").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := metasync.ProjectDLsiteMetadata(ctx, db, []string{"zh-cn"}); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT revision FROM recommendation_input_revision WHERE id=1").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatalf("unchanged projection revision %d -> %d", before, after)
	}
}

func TestTagMergeRemovalWinsAndUndoRetainsOriginalIdentities(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	work := execTag(t, db, "INSERT INTO work(primary_code,title) VALUES (?, 'Synthetic manual work')", testfixture.WorkCode(testfixture.PrefixRJ, 0))
	var source, target int64
	tagTx(t, db, func(tx *sql.Tx) error {
		var err error
		source, err = metadatatags.CreateTx(ctx, tx, "Synthetic source", 0)
		if err != nil {
			return err
		}
		target, err = metadatatags.CreateTx(ctx, tx, "Synthetic target", 0)
		return err
	})
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.MergeTx(ctx, tx, source, target); err != nil {
			return err
		}
		if err := metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: source, Action: "add"}, {TagID: target, Action: "remove"}}, 0); err != nil {
			return err
		}
		return metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil)
	})
	requireWorkTags(t, db, work)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	err = metadatatags.MergeTx(ctx, tx, target, source)
	_ = tx.Rollback()
	if !errors.Is(err, metadatatags.ErrInvalid) {
		t.Fatalf("cycle error = %v", err)
	}
	tagTx(t, db, func(tx *sql.Tx) error {
		if err := metadatatags.MergeTx(ctx, tx, source, 0); err != nil {
			return err
		}
		return metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil)
	})
	requireWorkTags(t, db, work, source)
}

func TestTagDisplayNamePriorityAndManualReset(t *testing.T) {
	db := openTagDB(t)
	ctx := context.Background()
	var id int64
	execTag(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (7,'ja-jp','Synthetic Japanese'),(7,'zh-cn','合成中文'),(7,'en-us','Synthetic English')")
	tagTx(t, db, func(tx *sql.Tx) error { var err error; id, err = metadatatags.EnsureGenreTx(ctx, tx, 7); return err })
	refresh := func(priorities []string, want string) {
		t.Helper()
		tagTx(t, db, func(tx *sql.Tx) error { return metadatatags.RefreshNamesTx(ctx, tx, priorities) })
		if got := readTag(t, db, id).DisplayName; got != want {
			t.Fatalf("display %q want %q", got, want)
		}
	}
	refresh([]string{"zh-cn", "origin"}, "合成中文")
	tagTx(t, db, func(tx *sql.Tx) error { return metadatatags.SetNameTx(ctx, tx, id, "en-us", "Manual English", 0) })
	refresh([]string{"en-us", "zh-cn"}, "Manual English")
	tagTx(t, db, func(tx *sql.Tx) error { return metadatatags.SetNameTx(ctx, tx, id, "", "Universal name", 0) })
	refresh([]string{"zh-cn"}, "Universal name")
	tagTx(t, db, func(tx *sql.Tx) error { return metadatatags.SetNameTx(ctx, tx, id, "", "", 0) })
	refresh([]string{"ko-kr", "origin"}, "Synthetic Japanese")
}
