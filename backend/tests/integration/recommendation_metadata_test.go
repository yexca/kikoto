package integration_test

import (
	"context"
	"database/sql"
	"fmt"
	"testing"

	"github.com/yexca/kikoto/backend/internal/circleidentity"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func publishRecommendationMetadata(t *testing.T, db *sql.DB, store *library.Store) {
	t.Helper()
	for {
		processed, err := metasync.ProcessMetadataTagQueue(context.Background(), db, 64, nil)
		if err != nil {
			t.Fatal(err)
		}
		if processed == 0 {
			break
		}
	}
	for {
		processed, err := store.ProcessRecommendationCatalog(context.Background(), 64)
		if err != nil {
			t.Fatal(err)
		}
		if processed == 0 {
			break
		}
	}
}

func TestRecommendationCatalogFollowsTagMergeVisibilityUndoAndFrozenAliases(t *testing.T) {
	db := openMigratedTestDB(t, "recommendation-tag-workflows.db")
	ctx := context.Background()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO user_account(id,username,display_name,role) VALUES(1,'synthetic-user','Example User','user')")
	for index := range 3 {
		exec("INSERT INTO work(id,primary_code,title) VALUES(?,?,?)", index+1, testfixture.WorkCode(testfixture.PrefixRJ, index), fmt.Sprintf("Example Work %d", index))
	}
	var source, target int64
	change := func(run func(*sql.Tx) error) {
		t.Helper()
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback() }()
		for _, id := range []int64{source, target} {
			if err := metadatatags.EnqueueAffectedTx(ctx, tx, id); err != nil {
				t.Fatal(err)
			}
		}
		if err := run(tx); err != nil {
			t.Fatal(err)
		}
		for _, id := range []int64{source, target} {
			if err := metadatatags.EnqueueAffectedTx(ctx, tx, id); err != nil {
				t.Fatal(err)
			}
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	change(func(tx *sql.Tx) error {
		var err error
		source, err = metadatatags.CreateTx(ctx, tx, "Example Source Tag", 1)
		if err != nil {
			return err
		}
		target, err = metadatatags.CreateTx(ctx, tx, "Example Target Tag", 1)
		if err != nil {
			return err
		}
		for _, id := range []int64{source, target} {
			if err := metadatatags.SetNameTx(ctx, tx, id, "en-us", "Example Ambiguous Tag", 1); err != nil {
				return err
			}
		}
		for work := int64(1); work <= 3; work++ {
			tag := source
			if work == 2 {
				tag = target
			}
			if err := metadatatags.SetOverridesTx(ctx, tx, work, []metadatatags.Override{{TagID: tag, Action: "add"}}, 1); err != nil {
				return err
			}
			if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, work, nil); err != nil {
				return err
			}
		}
		return nil
	})
	exec("INSERT INTO user_work_state(user_id,work_id,listening_status) VALUES(1,1,'relisten')")
	store := library.NewStore(db)
	publishRecommendationMetadata(t, db, store)
	prepare := func(session string) library.RecommendationSessionSnapshot {
		t.Helper()
		snapshot, err := store.PrepareRecommendationSession(ctx, 1, session)
		if err != nil {
			t.Fatal(err)
		}
		return snapshot
	}
	assertTagMatches := func(snapshot library.RecommendationSessionSnapshot, work int64, want int) {
		t.Helper()
		result, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, work)
		if err != nil || result.Signals.PositiveTagMatches != want {
			t.Fatalf("work %d matches=%+v,error=%v,want=%d", work, result, err, want)
		}
	}
	assertRemote := func(session string, names []string, want int) {
		t.Helper()
		results, err := store.ScoreRecommendationCandidates(ctx, 1, session, []library.RecommendationCandidate{{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 90), Tags: names}})
		if err != nil || len(results) != 1 || results[0].Signals.PositiveTagMatches != want {
			t.Fatalf("remote %s names=%v results=%+v,error=%v,want=%d", session, names, results, err, want)
		}
	}
	first := prepare("synthetic-tags-original")
	assertTagMatches(first, 2, 0)
	assertTagMatches(first, 3, 1)
	assertRemote("synthetic-tags-original", []string{"Example Ambiguous Tag"}, 0)
	// A source's hidden flag is dormant while it resolves to a visible target.
	change(func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", source); err != nil {
			return err
		}
		return metadatatags.MergeTx(ctx, tx, source, target)
	})
	if _, err := store.ProcessRecommendationCatalog(ctx, 64); err != nil {
		t.Fatal(err)
	}
	beforeProjection := prepare("synthetic-tags-pending-projection")
	if beforeProjection.CatalogEpoch != first.CatalogEpoch {
		t.Fatal("names published before effective metadata projection")
	}
	publishRecommendationMetadata(t, db, store)
	merged := prepare("synthetic-tags-merged")
	assertTagMatches(merged, 2, 1)
	mergedBreakdown, err := store.RecommendationSnapshotBreakdown(ctx, merged, 2)
	if err != nil || mergedBreakdown.Signals.Affinity == nil || mergedBreakdown.Signals.Affinity.Tags != 0.5 || mergedBreakdown.Score != 38 {
		t.Fatalf("merged work frequency changed affinity: %+v,%v", mergedBreakdown, err)
	}
	assertRemote("synthetic-tags-merged", []string{"Example Source Tag", "Example Target Tag", "Example Ambiguous Tag"}, 1)
	assertTagMatches(first, 2, 0)
	assertRemote("synthetic-tags-original", []string{"Example Target Tag"}, 0)
	change(func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE metadata_tag SET hidden=1 WHERE tag_id=?", target)
		return err
	})
	publishRecommendationMetadata(t, db, store)
	hidden := prepare("synthetic-tags-hidden")
	assertTagMatches(hidden, 2, 0)
	assertRemote("synthetic-tags-hidden", []string{"Example Source Tag"}, 0)
	assertTagMatches(merged, 2, 1)
	frozenMerged, err := store.RecommendationSnapshotBreakdown(ctx, merged, 2)
	if err != nil || frozenMerged.Score != mergedBreakdown.Score {
		t.Fatalf("hidden target changed retained score: %+v,%v", frozenMerged, err)
	}
	change(func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE metadata_tag SET hidden=0 WHERE tag_id=?", target); err != nil {
			return err
		}
		return metadatatags.MergeTx(ctx, tx, source, 0)
	})
	publishRecommendationMetadata(t, db, store)
	undone := prepare("synthetic-tags-undone")
	assertTagMatches(undone, 3, 0)
	change(func(tx *sql.Tx) error {
		_, err := tx.Exec("UPDATE metadata_tag SET hidden=0 WHERE tag_id=?", source)
		return err
	})
	publishRecommendationMetadata(t, db, store)
	restored := prepare("synthetic-tags-restored")
	assertTagMatches(restored, 2, 0)
	assertTagMatches(restored, 3, 1)
	assertRemote("synthetic-tags-restored", []string{"Example Ambiguous Tag"}, 0)
	assertRemote("synthetic-tags-merged", []string{"Example Ambiguous Tag"}, 1)
	var works int
	if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil || works != 3 {
		t.Fatalf("remote scoring materialized work: %d,%v", works, err)
	}
}

