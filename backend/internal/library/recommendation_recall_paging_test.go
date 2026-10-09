package library

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// The reference enumerates members solely to verify the public ordering
// contract. Production obtains the same result from bounded lane windows.
func referenceRecommendationOrder(t testing.TB, store *Store, snapshot RecommendationSessionSnapshot, options ListOptions, contextID string) []int64 {
	t.Helper()
	membership := recommendationMembershipFor(snapshot, options)
	rows, err := store.db.QueryContext(context.Background(), `SELECT work.id,work.recommendation_explore_key, `+membership.exact+`, `+membership.lane+membership.from+` WHERE `+membership.where, membership.projectionArgs()...)
	if err != nil {
		t.Fatal(err)
	}
	type member struct {
		id, key    int64
		exact      int
		lane       string
		rank       int
		position   int64
		suppressed bool
	}
	members := []member{}
	for rows.Next() {
		var item member
		if err := rows.Scan(&item.id, &item.key, &item.exact, &item.lane); err != nil {
			t.Fatal(err)
		}
		members = append(members, item)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	prefix, _, err := store.loadRecommendationPrefix(context.Background(), contextID, snapshot.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	ranks := map[int64]int{}
	for _, work := range prefix {
		ranks[work.id] = work.rank
	}
	_, direction, pivot := recommendationRingSegment(options, 0)
	segment := func(key int64) int {
		if direction == "DESC" {
			if key > pivot {
				return 1
			}
		} else if key < pivot {
			return 1
		}
		return 0
	}
	sort.Slice(members, func(i, j int) bool {
		a, b := members[i], members[j]
		if a.exact != b.exact {
			return a.exact > b.exact
		}
		if a.lane != b.lane {
			return a.lane < b.lane
		}
		ra, rb := ranks[a.id], ranks[b.id]
		if (ra > 0) != (rb > 0) {
			return ra > 0
		}
		if ra > 0 {
			return ra < rb
		}
		if segment(a.key) != segment(b.key) {
			return segment(a.key) < segment(b.key)
		}
		if a.key != b.key {
			if direction == "DESC" {
				return a.key > b.key
			}
			return a.key < b.key
		}
		if direction == "DESC" {
			return a.id > b.id
		}
		return a.id < b.id
	})
	cycle, slots := recommendationSlotOffsets(snapshot.Config)
	laneRanks := map[string]int{}
	for index := range members {
		item := &members[index]
		key := fmt.Sprintf("%d:%s", item.exact, item.lane)
		laneRanks[key]++
		item.rank = laneRanks[key]
		item.position = recommendationRankPosition(cycle, slots[item.lane], item.rank)
		item.suppressed = len(slots[item.lane]) == 0
	}
	sort.Slice(members, func(i, j int) bool {
		a, b := members[i], members[j]
		if a.exact != b.exact {
			return a.exact > b.exact
		}
		if a.suppressed != b.suppressed {
			return !a.suppressed
		}
		if a.position != b.position {
			return a.position < b.position
		}
		return a.id < b.id
	})
	ids := make([]int64, len(members))
	for index, item := range members {
		ids[index] = item.id
	}
	return ids
}

func TestRecommendationPagingCoversPrefixAndTailWithStableLanes(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 720, 0, 0)
	ctx := context.Background()
	for _, direction := range []string{"asc", "desc"} {
		for _, query := range []string{"", `"Example Work 1"`, "tag:absent-synthetic-tag"} {
			for _, seed := range []int64{43, 811} {
				options := ListOptions{UserID: userID, Page: 1, PageSize: 31, Sort: "recommend", Direction: direction, RandomSeed: seed, Query: query, RecommendationSessionID: "example-paging"}
				first, err := store.ListPage(ctx, options)
				if err != nil {
					t.Fatal(err)
				}
				snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
				if err != nil {
					t.Fatal(err)
				}
				want := referenceRecommendationOrder(t, store, snapshot, options, first.RecommendationContext)
				if first.Total != len(want) {
					t.Fatalf("total=%d matching=%d", first.Total, len(want))
				}
				for _, size := range []int{17, 100} {
					options.PageSize = size
					got := []int64{}
					for pageNo := 1; pageNo <= (len(want)+size-1)/size+1; pageNo++ {
						options.Page = pageNo
						page, err := store.ListPage(ctx, options)
						if err != nil {
							t.Fatal(err)
						}
						if page.Total != len(want) || page.RecommendationContext != first.RecommendationContext {
							t.Fatal("page changed total or ordering context")
						}
						for _, work := range page.Works {
							got = append(got, work.ID)
						}
					}
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("direction=%s query=%q seed=%d pageSize=%d lost, repeated or reordered members: got %d want %d", direction, query, seed, size, len(got), len(want))
					}
				}
			}
		}
	}
}

