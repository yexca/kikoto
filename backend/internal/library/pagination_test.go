package library

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Ordinary pagination retains its SQL projection and ordering. Optional badges
// are read after paging from the frozen profile instead of a full score join.
func TestListPagePreservesOrderedProjection(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 60, 2, 256)
	ctx := context.Background()
	for _, mode := range []struct {
		name    string
		userID  int64
		session string
	}{
		{"anonymous", 0, ""}, {"live", userID, ""}, {"snapshot", userID, "synthetic-session"},
	} {
		for _, sortKey := range []string{"recent", "release", "title", "code", "rating", "sales", "random"} {
			for _, direction := range []string{"asc", "desc"} {
				t.Run(mode.name+"/"+sortKey+"/"+direction, func(t *testing.T) {
					options := ListOptions{UserID: mode.userID, PageSize: 7, Sort: sortKey, Direction: direction, RandomSeed: 43, IncludeRecommendation: true, RecommendationSessionID: mode.session}
					for _, query := range []string{"", "Example Work 1", "absent synthetic title"} {
						options.Query = query
						where, filterArgs := listWhere(options.Scope, options.Status, options.Query, options.UserID, false)
						args := []any{}
						args = append(args, options.UserID)
						args = append(args, filterArgs...)
						rows, err := store.db.QueryContext(ctx, listSelectSQLWithRecommendationGeneration(where, sortKey, direction, 43, DefaultRecommendationConfig(), false, 0), args...)
						if err != nil {
							t.Fatal(err)
						}
						expected, err := ScanRows(rows)
						if err != nil {
							t.Fatal(err)
						}
						snapshot, err := store.snapshotForRecommendation(ctx, options.UserID, options.RecommendationSessionID)
						if err != nil {
							t.Fatal(err)
						}
						ids := make([]int64, len(expected))
						for index := range expected {
							ids[index] = expected[index].ID
						}
						scores, err := store.scoreRecommendationWorks(ctx, snapshot, ids)
						if err != nil {
							t.Fatal(err)
						}
						for index := range expected {
							expected[index].RecommendScore = scores[expected[index].ID].Score
						}
						for _, pageNo := range []int{1, 2, 9, 10} {
							options.Page = pageNo
							page, err := store.ListPage(ctx, options)
							if err != nil {
								t.Fatal(err)
							}
							start := min((pageNo-1)*options.PageSize, len(expected))
							end := min(start+options.PageSize, len(expected))
							if page.Total != len(expected) || len(page.Works) != end-start || (end > start && !reflect.DeepEqual(page.Works, expected[start:end])) {
								t.Fatalf("query %q page %d changed cards or order", query, pageNo)
							}
						}
					}
				})
			}
		}
	}
}

