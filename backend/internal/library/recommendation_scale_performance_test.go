package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// This harness uses only API contracts shared by v5 and v6. The runner copies
// it and its synthetic fixture into an archived base revision for comparison.
// It asserts functional and structural contracts, never latency thresholds.
func TestRecommendationScalePerformance(t *testing.T) {
	if os.Getenv("KIKOTO_RECOMMENDATION_PERF") != "1" {
		t.Skip("opt-in scale experiment")
	}
	counts := []int{50000, 100000}
	if raw := os.Getenv("KIKOTO_RECOMMENDATION_PERF_WORKS"); raw != "" {
		counts = nil
		for _, item := range strings.Split(raw, ",") {
			count, err := strconv.Atoi(item)
			if err != nil {
				t.Fatal(err)
			}
			counts = append(counts, count)
		}
	}
	for _, count := range counts {
		t.Run(fmt.Sprintf("works_%d", count), func(t *testing.T) { runRecommendationScale(t, count) })
	}
}

type scaleCatalogProcessor interface {
	ProcessRecommendationCatalog(context.Context, int) (int, error)
}

type scaleDiagnosticStore interface {
	RecommendationDiagnostics() map[string]int64
}

func scaleDiagnostics(store *Store) map[string]int64 {
	if diagnostic, ok := any(store).(scaleDiagnosticStore); ok {
		return diagnostic.RecommendationDiagnostics()
	}
	return nil
}

func scaleLogDiagnostics(t testing.TB, store *Store, phase string, before map[string]int64) {
	t.Helper()
	after := scaleDiagnostics(store)
	if after == nil {
		t.Logf("logical_rows/%s instrumented=unavailable", phase)
		return
	}
	delta := map[string]int64{}
	for key, value := range after {
		delta[key] = value - before[key]
	}
	encoded, err := json.Marshal(delta)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("logical_rows/%s counters=%s sqlite_internal_visited_rows=unavailable", phase, encoded)
}

func scaleDrainCatalog(t testing.TB, store *Store) {
	t.Helper()
	processor, ok := any(store).(scaleCatalogProcessor)
	if !ok {
		return
	}
	for {
		processed, err := metasync.ProcessMetadataTagQueue(context.Background(), store.db, 64, nil)
		if err != nil {
			t.Fatal(err)
		}
		if processed == 0 {
			break
		}
	}
	for {
		processed, err := processor.ProcessRecommendationCatalog(context.Background(), 64)
		if err != nil {
			t.Fatal(err)
		}
		if processed == 0 {
			return
		}
	}
}

