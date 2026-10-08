package library

import (
	"context"
	"fmt"
	"math"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRecommendationRepeatedEvidenceAndCommonTags(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 8, 0, 0)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("DELETE FROM user_work_state")
	exec("INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')")
	exec("INSERT INTO tag (id, namespace, normalized_name, display_name) VALUES (1, 'metadata', 'example-common', 'Example Common'), (2, 'metadata', 'example-rare', 'Example Rare')")
	for id := 1; id <= 8; id++ {
		exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, 1, 'test')", id)
		if id <= 6 {
			exec("INSERT INTO work_credit (work_id, person_id, role, source) VALUES (?, 1, 'voice_actor', 'test')", id)
		}
	}
	for _, id := range []int{1, 6} {
		exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, 2, 'test')", id)
	}
	exec("INSERT INTO user_work_state (user_id, work_id, listening_status) VALUES (?, 1, 'relisten')", userID)
	ctx := context.Background()
	first, err := store.RecommendationBreakdown(ctx, userID, 6)
	if err != nil {
		t.Fatal(err)
	}
	self, err := store.RecommendationBreakdown(ctx, userID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if self.Signals.PositiveVoiceMatches != 0 || first.Components[2].Contribution != 10 {
		t.Fatalf("self=%+v candidate=%+v", self.Signals, first.Components)
	}
	for id := 2; id <= 5; id++ {
		exec("INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (?, ?, 'relisten', 1)", userID, id)
	}
	strong, err := store.RecommendationBreakdown(ctx, userID, 6)
	if err != nil {
		t.Fatal(err)
	}
	if strong.Signals.PositiveVoiceMatches != 1 || strong.Components[2].Contribution != 20 {
		t.Fatalf("repeated evidence=%+v", strong)
	}
	candidates := []RecommendationCandidate{
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 90), Tags: []string{"Example Common"}},
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 91), Tags: []string{"Example Rare"}},
	}
	// Compare specificity with the same one-work support, independently of frequency.
	exec("DELETE FROM user_work_state WHERE work_id <> 1")
	scores, err := store.ScoreRecommendationCandidates(ctx, userID, "specificity", candidates)
	if err != nil {
		t.Fatal(err)
	}
	if scores[0].Score >= scores[1].Score {
		t.Fatalf("common score=%d rare=%d", scores[0].Score, scores[1].Score)
	}
}

func TestRemoteRecommendationAliasesDeduplicateAndFreeze(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 2, 0, 0)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("DELETE FROM user_work_state")
	exec("INSERT INTO person (id, display_name) VALUES (1, 'Example Voice'), (2, 'Example Other Voice')")
	exec("INSERT INTO person_alias (person_id, alias) VALUES (1, 'Example Alias'), (1, 'Example Ambiguous'), (2, 'Example Ambiguous')")
	exec("INSERT INTO tag (id, namespace, normalized_name, display_name) VALUES (10, 'metadata', 'example-tag', 'Example Tag')")
	exec("INSERT INTO metadata_tag (tag_id) VALUES (10)")
	exec("INSERT INTO metadata_tag_name (tag_id, language, name) VALUES (10, 'zh-cn', 'Example Localized Tag')")
	exec("INSERT INTO metadata_tag_provider_name (tag_id, language, name, provider_id) SELECT 10, 'en-us', 'Example Provider Tag', id FROM metadata_provider WHERE code = 'dlsite'")
	exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (1, 10, 'test')")
	exec("INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')")
	exec("INSERT INTO user_work_state (user_id, work_id, listening_status) VALUES (?, 1, 'relisten')", userID)
	candidates := []RecommendationCandidate{
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 90), VoiceActors: []string{"Example Voice", "example alias", "Example Alias"}},
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 91), VoiceActors: []string{"Example Ambiguous"}},
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 92), Tags: []string{"Example Tag", "Example Localized Tag", "Example Provider Tag"}},
	}
	ctx := context.Background()
	first, err := store.ScoreRecommendationCandidates(ctx, userID, "aliases", candidates)
	if err != nil {
		t.Fatal(err)
	}
	if first[0].Score != 45 || first[0].Signals.PositiveVoiceMatches != 1 || first[1].Score != 35 || first[2].Score != 39 || first[2].Signals.PositiveTagMatches != 1 {
		t.Fatalf("alias scores=%+v", first)
	}
	exec("DELETE FROM person_alias WHERE alias = 'Example Alias'")
	candidates[0].VoiceActors = []string{"Example Alias"}
	frozen, err := store.ScoreRecommendationCandidates(ctx, userID, "aliases", candidates)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := store.ScoreRecommendationCandidates(ctx, userID, "aliases-new", candidates)
	if err != nil {
		t.Fatal(err)
	}
	if frozen[0].Score != 45 || fresh[0].Score != 35 {
		t.Fatalf("frozen=%d fresh=%d", frozen[0].Score, fresh[0].Score)
	}
}

