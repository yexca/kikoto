package library

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

// The default weights in hundredths of a favorite: 5★ 150, 4★ 100, 2★ −75,
// 1★ −125, unrated Relisten 50, unrated Shelved −35.
func TestFrozenAffinityWeighsRatingsBeforeMarks(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 9, 0, 0)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("DELETE FROM user_work_state")
	exec("INSERT INTO person(id,display_name) VALUES (1,'Example Loved Voice'),(2,'Example Mixed Voice'),(3,'Example Neutral Voice'),(4,'Example Relisten Voice')")
	exec("INSERT INTO party(id,display_name) VALUES (1,'Example Shelved Circle')")
	voices := map[int][]int{1: {1}, 2: {1}, 3: {2}, 4: {2}, 7: {3}, 8: {4}, 9: {1, 2, 3, 4}}
	for work, people := range voices {
		for _, person := range people {
			exec("INSERT INTO work_credit(work_id,person_id,role,source) VALUES (?,?,'voice_actor','test')", work, person)
		}
	}
	for _, work := range []int{5, 6, 9} {
		exec("INSERT INTO work_party(work_id,party_id,role,source) VALUES (?,1,'circle','test')", work)
	}
	// A rating outranks the work's marks: work 2 is a favorite rated four
	// stars, and work 7 is a Relisten rated a neutral three.
	exec(`INSERT INTO user_work_state(user_id,work_id,listening_status,favorite,rating) VALUES
		(?,1,'none',0,5),(?,2,'finished',1,4),(?,3,'finished',0,1),(?,4,'none',1,NULL),
		(?,5,'paused',0,NULL),(?,6,'paused',0,NULL),(?,7,'relisten',0,3),(?,8,'relisten',0,NULL)`,
		userID, userID, userID, userID, userID, userID, userID, userID)
	scaleDrainCatalog(t, store)
	ctx := context.Background()
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-rating-weights")
	if err != nil {
		t.Fatal(err)
	}
	breakdown := func(id int64) RecommendationBreakdown {
		t.Helper()
		result, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, id)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	contribution := func(result RecommendationBreakdown, key string) int {
		for _, component := range result.Components {
			if component.Key == key {
				return component.Contribution
			}
		}
		t.Fatalf("component %s missing from %+v", key, result.Components)
		return 0
	}

	// Voices: the loved voice nets 250 (strength 1.375) and the relisten voice
	// 50 (0.5), so 1.875 × 10 rounds to 19; the neutral voice adds nothing.
	// The mixed voice nets −25 with one disliked work (0.25 × 3 → 1), and the
	// shelved circle nets −70 from two shelved works (0.7 × 5 → 4).
	candidate := breakdown(9)
	if candidate.Signals.PositiveVoiceMatches != 2 || contribution(candidate, "voices") != 19 ||
		candidate.Signals.NegativeVoiceMatches != 1 || candidate.Signals.NegativeCircleMatches != 1 ||
		contribution(candidate, "disliked_similarity") != -5 || candidate.Score != 49 {
		t.Fatalf("candidate=%+v", candidate)
	}
	// A work's own rating never supports it, while Favorite still adds its bonus.
	if self := breakdown(1); contribution(self, "voices") != 10 || self.Score != 45 {
		t.Fatalf("self-excluded rating=%+v", self)
	}
	if favorite := breakdown(2); contribution(favorite, "voices") != 11 || contribution(favorite, "favorite") != 10 || favorite.Score != 56 {
		t.Fatalf("rated favorite=%+v", favorite)
	}
	// One remaining shelved work is below the default two-work threshold.
	if shelved := breakdown(6); shelved.Signals.NegativeCircleMatches != 0 || shelved.Score != 35 {
		t.Fatalf("single shelved work=%+v", shelved)
	}
	var scores, states int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_snapshot WHERE generation_id=?", snapshot.GenerationID).Scan(&scores); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_generation_state WHERE generation_id=?", snapshot.GenerationID).Scan(&states); err != nil {
		t.Fatal(err)
	}
	if scores != 0 || states != 8 {
		t.Fatalf("generation dense scores/sparse state=%d/%d", scores, states)
	}
}

