package library

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Compare the paginated read with the existing complete projection: ties, nulls,
// recommendation lanes and filters must not change the cards or their ordering.
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
		for _, sortKey := range []string{"recent", "release", "title", "code", "rating", "sales", "random", "recommend"} {
			for _, direction := range []string{"asc", "desc"} {
				t.Run(mode.name+"/"+sortKey+"/"+direction, func(t *testing.T) {
					options := ListOptions{UserID: mode.userID, PageSize: 7, Sort: sortKey, Direction: direction, RandomSeed: 43, IncludeRecommendation: true, RecommendationSessionID: mode.session}
					for _, query := range []string{"", "Example Work 1", "absent synthetic title"} {
						options.Query = query
						where, filterArgs := listWhere(options.Scope, options.Status, options.Query, options.UserID, false)
						config, generationID, err := store.listPageRecommendationContext(ctx, options, true)
						if err != nil {
							t.Fatal(err)
						}
						args := []any{}
						if generationID == 0 {
							args = append(args, recommendationUserArgs(options.UserID)...)
						}
						args = append(args, options.UserID)
						args = append(args, filterArgs...)
						rows, err := store.db.QueryContext(ctx, listSelectSQLWithRecommendationGeneration(where, sortKey, direction, 43, config, true, generationID), args...)
						if err != nil {
							t.Fatal(err)
						}
						expected, err := ScanRows(rows)
						if err != nil {
							t.Fatal(err)
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
	statuses := []string{"none", "want_to_listen", "listening", "relisten", "finished", "paused"}
	for index := 0; index < count; index++ {
		code := testfixture.WorkCode(testfixture.PrefixRJ, index%100)
		if count > 100 {
			code = testfixture.WorkCodeAt(index)
		}
		var rating, sales, release any
		if index%3 != 0 {
			rating, sales, release = float64(index%5), index%11, "2026-01-01"
		}
		workID := exec(`INSERT INTO work (primary_code, title, rating_average, sales_count, release_date, created_at)
			VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00')`, code, fmt.Sprintf("Example Work %d", index%20), rating, sales, release)
		exec("INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, ?, ?)", workID, providerID, code, `{"description":"`+strings.Repeat("x", snapshotBytes)+`"}`)
		exec("INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (?, ?, 'local', 'available')", workID, sourceID)
		exec("INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (?, ?, ?, ?)", userID, workID, statuses[index%len(statuses)], index%2)
		for track := 0; track < tracks; track++ {
			mediaID := exec("INSERT INTO media_item (work_id, kind, title, track_no) VALUES (?, 'audio', 'Example Track', ?)", workID, track)
			exec("INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (?, ?, 'local', ?, 'available')", mediaID, sourceID, fmt.Sprintf("Library/%s/track-%d.mp3", code, track))
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
	return store, userID
}