func TestRecommendationPagingMultipleZeroSlotLanesAndDeepPage(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 620, 0, 0)
	ctx := context.Background()
	config := DefaultRecommendationConfig()
	config.WantSlots, config.ListeningSlots, config.FinishedSlots, config.RelistenSlots, config.ShelvedSlots = 0, 0, 0, 0, 0
	rawConfig, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `INSERT INTO user_preference(user_id,recommendation_config) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET recommendation_config=excluded.recommendation_config`, userID, string(rawConfig)); err != nil {
		t.Fatal(err)
	}
	options := ListOptions{UserID: userID, Page: 23, PageSize: 23, Sort: "recommend", Direction: "desc", RandomSeed: 37, RecommendationSessionID: "example-suppressed"}
	page, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	want := referenceRecommendationOrder(t, store, snapshot, options, page.RecommendationContext)
	for _, pageNo := range []int{1, 5, 6, 23, 24, 27, 28} {
		options.Page = pageNo
		page, err := store.ListPage(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		got := []int64{}
		for _, work := range page.Works {
			got = append(got, work.ID)
		}
		start := min((pageNo-1)*options.PageSize, len(want))
		end := min(start+options.PageSize, len(want))
		if !reflect.DeepEqual(got, want[start:end]) {
			t.Fatalf("zero-slot page %d got %v want %v", pageNo, got, want[start:end])
		}
	}
}