func BenchmarkLibraryRecommendationPage(b *testing.B) {
	store, userID := seedPaginationLibrary(b, 400, 20, 32768)
	ctx := context.Background()
	options := ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 43, RecommendationSessionID: "synthetic-session"}
	snapshot, err := store.PrepareRecommendationSession(ctx, userID, options.RecommendationSessionID)
	if err != nil {
		b.Fatal(err)
	}
	where, args := listWhere("", "", "", userID, false)
	args = append([]any{userID}, args...)
	args = append(args, options.PageSize, 0)
	queries := map[string]string{
		"full_projection_before_paging": listSelectSQLWithRecommendationGeneration(where, options.Sort, options.Direction, options.RandomSeed, snapshot.Config, true, snapshot.GenerationID) + " LIMIT ? OFFSET ?",
		"page_before_projection":        listPageSelectSQL(where, options.Sort, options.Direction, options.RandomSeed, snapshot.Config, true, snapshot.GenerationID),
	}
	for _, name := range []string{"full_projection_before_paging", "page_before_projection"} {
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				rows, err := store.db.QueryContext(ctx, queries[name], args...)
				if err != nil {
					b.Fatal(err)
				}
				if _, err := ScanRows(rows); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func seedPaginationLibrary(t testing.TB, count, tracks, snapshotBytes int) (*Store, int64) {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	exec := func(query string, args ...any) int64 {
		result, err := tx.Exec(query, args...)
		if err != nil {
			t.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	userID := exec("INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-user', 'Example User', 'user')")
	sourceID := exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('example_local', 'Example Local', 'local_folder')")
	var providerID int64
	if err := tx.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	prepare := func(query string) *sql.Stmt {
		stmt, err := tx.Prepare(query)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = stmt.Close() })
		return stmt
	}
	insertWork := prepare(`INSERT INTO work (primary_code, title, rating_average, sales_count, release_date, created_at)
		VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00')`)
	insertSnapshot := prepare("INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, ?, ?)")
	insertPresence := prepare("INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (?, ?, 'local', 'available')")
	insertState := prepare("INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (?, ?, ?, ?)")
	insertMedia := prepare("INSERT INTO media_item (work_id, kind, title, track_no) VALUES (?, 'audio', 'Example Track', ?)")
	insertLocation := prepare("INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (?, ?, 'local', ?, 'available')")
	execPrepared := func(stmt *sql.Stmt, args ...any) int64 {
		result, err := stmt.Exec(args...)
		if err != nil {
			t.Fatal(err)
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	statuses := []string{"none", "want_to_listen", "listening", "relisten", "finished", "paused"}
	for index := 0; index < count; index++ {
		code := testfixture.WorkCode(testfixture.PrefixRJ, index%100)
		if count > 400 {
			code = testfixture.HighCardinalityWorkCodeAt(index)
		} else if count > 100 {
			code = testfixture.WorkCodeAt(index)
		}
		var rating, sales, release any
		if index%3 != 0 {
			rating, sales, release = float64(index%5), index%11, "2026-01-01"
		}
		workID := execPrepared(insertWork, code, fmt.Sprintf("Example Work %d", index%20), rating, sales, release)
		execPrepared(insertSnapshot, workID, providerID, code, `{"description":"`+strings.Repeat("x", snapshotBytes)+`"}`)
		execPrepared(insertPresence, workID, sourceID)
		execPrepared(insertState, userID, workID, statuses[index%len(statuses)], index%2)
		for track := 0; track < tracks; track++ {
			mediaID := execPrepared(insertMedia, workID, track)
			execPrepared(insertLocation, mediaID, sourceID, fmt.Sprintf("Library/%s/track-%d.mp3", code, track))
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	// Match a started server, whose warm-up leaves no queued search documents.
	if err := store.RefreshSearchIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	publishRecommendationCatalog(t, store)
	return store, userID
}

func publishRecommendationCatalog(t testing.TB, store *Store) {
	t.Helper()
	// Library fixtures author their effective relations directly, representing
	// the completed metadata projection that server startup normally prepares.
	if _, err := store.db.Exec("DELETE FROM work_metadata_tag_dirty"); err != nil {
		t.Fatal(err)
	}
	for {
		processed, err := store.ProcessRecommendationCatalog(context.Background(), 64)
		if err != nil {
			t.Fatal(err)
		}
		if processed == 0 {
			return
		}
	}
}

// Nullable sort values stay after every known value in both directions, with
// ties broken by the newest or oldest addition.
func TestListPagePlacesMissingSortValuesLast(t *testing.T) {
	db, err := storage.Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db, "../../migrations"); err != nil {
		t.Fatal(err)
	}
	for ordinal, row := range []struct {
		release, rating, sales any
	}{
		{"2026-02-01", 4.0, 20},
		{nil, nil, nil},
		{"2026-01-01", 3.0, 10},
		{nil, nil, nil},
	} {
		if _, err := db.Exec(`INSERT INTO work (primary_code, title, release_date, rating_average, sales_count, created_at) VALUES (?, 'Example Work', ?, ?, ?, ?)`,
			testfixture.WorkCode(testfixture.PrefixRJ, ordinal), row.release, row.rating, row.sales, fmt.Sprintf("2026-01-01 00:00:0%d", ordinal)); err != nil {
			t.Fatal(err)
		}
	}
	store := NewStore(db)
	want := map[string][]string{
		"desc": {"RJ00000000", "RJ00000002", "RJ00000003", "RJ00000001"},
		"asc":  {"RJ00000002", "RJ00000000", "RJ00000001", "RJ00000003"},
	}
	for _, sortKey := range []string{"release", "rating", "sales"} {
		for direction, codes := range want {
			page, err := store.ListPage(context.Background(), ListOptions{PageSize: 10, Sort: sortKey, Direction: direction})
			if err != nil {
				t.Fatal(err)
			}
			got := []string{}
			for _, work := range page.Works {
				got = append(got, work.PrimaryCode)
			}
			if !reflect.DeepEqual(got, codes) {
				t.Fatalf("%s %s order = %v, want %v", sortKey, direction, got, codes)
			}
		}
	}
}

// A Library page walks an ordered index and stops after the page instead of
// sorting every matching work first.
func TestListPageReadsOrderedIndexes(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 3, 0, 0)
	for _, testCase := range []struct {
		sortKey, direction, index string
	}{
		{"recent", "desc", "idx_work_created_at"},
		{"recent", "asc", "idx_work_created_at"},
		{"release", "desc", "idx_work_release_date"},
		{"release", "asc", "idx_work_release_date_nulls_last"},
	} {
		where, args := listWhere("", "", "", userID, false)
		query := listPageSelectSQL(where, testCase.sortKey, testCase.direction, 1, DefaultRecommendationConfig(), false, 0)
		queryArgs := append([]any{userID}, args...)
		rows, err := store.db.Query("EXPLAIN QUERY PLAN "+query, append(queryArgs, 24, 0)...)
		if err != nil {
			t.Fatal(err)
		}
		plan := []string{}
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			plan = append(plan, detail)
		}
		if err := rows.Close(); err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(plan, "SCAN work USING INDEX "+testCase.index) {
			t.Fatalf("%s %s plan does not scan %s:\n%s", testCase.sortKey, testCase.direction, testCase.index, strings.Join(plan, "\n"))
		}
	}
}