func runRecommendationScale(t *testing.T, works int) {
	ctx := context.Background()
	preparedUsers := 40
	if raw := os.Getenv("KIKOTO_RECOMMENDATION_PERF_PREPARED_USERS"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 24 || value > 100 || value%4 != 0 {
			t.Fatal("prepared users must be a multiple of four between 24 and 100")
		}
		preparedUsers = value
	}
	dbPath := filepath.Join(t.TempDir(), "recommendation.db")
	db, err := storage.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if err := storage.Migrate(db, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	testfixture.SeedRecommendationScale(t, db, works, 100)
	store := NewStore(db)
	scaleDrainCatalog(t, store)
	if err := store.RefreshSearchIndex(ctx); err != nil {
		t.Fatal(err)
	}
	if err := storage.OptimizeStatistics(ctx, db); err != nil {
		t.Fatal(err)
	}
	t.Logf("conditions algorithm=%s runtime=%s works=%d users=100 prepared_users=%d feedback=0,10,100,1000 popular_tag_works=%d voices=40 circles=10 pool=4 seed=43 setup_ms=%.3f", RecommendationAlgorithmVersion, runtime.Version(), works, preparedUsers, works, float64(time.Since(start))/float64(time.Millisecond))
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	poolBefore := db.Stats()
	diagnosticsBefore := scaleDiagnostics(store)
	cold := make([]time.Duration, preparedUsers)
	errors := make([]error, preparedUsers)
	snapshots := make([]RecommendationSessionSnapshot, preparedUsers)
	var group sync.WaitGroup
	gate := make(chan struct{})
	for index := range 20 {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-gate
			start := time.Now()
			snapshots[index], errors[index] = store.PrepareRecommendationSession(ctx, int64(index+1), "synthetic-cold")
			cold[index] = time.Since(start)
		}(index)
	}
	close(gate)
	group.Wait()
	scaleLogLatency(t, "cold/concurrent20", cold[:20])
	for index := 20; index < preparedUsers; index++ {
		start := time.Now()
		snapshots[index], errors[index] = store.PrepareRecommendationSession(ctx, int64(index+1), "synthetic-cold")
		cold[index] = time.Since(start)
		if (index+1)%20 == 0 {
			t.Logf("progress/cold prepared_users=%d measured_users=%d fixture_users=100", index+1, preparedUsers)
		}
	}
	for index, err := range errors {
		if err != nil {
			t.Fatalf("cold user %d: %v", index+1, err)
		}
	}
	runtime.ReadMemStats(&after)
	for densityIndex, density := range []int{0, 10, 100, 1000} {
		var samples []time.Duration
		for index := 20 + densityIndex; index < preparedUsers; index += 4 {
			samples = append(samples, cold[index])
		}
		scaleLogLatency(t, fmt.Sprintf("cold/sequential/feedback_%d", density), samples)
	}
	poolAfter := db.Stats()
	scaleLogDiagnostics(t, store, fmt.Sprintf("cold_%d_prepared_users", preparedUsers), diagnosticsBefore)
	t.Logf("resources/cold allocated_bytes=%d heap_inuse_bytes=%d go_sys_bytes=%d pool_wait_count=%d pool_wait_ms=%.3f read_rows=unavailable write_rows=see_persisted_counts", after.TotalAlloc-before.TotalAlloc, after.HeapInuse, after.Sys, poolAfter.WaitCount-poolBefore.WaitCount, float64(poolAfter.WaitDuration-poolBefore.WaitDuration)/float64(time.Millisecond))
	scaleLogStorage(t, db, dbPath, fmt.Sprintf("%d_prepared_users", preparedUsers))
	for _, densityIndex := range []int{0, 1, 2, 3} {
		userID := int64(densityIndex + 1)
		options := ListOptions{UserID: userID, Page: 1, PageSize: 100, Sort: "recommend", Direction: "desc", RandomSeed: 43, RecommendationSessionID: "synthetic-cold", Scope: "all"}
		start := time.Now()
		diagnosticsBefore = scaleDiagnostics(store)
		page, err := store.ListPage(ctx, options)
		if err != nil {
			t.Fatal(err)
		}
		if len(page.Works) != 100 || page.Total != works {
			t.Fatalf("invalid list: %d/%d", len(page.Works), page.Total)
		}
		t.Logf("context/feedback_%d first_ms=%.3f", []int{0, 10, 100, 1000}[densityIndex], float64(time.Since(start))/float64(time.Millisecond))
		scaleLogDiagnostics(t, store, fmt.Sprintf("context_feedback_%d", []int{0, 10, 100, 1000}[densityIndex]), diagnosticsBefore)
		var hot []time.Duration
		diagnosticsBefore = scaleDiagnostics(store)
		for sample := range 23 {
			options.Page = 1 + sample%3
			start := time.Now()
			page, err = store.ListPage(ctx, options)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Works) != 100 || page.Total != works {
				t.Fatal("hot list contract")
			}
			if sample >= 3 {
				hot = append(hot, time.Since(start))
			}
		}
		scaleLogLatency(t, fmt.Sprintf("hot/recommend/feedback_%d", []int{0, 10, 100, 1000}[densityIndex]), hot)
		scaleLogDiagnostics(t, store, fmt.Sprintf("hot_recommend_feedback_%d", []int{0, 10, 100, 1000}[densityIndex]), diagnosticsBefore)
		options.Sort, options.IncludeRecommendation = "recent", true
		hot = nil
		diagnosticsBefore = scaleDiagnostics(store)
		var contextsBefore int
		if scaleHasTable(db, "recommendation_query_context") {
			if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_query_context").Scan(&contextsBefore); err != nil {
				t.Fatal(err)
			}
		}
		for sample := range 23 {
			start := time.Now()
			page, err = store.ListPage(ctx, options)
			if err != nil {
				t.Fatal(err)
			}
			if len(page.Works) != 100 || page.Total != works {
				t.Fatal("badge list contract")
			}
			if sample >= 3 {
				hot = append(hot, time.Since(start))
			}
		}
		scaleLogLatency(t, fmt.Sprintf("hot/badges100/feedback_%d", []int{0, 10, 100, 1000}[densityIndex]), hot)
		scaleLogDiagnostics(t, store, fmt.Sprintf("hot_badges_feedback_%d", []int{0, 10, 100, 1000}[densityIndex]), diagnosticsBefore)
		if scaleHasTable(db, "recommendation_query_context") {
			var contextsAfter int
			if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_query_context").Scan(&contextsAfter); err != nil {
				t.Fatal(err)
			}
			if contextsAfter != contextsBefore {
				t.Fatal("ordinary badges created recommendation contexts")
			}
		}
		if densityIndex > 0 {
			scaleLogCandidateQuality(t, db, snapshots[densityIndex], works)
		}
	}
	scaleLogStorage(t, db, dbPath, "contexts")
	// Keep two sessions per user and change a bounded metadata cohort, so the
	// reported footprint includes protected generations and shared history.
	if _, err := db.Exec("DELETE FROM work_tag WHERE tag_id = 22 AND work_id <= 1000"); err != nil {
		t.Fatal(err)
	}
	scaleDrainCatalog(t, store)
	for user := 1; user <= 20; user++ {
		if _, err := db.Exec("UPDATE user_work_state SET favorite = 1-favorite WHERE user_id = ? AND work_id = (SELECT MIN(work_id) FROM user_work_state WHERE user_id = ?)", user, user); err != nil {
			t.Fatal(err)
		}
		if _, err := store.PrepareRecommendationSession(ctx, int64(user), "synthetic-retained"); err != nil {
			t.Fatal(err)
		}
	}
	scaleLogStorage(t, db, dbPath, "retained_generations_and_history")
	scaleMeasureWriterWait(t, store, dbPath)
}

