package library

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestEvictedRecommendationContextAuthenticatesOriginalGeneration(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 12, 0, 0)
	ctx := context.Background()
	options := ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 17, RecommendationSessionID: "example-context-recovery"}
	first, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !validRecommendationContextToken(snapshot, first.RecommendationContext) {
		t.Fatal("context lacks authenticated generation ownership")
	}
	if _, err := store.db.Exec(`UPDATE recommendation_query_context SET created_at='2020-01-01 00:00:00' WHERE id=?`, first.RecommendationContext); err != nil {
		t.Fatal(err)
	}
	for seed := int64(1); seed <= 9; seed++ {
		options.RandomSeed = seed
		if _, err := store.ListPage(ctx, options); err != nil {
			t.Fatal(err)
		}
	}
	var contexts, retained int
	if err := store.db.QueryRow(`SELECT COUNT(*),SUM(CASE WHEN id=? THEN 1 ELSE 0 END) FROM recommendation_query_context WHERE generation_id=?`, first.RecommendationContext, snapshot.GenerationID).Scan(&contexts, &retained); err != nil {
		t.Fatal(err)
	}
	if contexts != 8 || retained != 0 {
		t.Fatalf("cache contexts=%d original=%d", contexts, retained)
	}
	if _, err := store.db.Exec(`UPDATE user_work_state SET favorite=0,listening_status='none' WHERE user_id=? AND work_id=2`, userID); err != nil {
		t.Fatal(err)
	}
	restarted := NewStore(store.db)
	oldSnapshot, err := restarted.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.RecommendationContextBreakdown(ctx, userID, oldSnapshot, first.RecommendationContext, 2); !errors.Is(err, ErrRecommendationContextExpired) {
		t.Fatalf("verified evicted context=%v", err)
	}
	fallback, err := restarted.RecommendationSnapshotBreakdown(ctx, oldSnapshot, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, fallback) || fallback.Ordering != nil {
		t.Fatal("eviction recovery changed frozen affinity or invented ordering")
	}
	fresh, err := restarted.PrepareRecommendationSession(ctx, userID, "example-context-fresh-generation")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.GenerationID == snapshot.GenerationID {
		t.Fatal("fixture did not create changed generation")
	}
	if _, err := restarted.RecommendationContextBreakdown(ctx, userID, fresh, first.RecommendationContext, 2); !errors.Is(err, ErrInvalidRecommendationContext) {
		t.Fatalf("cross-generation deleted context=%v", err)
	}
	other := oldSnapshot
	other.UserID = userID + 1
	if _, err := restarted.RecommendationContextBreakdown(ctx, userID+1, other, first.RecommendationContext, 2); !errors.Is(err, ErrInvalidRecommendationContext) {
		t.Fatalf("cross-user deleted context=%v", err)
	}
	tampered := "0" + first.RecommendationContext[1:]
	if first.RecommendationContext[0] == '0' {
		tampered = "1" + first.RecommendationContext[1:]
	}
	if _, err := restarted.RecommendationContextBreakdown(ctx, userID, oldSnapshot, tampered, 2); !errors.Is(err, ErrInvalidRecommendationContext) {
		t.Fatalf("tampered context=%v", err)
	}
	raw, err := json.Marshal(oldSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), oldSnapshot.contextSigningKey) || strings.Contains(string(raw), "contextSigningKey") {
		t.Fatal("private context key escaped snapshot serialization")
	}
}

func TestContextKeyInstallationPreservesUnkeyedFrozenSessionAndLegacyContext(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 6, 0, 0)
	ctx := context.Background()
	options := ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 17, RecommendationSessionID: "example-unkeyed-generation"}
	page, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 2)
	if err != nil {
		t.Fatal(err)
	}
	profileBefore, err := store.loadFrozenRecommendationProfile(ctx, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	legacyHash := sha256.Sum256([]byte("synthetic-existing-unsigned-context"))
	legacyID := hex.EncodeToString(legacyHash[:])
	if _, err := store.db.Exec(`INSERT INTO recommendation_query_context(id,generation_id,seed,direction,candidate_count) SELECT ?,generation_id,seed,direction,candidate_count FROM recommendation_query_context WHERE id=?`, legacyID, page.RecommendationContext); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO recommendation_query_candidate(context_id,work_id,primary_code,rank,signals_json) SELECT ?,work_id,primary_code,rank,signals_json FROM recommendation_query_candidate WHERE context_id=?`, legacyID, page.RecommendationContext); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE recommendation_generation_profile SET profile_json=json_remove(profile_json,'$.contextSigningKey') WHERE generation_id=?`, snapshot.GenerationID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE user_work_state SET favorite=0,listening_status='none' WHERE user_id=? AND work_id=2`, userID); err != nil {
		t.Fatal(err)
	}
	restarted := NewStore(store.db)
	updated, err := restarted.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.GenerationID != snapshot.GenerationID || len(updated.contextSigningKey) != 64 {
		t.Fatal("key installation rebuilt or unbound frozen generation")
	}
	profileAfter, err := restarted.loadFrozenRecommendationProfile(ctx, updated)
	if err != nil {
		t.Fatal(err)
	}
	profileBefore.ContextSigningKey, profileAfter.ContextSigningKey = "", ""
	if !reflect.DeepEqual(profileBefore, profileAfter) {
		t.Fatal("key installation changed frozen evidence")
	}
	after, err := restarted.RecommendationSnapshotBreakdown(ctx, updated, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("key installation adopted current feedback")
	}
	legacy, err := restarted.RecommendationContextBreakdown(ctx, userID, updated, legacyID, 2)
	if err != nil {
		t.Fatal(err)
	}
	if legacy.Score != before.Score || legacy.Ordering == nil {
		t.Fatal("existing legacy context lost owned cached ordering")
	}
	if _, err := store.db.Exec(`DELETE FROM recommendation_query_context WHERE id=?`, legacyID); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.RecommendationContextBreakdown(ctx, userID, updated, legacyID, 2); !errors.Is(err, ErrInvalidRecommendationContext) {
		t.Fatalf("unverifiable deleted legacy context=%v", err)
	}
}