func TestRecommendationDiversityPromotesOtherCreatorsWithinLane(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 8, 0, 0)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("DELETE FROM user_work_state")
	exec("INSERT INTO party (id, display_name) VALUES (1, 'Example Circle 1'), (2, 'Example Circle 2')")
	for id := 1; id <= 6; id++ {
		exec("INSERT INTO work_party (work_id, party_id, role, source) VALUES (?, 1, 'circle', 'test')", id)
	}
	exec("INSERT INTO work_party (work_id, party_id, role, source) VALUES (7, 2, 'circle', 'test')")
	exec("INSERT INTO user_work_state (user_id, work_id, listening_status) VALUES (?, 8, 'listening')", userID)
	exec("INSERT INTO app_setting (key, value_json) VALUES ('recommendation_config', ?)", `{"jitterAmplitude":0,"explorationAmplitude":0}`)
	ctx := context.Background()
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, "diversity")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		id      int64
		penalty int
	}{{1, 0}, {2, 2}, {5, 8}, {6, 8}, {7, 0}, {8, 0}} {
		breakdown, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, test.id)
		if err != nil {
			t.Fatal(err)
		}
		if breakdown.Score != 35 || breakdown.Signals.DiversityPenalty != test.penalty {
			t.Fatalf("work %d=%+v", test.id, breakdown)
		}
	}
	page, err := store.ListPage(ctx, ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RecommendationSessionID: "diversity", RandomSeed: 43})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Works) != 8 || page.Works[0].ID != 8 {
		t.Fatalf("listening priority lost: %+v", page.Works)
	}
	positions := map[int64]int{}
	for index, work := range page.Works {
		positions[work.ID] = index
	}
	if positions[7] >= positions[2] {
		t.Fatalf("other creator not promoted: %+v", positions)
	}
	exec("DELETE FROM work_party WHERE work_id = 2")
	frozen, err := store.RecommendationSnapshotBreakdown(ctx, snapshot, 2)
	if err != nil {
		t.Fatal(err)
	}
	if frozen.Signals.DiversityPenalty != 2 {
		t.Fatalf("placement changed mid-session: %+v", frozen)
	}
}

func TestRecommendationOrderingSQLMatchesExplanationAndExploresWeakerEvidence(t *testing.T) {
	store, _ := seedPaginationLibrary(t, 1, 0, 0)
	config := DefaultRecommendationConfig()
	for _, seed := range []int64{1, 43, 9127, -99} {
		low := RecommendationOrderingFor(1, 35, seed, config, 4)
		high := RecommendationOrderingFor(1, 80, seed, config, 4)
		if low.ExplorationBoost <= high.ExplorationBoost {
			t.Fatal("exploration does not favor weaker evidence")
		}
		orderSQL := recommendationExplorationOrderBy("id", "DESC", seed, config.JitterAmplitude, config.ExplorationAmplitude, "4")
		var actual float64
		// Extract the ordering expression before its direction and tie breakers.
		expression := orderSQL[:len(orderSQL)-len(" DESC, "+seededHashExpression("id", seed)+" ASC, id ASC")]
		if err := store.db.QueryRow("SELECT " + expression + " FROM (SELECT 1 AS id, 35 AS recommend_score)").Scan(&actual); err != nil {
			t.Fatal(err)
		}
		if math.Abs(actual-low.RankingScore) > 1e-9 {
			t.Fatalf("SQL=%f explanation=%f", actual, low.RankingScore)
		}
	}
}

func BenchmarkRemoteRecommendationBatch(b *testing.B) {
	store, userID := seedPaginationLibrary(b, 400, 0, 0)
	for voice := 1; voice <= 20; voice++ {
		if _, err := store.db.Exec("INSERT INTO person (id, display_name) VALUES (?, ?)", voice, fmt.Sprintf("Example Voice %d", voice)); err != nil {
			b.Fatal(err)
		}
	}
	if _, err := store.db.Exec("INSERT INTO work_credit (work_id, person_id, role, source) SELECT id, (id % 20) + 1, 'voice_actor', 'test' FROM work"); err != nil {
		b.Fatal(err)
	}
	ctx := context.Background()
	if _, err := store.PrepareRecommendationSession(ctx, userID, "benchmark"); err != nil {
		b.Fatal(err)
	}
	b.Run("generation_400", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			tx, err := store.db.BeginTx(ctx, nil)
			if err != nil {
				b.Fatal(err)
			}
			_, err = buildRecommendationGeneration(ctx, tx, userID, DefaultRecommendationConfig(), 1, 1)
			_ = tx.Rollback()
			if err != nil {
				b.Fatal(err)
			}
		}
	})
	for _, count := range []int{24, 100} {
		b.Run(fmt.Sprintf("works_%d", count), func(b *testing.B) {
			candidates := make([]RecommendationCandidate, count)
			for index := range candidates {
				candidates[index] = RecommendationCandidate{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, index), VoiceActors: []string{fmt.Sprintf("Example Voice %d", index%20+1)}}
			}
			b.ReportAllocs()
			for b.Loop() {
				if _, err := store.ScoreRecommendationCandidates(ctx, userID, "benchmark", candidates); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