func TestRecommendationRecallBudgetsContextsAndPageOnlyBadges(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 2500, 0, 0)
	ctx := context.Background()
	var tagID int64
	result, err := store.db.Exec(`INSERT INTO tag(namespace,normalized_name,display_name) VALUES ('metadata','example-popular-tag','Example Popular Tag')`)
	if err != nil {
		t.Fatal(err)
	}
	tagID, err = result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO work_tag(work_id,tag_id) SELECT id,? FROM work`, tagID); err != nil {
		t.Fatal(err)
	}
	publishRecommendationCatalog(t, store)
	options := ListOptions{UserID: userID, Page: 1, PageSize: 100, Sort: "recommend", Direction: "desc", RandomSeed: 1, RecommendationSessionID: "example-budget"}
	page, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2500 {
		t.Fatalf("total=%d must include noncandidates", page.Total)
	}
	var scored, prefix int
	if err := store.db.QueryRow(`SELECT candidate_count,(SELECT COUNT(*) FROM recommendation_query_candidate WHERE context_id=?) FROM recommendation_query_context WHERE id=?`, page.RecommendationContext, page.RecommendationContext).Scan(&scored, &prefix); err != nil {
		t.Fatal(err)
	}
	if scored > 2000 || prefix > 500 || prefix == 0 {
		t.Fatalf("scored=%d prefix=%d", scored, prefix)
	}
	var snapshotRows int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM recommendation_snapshot`).Scan(&snapshotRows); err != nil {
		t.Fatal(err)
	}
	if snapshotRows != 0 {
		t.Fatalf("full-library score cache rows=%d", snapshotRows)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	var outside int64
	if err := store.db.QueryRow(`SELECT work.id FROM work WHERE NOT EXISTS(SELECT 1 FROM recommendation_query_candidate WHERE context_id=? AND work_id=work.id) ORDER BY work.id LIMIT 1`, page.RecommendationContext).Scan(&outside); err != nil {
		t.Fatal(err)
	}
	breakdown, err := store.RecommendationContextBreakdown(ctx, userID, snapshot, page.RecommendationContext, outside)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Score <= snapshot.Config.AffinityBase || breakdown.Ordering != nil || breakdown.Signals.DiversityPenalty != 0 {
		t.Fatalf("outside candidate lost true affinity or invented rank: %#v", breakdown)
	}
	options.Sort = "code"
	options.IncludeRecommendation = true
	options.Page = 7
	scoredBefore := store.RecommendationDiagnostics()["scored_works"]
	ordinary, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(ordinary.Works) != 100 || ordinary.RecommendationContext != "" || ordinary.RecommendationUnavailable {
		t.Fatal("ordinary badge page created a context or lost cards")
	}
	if scored := store.RecommendationDiagnostics()["scored_works"] - scoredBefore; scored != 100 {
		t.Fatalf("ordinary badge scoring escaped page: %d", scored)
	}
	var contexts int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM recommendation_query_context`).Scan(&contexts); err != nil {
		t.Fatal(err)
	}
	if contexts != 1 {
		t.Fatalf("ordinary badge read recalled contexts=%d", contexts)
	}
	options.Sort = "recommend"
	for seed := int64(2); seed <= 11; seed++ {
		options.RandomSeed = seed
		if _, err := store.ListPage(ctx, options); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM recommendation_query_context WHERE generation_id=?`, snapshot.GenerationID).Scan(&contexts); err != nil {
		t.Fatal(err)
	}
	if contexts != 8 {
		t.Fatalf("generation contexts=%d", contexts)
	}
	result, err = store.db.Exec(`INSERT INTO user_account(username,display_name,role) VALUES('synthetic-cold-user','Example Cold User','user')`)
	if err != nil {
		t.Fatal(err)
	}
	coldUser, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	options.UserID = coldUser
	options.Page = 1
	options.Query = testfixture.HighCardinalityWorkCodeAt(0)
	options.Scope = "local"
	options.RecommendationSessionID = "example-narrow"
	narrow, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if narrow.Total != 1 || len(narrow.Works) != 1 || narrow.Works[0].ID != 1 {
		t.Fatal("cold narrow filter lost its matching work")
	}
	if err := store.db.QueryRow(`SELECT candidate_count FROM recommendation_query_context WHERE id=?`, narrow.RecommendationContext).Scan(&scored); err != nil {
		t.Fatal(err)
	}
	if scored != 1 {
		t.Fatalf("narrow cold filter did not recall exactly its member: %d", scored)
	}
	var generationsBefore, generationsAfter int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM recommendation_generation`).Scan(&generationsBefore); err != nil {
		t.Fatal(err)
	}
	options.UserID = 0
	options.Query = ""
	options.Scope = "all"
	options.Page = 20
	options.PageSize = 24
	options.RecommendationSessionID = ""
	anon, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM recommendation_generation`).Scan(&generationsAfter); err != nil {
		t.Fatal(err)
	}
	if anon.Total != 2500 || len(anon.Works) != 24 || anon.RecommendationContext != "" || generationsAfter != generationsBefore {
		t.Fatal("anonymous recommendation entered personal preparation")
	}
	for _, work := range anon.Works {
		if work.RecommendScore != DefaultRecommendationConfig().AffinityBase {
			t.Fatal("anonymous work received personal affinity")
		}
	}
}

func TestRecommendationContextDeterministicConcurrentAndOwnership(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 120, 0, 0)
	ctx := context.Background()
	options := ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 123, Query: `"Example Work 1"`, RecommendationSessionID: "example-concurrent"}
	var wait sync.WaitGroup
	results := make(chan RawPage, 6)
	errors := make(chan error, 6)
	for range 6 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			page, err := store.ListPage(ctx, options)
			if err != nil {
				errors <- err
				return
			}
			results <- page
		}()
	}
	wait.Wait()
	close(results)
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	var first RawPage
	for page := range results {
		if first.RecommendationContext == "" {
			first = page
		} else if !reflect.DeepEqual(first, page) {
			t.Fatal("concurrent requests created different candidate order")
		}
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	opts := options
	opts.Page = 3
	opts.PageSize = 100
	opts.Query = `"example work 1"`
	opts.Direction = "DESC"
	if recommendationContextID(snapshot, options) != recommendationContextID(snapshot, opts) {
		t.Fatal("presentation inputs changed context")
	}
	if _, err := store.RecommendationContextBreakdown(ctx, userID+1, snapshot, first.RecommendationContext, first.Works[0].ID); err == nil {
		t.Fatal("another account read context")
	}
	if _, err := store.db.Exec(`DELETE FROM recommendation_query_context WHERE id=?`, first.RecommendationContext); err != nil {
		t.Fatal(err)
	}
	restarted := NewStore(store.db)
	rebuilt, err := restarted.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, rebuilt) {
		t.Fatal("eviction and restart changed same-input recommendation order")
	}
}