func TestRatingChangeStartsNewRecommendationGeneration(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 2, 0, 0)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("DELETE FROM user_work_state")
	exec("INSERT INTO person(id,display_name) VALUES (1,'Example Voice')")
	exec("INSERT INTO work_credit(work_id,person_id,role,source) VALUES (1,1,'voice_actor','test'),(2,1,'voice_actor','test')")
	exec("INSERT INTO user_work_state(user_id,work_id,listening_status) VALUES (?,1,'finished')", userID)
	scaleDrainCatalog(t, store)
	ctx := context.Background()
	before, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-before-rating")
	if err != nil {
		t.Fatal(err)
	}
	exec("UPDATE user_work_state SET rating = 5 WHERE user_id = ? AND work_id = 1", userID)
	after, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-after-rating")
	if err != nil {
		t.Fatal(err)
	}
	if after.GenerationID == before.GenerationID {
		t.Fatal("a new rating reused the generation prepared before it")
	}
	unrated, err := store.RecommendationSnapshotBreakdown(ctx, before, 2)
	if err != nil {
		t.Fatal(err)
	}
	rated, err := store.RecommendationSnapshotBreakdown(ctx, after, 2)
	if err != nil {
		t.Fatal(err)
	}
	if unrated.Score != 35 || rated.Score != 46 {
		t.Fatalf("unrated=%d rated=%d", unrated.Score, rated.Score)
	}
}

func TestCatalogBackfillPublishesAtomicallyAndSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "catalog.db")
	db := storagetest.OpenFile(t, path)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec("INSERT INTO user_account(id,username,display_name,role) VALUES (1,'synthetic-user','Example User','user'); INSERT INTO work(id,primary_code,title) VALUES(1,'RJ00000000','Example Work'),(2,'RJ00000001','Example Other Work')"); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	if _, err := store.PrepareRecommendationSession(ctx, 1, "synthetic-before-ready"); !errors.Is(err, ErrRecommendationNotReady) {
		t.Fatalf("initial preparation=%v", err)
	}
	page, err := store.ListPage(ctx, ListOptions{PageSize: 24, Sort: "recent"})
	if err != nil || page.Total != 2 {
		t.Fatalf("ordinary browse while preparing=%+v,%v", page, err)
	}
	if processed, err := store.ProcessRecommendationCatalog(ctx, 1); err != nil || processed != 1 {
		t.Fatalf("batch=%d,%v", processed, err)
	}
	if _, err := store.publishedRecommendationEpoch(ctx); !errors.Is(err, ErrRecommendationNotReady) {
		t.Fatalf("partial epoch exposed: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	store = NewStore(db)
	scaleDrainCatalog(t, store)
	snapshot, err := store.PrepareRecommendationSession(ctx, 1, "synthetic-ready")
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT work_count FROM recommendation_catalog_epoch WHERE id=? AND published=1", snapshot.CatalogEpoch).Scan(&count); err != nil || count != 2 {
		t.Fatalf("published count=%d,%v", count, err)
	}
	if _, err := db.Exec("INSERT INTO work(id,primary_code,title) VALUES(3,'RJ00000002','Example New Work')"); err != nil {
		t.Fatal(err)
	}
	neutral, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 3)
	if err != nil || neutral.Score != 35 {
		t.Fatalf("work outside frozen epoch=%+v,%v", neutral, err)
	}
	page, err = store.ListPage(ctx, ListOptions{UserID: 1, PageSize: 24, Sort: "recommend", RecommendationSessionID: "synthetic-ready"})
	if err != nil || page.Total != 3 || len(page.Works) != 3 {
		t.Fatalf("new work disappeared before projection: %+v,%v", page, err)
	}
	if _, err := db.Exec("DELETE FROM work WHERE id=2"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 2); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted work explanation=%v", err)
	}
	page, err = store.ListPage(ctx, ListOptions{UserID: 1, PageSize: 24, Sort: "recommend", RecommendationSessionID: "synthetic-ready"})
	if err != nil || page.Total != 2 || len(page.Works) != 2 {
		t.Fatalf("deleted work remains browsable: %+v,%v", page, err)
	}
}

