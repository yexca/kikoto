package library

import (
	"context"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// seedForYouLibrary is a twelve-work local library: work 1 is a five-star
// finished work of a circle the account likes, work 2 is being listened to,
// and work 3 was left half-finished two months ago. Work 13 has no files.
func seedForYouLibrary(t *testing.T) (*Store, int64, time.Time) {
	t.Helper()
	store, userID := seedPaginationLibrary(t, 12, 1, 0)
	now := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	played := func(days int) string { return now.AddDate(0, 0, -days).Format(time.RFC3339) }
	exec("DELETE FROM user_work_state")
	exec("INSERT INTO party (id, display_name) VALUES (1, 'Example Circle'), (2, 'Example Other Circle')")
	exec("INSERT INTO tag (id, namespace, normalized_name, display_name) VALUES (1, 'metadata', 'example-familiar', 'Example Familiar'), (2, 'metadata', 'example-rare', 'Example Rare')")
	for id := 1; id <= 12; id++ {
		circle := 1
		if id > 4 {
			circle = 2
		}
		exec("INSERT INTO work_party (work_id, party_id, role) VALUES (?, ?, 'circle')", id, circle)
		tag := 1
		if id > 8 {
			tag = 2
		}
		exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'test')", id, tag)
	}
	exec("INSERT INTO work (primary_code, title) VALUES (?, 'Example Remote Work')", testfixture.WorkCode(testfixture.PrefixRJ, 50))
	exec("INSERT INTO work_party (work_id, party_id, role) VALUES (13, 1, 'circle')")
	exec("INSERT INTO user_work_state (user_id, work_id, listening_status, rating) VALUES (?, 1, 'finished', 5), (?, 2, 'listening', NULL)", userID, userID)
	cursor := func(workID int, completed bool, days int) {
		exec(`INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, position_seconds, duration_seconds, completed, last_played_at)
			SELECT ?, ?, id, 60, 600, ?, ? FROM media_item WHERE work_id = ?`, userID, workID, completed, played(days), workID)
	}
	cursor(1, true, 120)
	cursor(2, false, 2)
	cursor(3, false, 60)
	exec("INSERT INTO user_listening_day (user_id, work_id, day, listened_seconds, listen_count) VALUES (?, 1, '2026-06-01', 3600, 1), (?, 1, '2026-06-20', 3600, 1)", userID, userID)
	scaleDrainCatalog(t, store)
	return store, userID, now
}

func forYouColumnIDs(draw ForYouDraw, column ForYouColumn) map[int64]ForYouPick {
	result := map[int64]ForYouPick{}
	for _, item := range draw.Columns {
		if item.Column == column {
			for _, pick := range item.Picks {
				result[pick.WorkID] = pick
			}
		}
	}
	return result
}

func TestForYouDrawsLocalWorksIntoOneColumnEach(t *testing.T) {
	store, userID, now := seedForYouLibrary(t)
	ctx := context.Background()
	for seed := int64(1); seed <= 5; seed++ {
		draw, err := store.DrawForYou(ctx, ForYouRequest{UserID: userID, Temperature: ForYouBalanced, Seed: seed, Now: now})
		if err != nil {
			t.Fatal(err)
		}
		seen := map[int64]ForYouColumn{}
		for _, column := range draw.Columns {
			for _, pick := range column.Picks {
				if previous, ok := seen[pick.WorkID]; ok {
					t.Fatalf("seed %d: work %d is in %s and %s", seed, pick.WorkID, previous, column.Column)
				}
				seen[pick.WorkID] = column.Column
				if pick.WorkID > 12 {
					t.Fatalf("seed %d: drew work %d without files", seed, pick.WorkID)
				}
			}
		}
		if _, ok := seen[2]; ok {
			t.Fatalf("seed %d: drew the work being listened to", seed)
		}
		// Unheard works sharing the liked circle are what Maybe like is for.
		if pick, ok := forYouColumnIDs(draw, ForYouMaybeLike)[4]; !ok || pick.Reason.Kind != "liked_circle" || pick.Reason.Name != "Example Circle" {
			t.Fatalf("seed %d: maybe like = %+v", seed, forYouColumnIDs(draw, ForYouMaybeLike))
		}
		if pick, ok := forYouColumnIDs(draw, ForYouListenAgain)[1]; !ok || pick.Reason.Kind != "since_played" || pick.Reason.Days != 120 || pick.Reason.Rating != 5 {
			t.Fatalf("seed %d: listen again = %+v", seed, forYouColumnIDs(draw, ForYouListenAgain))
		}
	}
	var impressions, libraryEvents int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_event WHERE surface = 'for_you' AND event_type = 'impression'").Scan(&impressions); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow("SELECT COUNT(*) FROM recommendation_event WHERE surface = 'library'").Scan(&libraryEvents); err != nil {
		t.Fatal(err)
	}
	if impressions == 0 || libraryEvents != 0 {
		t.Fatalf("impressions = %d, library events = %d", impressions, libraryEvents)
	}
}