func TestRecommendationTailCheckpointHandlesCountPreservingMembershipChange(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 900, 0, 0)
	ctx := context.Background()
	options := ListOptions{UserID: userID, Page: 28, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 42, RecommendationSessionID: "example-membership"}
	first, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	var checkpointID int64
	if err := store.db.QueryRow(`SELECT work_id FROM recommendation_query_checkpoint WHERE context_id=? ORDER BY tail_rank DESC LIMIT 1`, first.RecommendationContext).Scan(&checkpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM work WHERE id=?`, checkpointID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO work(primary_code,title,created_at) VALUES (?,'Example Work','2026-01-01 00:00:00')`, testfixture.HighCardinalityWorkCodeAt(901)); err != nil {
		t.Fatal(err)
	}
	options.Page = 29
	page, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	want := referenceRecommendationOrder(t, store, snapshot, options, page.RecommendationContext)
	got := []int64{}
	for _, work := range page.Works {
		got = append(got, work.ID)
	}
	start := (options.Page - 1) * options.PageSize
	if page.Total != 900 || !reflect.DeepEqual(got, want[start:min(start+options.PageSize, len(want))]) {
		t.Fatal("stale checkpoint repeated or skipped tail members")
	}
}

func TestFrozenRecommendationDoesNotTransferDeletedWorkIdentityToReusedID(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 3, 0, 0)
	ctx := context.Background()
	if _, err := store.db.Exec(`INSERT INTO person(id,display_name) VALUES(1,'Example Voice'); INSERT INTO work_credit(work_id,person_id,role,source) VALUES(2,1,'voice_actor','test'),(3,1,'voice_actor','test'); UPDATE user_work_state SET favorite=1 WHERE work_id=3`); err != nil {
		t.Fatal(err)
	}
	publishRecommendationCatalog(t, store)
	options := ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 43, RecommendationSessionID: "example-reused-id"}
	first, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM work WHERE id=3`); err != nil {
		t.Fatal(err)
	}
	result, err := store.db.Exec(`INSERT INTO work(primary_code,title) VALUES(?,'Example Replacement Work')`, testfixture.WorkCode(testfixture.PrefixRJ, 99))
	if err != nil {
		t.Fatal(err)
	}
	reused, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if reused != 3 {
		t.Fatalf("fixture does not exercise row ID reuse: %d", reused)
	}
	breakdown, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, reused)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Score != snapshot.Config.AffinityBase || breakdown.Signals.Favorite || breakdown.Signals.ListeningStatus != "none" {
		t.Fatalf("deleted identity contaminated replacement work: %+v", breakdown)
	}
	page, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || len(page.Works) != 3 {
		t.Fatal("replacement disappeared from full tail")
	}
	for _, work := range page.Works {
		if work.ID == reused && work.RecommendScore != snapshot.Config.AffinityBase {
			t.Fatal("cached prefix transferred the deleted work score")
		}
	}
	contextBreakdown, err := store.RecommendationContextBreakdown(ctx, userID, snapshot, first.RecommendationContext, reused)
	if err != nil {
		t.Fatal(err)
	}
	if contextBreakdown.Score != snapshot.Config.AffinityBase || contextBreakdown.Ordering != nil {
		t.Fatal("deleted work context ordering transferred to replacement")
	}
}

func TestRecommendationNewcomerOutsideEpochHasNeutralLaneAndLiveCardState(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 2, 0, 0)
	ctx := context.Background()
	result, err := store.db.Exec(`INSERT INTO work(primary_code,title) VALUES(?,'Example New Work')`, testfixture.WorkCode(testfixture.PrefixRJ, 2))
	if err != nil {
		t.Fatal(err)
	}
	newID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO user_work_state(user_id,work_id,listening_status,favorite) VALUES(?,?,'listening',1)`, userID, newID); err != nil {
		t.Fatal(err)
	}
	options := ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 43, RecommendationSessionID: "example-neutral-newcomer"}
	page, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	breakdown, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, newID)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Score != snapshot.Config.AffinityBase || breakdown.Signals.ListeningStatus != "none" || breakdown.Signals.Favorite {
		t.Fatal("newcomer did not retain neutral bound-epoch scoring")
	}
	membership := recommendationMembershipFor(snapshot, options)
	var lane string
	if err := store.db.QueryRowContext(ctx, `SELECT `+membership.lane+membership.from+` WHERE work.id=?`, append(membership.fromArgs, newID)...).Scan(&lane); err != nil {
		t.Fatal(err)
	}
	if lane != "none" {
		t.Fatalf("neutral newcomer was sorted in frozen %q lane", lane)
	}
	if page.Total != 3 {
		t.Fatal("neutral newcomer disappeared")
	}
	for _, work := range page.Works {
		if work.ID == newID && (!work.Favorite || work.ListeningStatus != "listening" || work.RecommendScore != snapshot.Config.AffinityBase) {
			t.Fatal("newcomer card lost live personal state")
		}
	}
	contextBreakdown, err := store.RecommendationContextBreakdown(ctx, userID, snapshot, page.RecommendationContext, newID)
	if err != nil {
		t.Fatal(err)
	}
	if contextBreakdown.Score != snapshot.Config.AffinityBase || contextBreakdown.Signals.ListeningStatus != "none" {
		t.Fatal("context newcomer lane contradicted pure scoring")
	}
}