func TestRecommendationCatalogFollowsCircleMergeAndUndoWithoutChangingFrozenSessions(t *testing.T) {
	db := openMigratedTestDB(t, "recommendation-circle-workflows.db")
	ctx := context.Background()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO user_account(id,username,display_name,role) VALUES(1,'synthetic-user','Example User','user'); INSERT INTO work(id,primary_code,title) VALUES(1,'RJ00000000','Example Work'),(2,'RJ00000001','Example Other Work'); INSERT INTO party(id,display_name) VALUES(1,'Example Source Circle'),(2,'Example Target Circle'); INSERT INTO work_party(work_id,party_id,role,source) VALUES(1,1,'circle','test'),(2,2,'circle','test'); INSERT INTO user_work_state(user_id,work_id,listening_status) VALUES(1,1,'relisten')")
	store := library.NewStore(db)
	publishRecommendationMetadata(t, db, store)
	prepare := func(session string) library.RecommendationSessionSnapshot {
		t.Helper()
		snapshot, err := store.PrepareRecommendationSession(ctx, 1, session)
		if err != nil {
			t.Fatal(err)
		}
		return snapshot
	}
	assertCircle := func(snapshot library.RecommendationSessionSnapshot, want int) {
		t.Helper()
		result, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 2)
		if err != nil || result.Signals.PositiveCircleMatches != want {
			t.Fatalf("circle matches=%+v,%v,want=%d", result, err, want)
		}
	}
	first := prepare("synthetic-circle-original")
	assertCircle(first, 0)
	mergeID, err := circleidentity.Merge(ctx, db, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	publishRecommendationMetadata(t, db, store)
	merged := prepare("synthetic-circle-merged")
	assertCircle(merged, 1)
	assertCircle(first, 0)
	if err := circleidentity.Undo(ctx, db, 2, mergeID); err != nil {
		t.Fatal(err)
	}
	publishRecommendationMetadata(t, db, store)
	undone := prepare("synthetic-circle-undone")
	assertCircle(undone, 0)
	assertCircle(merged, 1)
}
