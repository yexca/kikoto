package library

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestFrozenAffinityMatchesV5SignalsAndComponents(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 9, 0, 0)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("DELETE FROM user_work_state")
	exec("INSERT INTO tag(id,namespace,normalized_name,display_name) VALUES (1,'metadata','example-common','Example Common'),(2,'metadata','example-positive','Example Positive'),(3,'metadata','example-negative','Example Negative'),(4,'manual','example-manual','Example Manual')")
	exec("INSERT INTO person(id,display_name) VALUES (1,'Example Voice'),(2,'Example Negative Voice')")
	exec("INSERT INTO party(id,display_name) VALUES (1,'Example Circle'),(2,'Example Negative Circle')")
	exec("INSERT INTO work_tag(work_id,tag_id,source) SELECT id,1,'test' FROM work")
	for _, id := range []int{1, 2, 3, 5} {
		exec("INSERT INTO work_tag(work_id,tag_id,source) VALUES (?,2,'test'),(?,2,'example-other-source'),(?,4,'test')", id, id, id)
		exec("INSERT INTO work_credit(work_id,person_id,role,source) VALUES (?,1,'voice_actor','test')", id)
		exec("INSERT INTO work_party(work_id,party_id,role,source) VALUES (?,1,'circle','test')", id)
	}
	for _, id := range []int{3, 4, 6} {
		exec("INSERT INTO work_tag(work_id,tag_id,source) VALUES (?,3,'test')", id)
		exec("INSERT INTO work_credit(work_id,person_id,role,source) VALUES (?,2,'voice_actor','test')", id)
		exec("INSERT INTO work_party(work_id,party_id,role,source) VALUES (?,2,'circle','test')", id)
	}
	exec("INSERT INTO user_work_state(user_id,work_id,listening_status,favorite) VALUES (?,1,'relisten',0),(?,2,'paused',1),(?,3,'paused',0),(?,4,'paused',0),(?,7,'listening',0)", userID, userID, userID, userID, userID)
	scaleDrainCatalog(t, store)
	ctx := context.Background()
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, "synthetic-v5-equivalence")
	if err != nil {
		t.Fatal(err)
	}
	configs := []RecommendationConfig{DefaultRecommendationConfig(), DefaultRecommendationConfig()}
	configs[1].NegativeMinEvidence = 1
	configs[1].TagWeight = 7
	configs[1].VoiceCap = 9
	configs[1].NegativeTotalCap = 6
	for _, config := range configs {
		snapshot.Config = config
		for id := int64(1); id <= 9; id++ {
			legacy, err := store.legacyRecommendationBreakdownWithConfig(ctx, userID, id, config)
			if err != nil {
				t.Fatal(err)
			}
			frozen, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, id)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(legacy, frozen) {
				t.Fatalf("work %d affinity differs: legacy=%+v frozen=%+v", id, legacy, frozen)
			}
		}
	}
	var scores, states int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_snapshot WHERE generation_id=?", snapshot.GenerationID).Scan(&scores); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_generation_state WHERE generation_id=?", snapshot.GenerationID).Scan(&states); err != nil {
		t.Fatal(err)
	}
	if scores != 0 || states != 5 {
		t.Fatalf("generation dense scores/sparse state=%d/%d", scores, states)
	}
}

func TestCatalogBackfillPublishesAtomicallyAndSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "catalog.db")
	db, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db, "../../migrations"); err != nil {
		t.Fatal(err)
	}
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
	exec("INSERT INTO user_work_state(user_id,work_id,listening_status) VALUES(?,1,'relisten')", userID)
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