func TestForYouTemperatureWidensListenAgain(t *testing.T) {
	store, userID, now := seedForYouLibrary(t)
	ctx := context.Background()
	draw := func(temperature ForYouTemperature) map[int64]ForYouPick {
		t.Helper()
		result, err := store.DrawForYou(ctx, ForYouRequest{UserID: userID, Temperature: temperature, Columns: []ForYouColumn{ForYouListenAgain}, Seed: 7, Now: now})
		if err != nil {
			t.Fatal(err)
		}
		return forYouColumnIDs(result, ForYouListenAgain)
	}
	if safe := draw(ForYouSafe); len(safe) != 1 || safe[1].WorkID != 1 {
		t.Fatalf("safe listen again = %+v", safe)
	}
	adventurous := draw(ForYouAdventurous)
	if pick, ok := adventurous[3]; !ok || pick.Reason.Kind != "unfinished" || pick.Reason.Days != 60 {
		t.Fatalf("adventurous listen again = %+v", adventurous)
	}
}

func TestForYouColdStartRanksByPopularity(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 6, 0, 0)
	if _, err := store.db.Exec("DELETE FROM user_work_state"); err != nil {
		t.Fatal(err)
	}
	draw, err := store.DrawForYou(context.Background(), ForYouRequest{UserID: userID, Temperature: ForYouSafe, Seed: 3})
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range draw.Columns {
		if !column.ColdStart {
			t.Fatalf("column %s is not a cold start", column.Column)
		}
		if column.Column == ForYouListenAgain && len(column.Picks) != 0 {
			t.Fatalf("listen again without history = %+v", column.Picks)
		}
		if column.Column == ForYouMaybeLike {
			for _, pick := range column.Picks {
				if pick.Reason.Kind != "popular" && pick.Reason.Kind != "unexplored" {
					t.Fatalf("cold maybe like reason = %+v", pick.Reason)
				}
			}
		}
	}
}

func TestForYouTryNewSkipsDislikedSimilarity(t *testing.T) {
	config := DefaultRecommendationConfig()
	disliked := recommendationFeature{Kind: "circle", ID: 1}
	unknown := recommendationFeature{Kind: "circle", ID: 2}
	profile := emptyRecommendationProfile()
	profile.Entities[disliked.key()] = recommendationProfileEntity{Negative: 125, Disliked: 1, Specificity: 1}
	settings := ForYouAdventurous.settings()
	similar := &forYouCandidate{WorkID: 1, State: recommendationFrozenState{ListeningStatus: "none"}, Features: []recommendationFeature{disliked}}
	if _, ok := forYouTryNew(similar, profile, config, map[string]int{}, settings); ok {
		t.Fatal("try new offered a work like a disliked one")
	}
	fresh := &forYouCandidate{WorkID: 2, State: recommendationFrozenState{ListeningStatus: "none"}, Features: []recommendationFeature{unknown}}
	scored, ok := forYouTryNew(fresh, profile, config, map[string]int{}, settings)
	if !ok || scored.reason.Kind != "new_circle" || scored.score != 100 {
		t.Fatalf("try new = %+v, %v", scored, ok)
	}
	// Safe aims at works near the listened profile, not the most novel ones.
	familiar := map[string]int{unknown.key(): 1}
	safe, _ := forYouTryNew(fresh, profile, config, familiar, ForYouSafe.settings())
	adventurous, _ := forYouTryNew(fresh, profile, config, familiar, settings)
	if safe.score <= adventurous.score {
		t.Fatalf("half-familiar work: safe = %v, adventurous = %v", safe.score, adventurous.score)
	}
}

func TestForYouRotationLowersUnopenedWorks(t *testing.T) {
	pool := []forYouScored{}
	for id := int64(1); id <= 30; id++ {
		pool = append(pool, forYouScored{candidate: &forYouCandidate{WorkID: id}, score: 60})
	}
	pool[0].score, pool[0].candidate.Unopened = 90, 3
	order := forYouSample(pool, ForYouSafe.settings(), rand.New(rand.NewPCG(1, 2)))
	if len(order) != 2*ForYouDrawSize || order[0].candidate.WorkID == 1 {
		t.Fatalf("rotated work still leads: %d candidates, first %d", len(order), order[0].candidate.WorkID)
	}
}

func TestForYouAssembleGivesSharedWorkToItsStrongerColumn(t *testing.T) {
	shared := &forYouCandidate{WorkID: 1}
	maybe := []forYouScored{{candidate: shared, score: 10}}
	tryNew := []forYouScored{{candidate: shared, score: 90}}
	for id := int64(2); id <= 4; id++ {
		maybe = append(maybe, forYouScored{candidate: &forYouCandidate{WorkID: id}, score: 50})
		tryNew = append(tryNew, forYouScored{candidate: &forYouCandidate{WorkID: id + 10}, score: 50})
	}
	drawn := forYouAssemble(map[ForYouColumn][]forYouScored{ForYouMaybeLike: maybe, ForYouTryNew: tryNew},
		[]ForYouColumn{ForYouMaybeLike, ForYouTryNew}, map[int64]bool{}, ForYouBalanced.settings(), rand.New(rand.NewPCG(3, 4)))
	contains := func(items []forYouScored, id int64) bool {
		for _, item := range items {
			if item.candidate.WorkID == id {
				return true
			}
		}
		return false
	}
	if contains(drawn[ForYouMaybeLike], 1) || !contains(drawn[ForYouTryNew], 1) || len(drawn[ForYouMaybeLike]) != 3 {
		t.Fatalf("maybe like = %d works, try new holds shared = %v", len(drawn[ForYouMaybeLike]), contains(drawn[ForYouTryNew], 1))
	}
}