func scaleLogLatency(t testing.TB, name string, samples []time.Duration) {
	t.Helper()
	ordered := append([]time.Duration(nil), samples...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	t.Logf("%s n=%d errors=0 p50_ms=%.3f p95_ms=%.3f", name, len(ordered), float64(ordered[(len(ordered)-1)/2])/float64(time.Millisecond), float64(ordered[(len(ordered)*95+99)/100-1])/float64(time.Millisecond))
}

func scaleHasTable(db *sql.DB, table string) bool {
	var exists bool
	_ = db.QueryRow("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", table).Scan(&exists)
	return exists
}

func scaleLogStorage(t testing.TB, db *sql.DB, path, phase string) {
	t.Helper()
	allocated := map[string]int64{}
	if rows, err := db.Query("SELECT name,SUM(pgsize) FROM dbstat GROUP BY name"); err == nil {
		for rows.Next() {
			var name string
			var bytes int64
			if err := rows.Scan(&name, &bytes); err != nil {
				t.Fatal(err)
			}
			allocated[name] = bytes
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
	}
	for _, table := range []string{"recommendation_snapshot", "recommendation_generation", "recommendation_generation_profile", "recommendation_generation_state", "recommendation_query_context", "recommendation_query_candidate", "recommendation_query_checkpoint", "recommendation_catalog_epoch", "recommendation_catalog_work", "recommendation_catalog_entity", "recommendation_catalog_frequency", "recommendation_catalog_name"} {
		if !scaleHasTable(db, table) {
			continue
		}
		var count int64
		if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if len(allocated) > 0 {
			bytes := allocated[table]
			rows, err := db.Query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?", table)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var name string
				if err := rows.Scan(&name); err != nil {
					t.Fatal(err)
				}
				bytes += allocated[name]
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if err := rows.Close(); err != nil {
				t.Fatal(err)
			}
			t.Logf("storage/%s table=%s rows=%d allocated_bytes=%d", phase, table, count, bytes)
		} else {
			t.Logf("storage/%s table=%s rows=%d allocated_bytes=unavailable", phase, table, count)
		}
	}
	var profileBytes, profileMax int64
	if err := db.QueryRow("SELECT COALESCE(SUM(length(CAST(profile_json AS BLOB))),0),COALESCE(MAX(length(CAST(profile_json AS BLOB))),0) FROM recommendation_generation_profile").Scan(&profileBytes, &profileMax); err != nil {
		t.Fatal(err)
	}
	t.Logf("storage/%s profile_json_bytes=%d largest_profile_bytes=%d", phase, profileBytes, profileMax)
	if scaleHasTable(db, "recommendation_query_context") {
		var scored, prefix, contexts int
		if err := db.QueryRow("SELECT COALESCE(MAX(candidate_count),0) FROM recommendation_query_context").Scan(&scored); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow("SELECT COALESCE(MAX(n),0) FROM (SELECT COUNT(*) n FROM recommendation_query_candidate GROUP BY context_id)").Scan(&prefix); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow("SELECT COALESCE(MAX(n),0) FROM (SELECT COUNT(*) n FROM recommendation_query_context GROUP BY generation_id)").Scan(&contexts); err != nil {
			t.Fatal(err)
		}
		if scored > 2000 || prefix > 500 || contexts > 8 {
			t.Fatalf("unbounded context: %d/%d/%d", scored, prefix, contexts)
		}
		t.Logf("bounds/%s max_scored=%d max_prefix=%d max_contexts=%d ordinary_page_scored=100", phase, scored, prefix, contexts)
	} else {
		var scored int
		if err := db.QueryRow("SELECT COALESCE(MAX(n),0) FROM (SELECT COUNT(*) n FROM recommendation_snapshot GROUP BY generation_id)").Scan(&scored); err != nil {
			t.Fatal(err)
		}
		t.Logf("bounds/%s generation_scored=%d", phase, scored)
	}
	if _, err := db.Exec("PRAGMA wal_checkpoint(PASSIVE)"); err != nil {
		t.Fatal(err)
	}
	var fileBytes int64
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if info, err := os.Stat(path + suffix); err == nil {
			fileBytes += info.Size()
		}
	}
	t.Logf("storage/%s database_plus_wal_shm_bytes=%d", phase, fileBytes)
}

func scaleLogCandidateQuality(t testing.TB, db *sql.DB, snapshot RecommendationSessionSnapshot, works int) {
	t.Helper()
	var raw string
	if err := db.QueryRow("SELECT profile_json FROM recommendation_generation_profile WHERE generation_id=?", snapshot.GenerationID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var profile RecommendationProfile
	if err := json.Unmarshal([]byte(raw), &profile); err != nil {
		t.Fatal(err)
	}
	// Exclude the sparse feedback works to avoid measuring self-evidence or
	// mixing state lanes. This is a tie-aware affinity diagnostic, not a claim
	// that bounded recall preserves the full-library recommendation order.
	var userID int64
	if err := db.QueryRow("SELECT user_id FROM recommendation_generation WHERE id=?", snapshot.GenerationID).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	excluded := map[int64]bool{}
	rows, err := db.Query("SELECT work_id FROM user_work_state WHERE user_id=?", userID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		excluded[id] = true
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	scores := make(map[int64]int, works)
	ordered := make([]int, 0, works)
	for id := int64(1); id <= int64(works); id++ {
		if excluded[id] {
			continue
		}
		candidate := RecommendationCandidate{Tags: []string{"Example Tag 1", fmt.Sprintf("Example Tag %d", 2+id%20), fmt.Sprintf("Example Tag %d", 22+id%200)}, VoiceActors: []string{fmt.Sprintf("Example Voice %d", 1+id%40)}, Circle: fmt.Sprintf("Example Circle %d", 1+id%10)}
		score := buildRecommendationBreakdown(snapshot.Config, profile.candidateSignals(candidate, snapshot.Config)).Score
		scores[id] = score
		ordered = append(ordered, score)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(ordered)))
	if len(ordered) == 0 {
		t.Logf("quality/user_%d nonfeedback_works=0", userID)
		return
	}
	threshold := ordered[min(99, len(ordered)-1)]
	query := "SELECT work_id FROM recommendation_snapshot WHERE generation_id=? ORDER BY score DESC,work_id LIMIT 500"
	if scaleHasTable(db, "recommendation_query_candidate") {
		query = "SELECT candidate.work_id FROM recommendation_query_candidate candidate JOIN recommendation_query_context context ON context.id=candidate.context_id WHERE context.generation_id=?"
	}
	rows, err = db.Query(query, snapshot.GenerationID)
	if err != nil {
		t.Fatal(err)
	}
	var eligible, hits, sum, best int
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		if excluded[id] {
			continue
		}
		score := scores[id]
		eligible++
		sum += score
		if score >= threshold {
			hits++
		}
		best = max(best, score)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}
	avg := 0.0
	if eligible > 0 {
		avg = float64(sum) / float64(eligible)
	}
	t.Logf("quality/user_%d prefix_nonfeedback=%d at_or_above_top100_affinity=%d top100_threshold=%d best_prefix_affinity=%d best_library_affinity=%d mean_prefix_affinity=%.3f", userID, eligible, hits, threshold, best, ordered[0], avg)
}

func scaleMeasureWriterWait(t testing.TB, store *Store, path string) {
	t.Helper()
	probe, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = probe.Close() }()
	probe.SetMaxOpenConns(1)
	var waits []time.Duration
	for index := range 5 {
		if _, err := store.db.Exec("UPDATE user_work_state SET favorite=1-favorite WHERE user_id=4 AND work_id=(SELECT MIN(work_id) FROM user_work_state WHERE user_id=4)"); err != nil {
			t.Fatal(err)
		}
		started := make(chan struct{})
		finished := make(chan error, 1)
		go func() {
			close(started)
			_, err := store.PrepareRecommendationSession(context.Background(), 4, fmt.Sprintf("synthetic-lock-%d", index))
			finished <- err
		}()
		<-started
		time.Sleep(time.Millisecond)
		start := time.Now()
		tx, err := probe.BeginTx(context.Background(), nil)
		waits = append(waits, time.Since(start))
		if err != nil {
			t.Fatal(err)
		}
		if err := tx.Rollback(); err != nil {
			t.Fatal(err)
		}
		if err := <-finished; err != nil {
			t.Fatal(err)
		}
	}
	scaleLogLatency(t, "writer_probe/during_cold", waits)
}