func TestRecommendationContextWithNoSurvivingPrefixRemainsEmptyCacheHit(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 1, 0, 0)
	ctx := context.Background()
	options := ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 43, RecommendationSessionID: "example-empty-prefix"}
	first, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM work WHERE id=1; INSERT INTO work(id,primary_code,title) VALUES(1,'RJ00000099','Example Replacement Work')`); err != nil {
		t.Fatal(err)
	}
	prefix, exists, err := store.loadRecommendationPrefix(ctx, first.RecommendationContext, snapshot.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	if !exists || len(prefix) != 0 {
		t.Fatal("empty surviving prefix was treated as missing context")
	}
	page, err := store.ListPage(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Works) != 1 || page.RecommendationContext != first.RecommendationContext {
		t.Fatal("empty prefix lost its complete exploration tail")
	}
	var cachedCode string
	if err := store.db.QueryRow(`SELECT primary_code FROM recommendation_query_candidate WHERE context_id=?`, first.RecommendationContext).Scan(&cachedCode); err != nil {
		t.Fatal(err)
	}
	if cachedCode != testfixture.WorkCode(testfixture.PrefixRJ, 0) {
		t.Fatal("membership change silently rebuilt a still-existing context")
	}
}

func TestAnonymousRecommendationSeedsRotateTheCompleteExplorationRing(t *testing.T) {
	store, _ := seedPaginationLibrary(t, 12, 0, 0)
	ctx := context.Background()
	orders := map[int64][]int64{}
	for _, seed := range []int64{17, 41} {
		options := ListOptions{Page: 1, PageSize: 100, Sort: "recommend", Direction: "desc", RandomSeed: seed}
		page, err := store.ListPage(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		for _, work := range page.Works {
			orders[seed] = append(orders[seed], work.ID)
		}
		if page.Total != 12 || len(page.Works) != 12 || page.RecommendationContext != "" {
			t.Fatal("anonymous exploration lost members or created a personal context")
		}
		again, err := NewStore(store.db).ListPage(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(page, again) {
			t.Fatal("anonymous seed order changed on restart")
		}
	}
	if reflect.DeepEqual(orders[17], orders[41]) {
		t.Fatal("different ordinary seeds did not rotate exploration")
	}
}