func TestCatalogCancellationRollbackAndReferencedHistoryRetention(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 3, 0, 0)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("DELETE FROM user_work_state; INSERT INTO person(id,display_name) VALUES(1,'Example Voice'); INSERT INTO work_credit(work_id,person_id,role,source) VALUES(1,1,'voice_actor','test'),(2,1,'voice_actor','test')")
	exec("INSERT INTO user_work_state(user_id,work_id,listening_status,rating) VALUES(?,1,'relisten',4)", userID)
	scaleDrainCatalog(t, store)
	ctx := context.Background()
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-retained")
	if err != nil {
		t.Fatal(err)
	}
	original, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 2)
	if err != nil || original.Score != 45 {
		t.Fatalf("initial=%+v,%v", original, err)
	}
	exec("DELETE FROM work_credit WHERE work_id=2")
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := store.ProcessRecommendationCatalog(cancelled, 64); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled batch=%v", err)
	}
	var dirty int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_catalog_dirty WHERE work_id=2").Scan(&dirty); err != nil || dirty != 1 {
		t.Fatalf("cancelled change lost=%d,%v", dirty, err)
	}
	scaleDrainCatalog(t, store)
	fresh, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-fresh")
	if err != nil {
		t.Fatal(err)
	}
	current, err := store.RecommendationSnapshotBreakdown(ctx, fresh, 2)
	if err != nil || current.Score != 35 {
		t.Fatalf("published change=%+v,%v", current, err)
	}
	exec("INSERT INTO user_listening_session(user_id,session_id,work_id,listened_seconds) VALUES(?,'synthetic-listening',1,123)", userID)
	for range 4 {
		if err := store.CleanupRecommendations(ctx, 1); err != nil {
			t.Fatal(err)
		}
	}
	frozen, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 2)
	if err != nil || !reflect.DeepEqual(frozen, original) {
		t.Fatalf("active history reclaimed: %+v,%v", frozen, err)
	}
	exec("UPDATE recommendation_client_session SET created_at='2020-01-01 00:00:00' WHERE session_id='synthetic-retained'; UPDATE recommendation_generation SET created_at='2020-01-01 00:00:00' WHERE id=?", snapshot.GenerationID)
	for range 32 {
		if err := store.CleanupRecommendations(ctx, 1); err != nil {
			t.Fatal(err)
		}
	}
	var generations, history int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_generation WHERE id=?", snapshot.GenerationID).Scan(&generations); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_catalog_work WHERE valid_to IS NOT NULL").Scan(&history); err != nil {
		t.Fatal(err)
	}
	if generations != 0 || history != 0 {
		t.Fatalf("unreferenced generation/history remain=%d/%d", generations, history)
	}
	var listening float64
	if err := store.db.QueryRow("SELECT listened_seconds FROM user_listening_session WHERE session_id='synthetic-listening'").Scan(&listening); err != nil || listening != 123 {
		t.Fatalf("cleanup altered durable history=%v,%v", listening, err)
	}
}

func TestCatalogFailureDefersDurableWorkAndKeepsPublishedEpochUsable(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 2, 0, 0)
	ctx := context.Background()
	first, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-before-failure")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("INSERT INTO recommendation_name_dirty(kind,entity_id) VALUES('invalid-test-kind',1)"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ProcessRecommendationCatalog(ctx, 64); err == nil {
		t.Fatal("invalid queued input did not fail")
	}
	var retryCount int
	var deferred bool
	if err := store.db.QueryRow("SELECT retry_count,retry_after > unixepoch() FROM recommendation_name_dirty WHERE kind='invalid-test-kind'").Scan(&retryCount, &deferred); err != nil {
		t.Fatal(err)
	}
	if retryCount != 1 || !deferred {
		t.Fatalf("failure was not durably deferred: %d/%t", retryCount, deferred)
	}
	second, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-during-failure")
	if err != nil || second.CatalogEpoch != first.CatalogEpoch {
		t.Fatalf("failed build discarded published epoch: %+v,%v", second, err)
	}
	if _, err := store.db.Exec("DELETE FROM recommendation_name_dirty WHERE kind='invalid-test-kind'; INSERT INTO person(id,display_name) VALUES(1,'Example Repaired Voice')"); err != nil {
		t.Fatal(err)
	}
	scaleDrainCatalog(t, NewStore(store.db))
	recovered, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-after-recovery")
	if err != nil || recovered.CatalogEpoch <= first.CatalogEpoch {
		t.Fatalf("repair failed to publish: %+v,%v", recovered, err)
	}
}
