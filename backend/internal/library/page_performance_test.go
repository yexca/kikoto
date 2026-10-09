package library

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Separate SQL experiments isolate phases; their timings are not additive
// spans of one request. The full query and HTTP matrix are the benefit gates.
func TestLibraryPagePerformance(t *testing.T) {
	if os.Getenv("KIKOTO_BROWSE_PERF") != "1" {
		t.Skip("opt-in performance experiment")
	}
	for _, summarized := range []bool{false, true} {
		for _, analyzed := range []bool{false, true} {
			db, err := storage.Open(filepath.Join(t.TempDir(), "library.db"))
			if err != nil {
				t.Fatal(err)
			}
			if err := storage.Migrate(db, "../../migrations"); err != nil {
				t.Fatal(err)
			}
			testfixture.SeedBrowse(t, db)
			if summarized {
				// This fixture's raw snapshots contain only workno, so {v:1} is
				// their exact card projection. HTTP uses the real backfill path.
				if _, err := db.Exec(`INSERT INTO metadata_snapshot_card_summary(snapshot_id,version,summary_json) SELECT id,1,'{"v":1}' FROM metadata_snapshot; DELETE FROM metadata_snapshot_card_summary_dirty`); err != nil {
					t.Fatal(err)
				}
			}
			testfixture.ClearBrowseStatistics(t, db)
			if analyzed {
				if err := storage.OptimizeStatistics(context.Background(), db); err != nil {
					t.Fatal(err)
				}
			}
			db.SetMaxIdleConns(0)
			db.SetMaxIdleConns(4)
			for _, scope := range []string{"local", "all"} {
				name := fmt.Sprintf("scope=%s/stats=%t/summary=%t", scope, analyzed, summarized)
				where, args := listWhere(scope, "", "", 1, false)
				countSQL := `SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id=work.id AND user_work_state.user_id=? WHERE ` + where
				countArgs := append([]any{int64(1)}, args...)
				pageSQL := listPageSelectSQL(where, "recent", "desc", 1, DefaultRecommendationConfig(), false, 0)
				pageArgs := append(append([]any{}, countArgs...), 24, 0)
				end := strings.Index(pageSQL, ")\n\t\tSELECT ")
				if end < 0 {
					t.Fatal("page CTE boundary missing")
				}
				candidateSQL := pageSQL[:end+1] + ` SELECT id FROM library_page`
				projectionSQL := `SELECT ` + listSummaryColumnsSQL + `,COALESCE(user_work_state.listening_status,'none'),COALESCE(user_work_state.favorite,0),0 FROM work LEFT JOIN user_work_state ON user_work_state.work_id=work.id AND user_work_state.user_id=1 WHERE work.id BETWEEN 377 AND 400 ORDER BY work.id DESC`
				for _, stage := range []struct {
					name, query string
					args        []any
				}{
					{"count", countSQL, countArgs},
					{"candidate-sort", candidateSQL, pageArgs},
					{"page-projection-isolated", projectionSQL, nil},
					{"full-page-query", pageSQL, pageArgs},
				} {
					times := make([]time.Duration, 0, 60)
					for sample := range 63 {
						start := time.Now()
						rows, err := db.Query(stage.query, stage.args...)
						if err != nil {
							t.Fatal(err)
						}
						columns, err := rows.Columns()
						if err != nil {
							t.Fatal(err)
						}
						values := make([]any, len(columns))
						targets := make([]any, len(columns))
						for i := range targets {
							targets[i] = &values[i]
						}
						for rows.Next() {
							if err := rows.Scan(targets...); err != nil {
								t.Fatal(err)
							}
						}
						if err := rows.Err(); err != nil {
							t.Fatal(err)
						}
						if err := rows.Close(); err != nil {
							t.Fatal(err)
						}
						if sample >= 3 {
							times = append(times, time.Since(start))
						}
					}
					sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
					t.Logf("sql/%s/%s n=60 errors=0 p50=%.3fms p95=%.3fms", name, stage.name, float64(times[29])/float64(time.Millisecond), float64(times[56])/float64(time.Millisecond))
					rows, err := db.Query(`EXPLAIN QUERY PLAN `+stage.query, stage.args...)
					if err != nil {
						t.Fatal(err)
					}
					for rows.Next() {
						var id, parent, unused int
						var detail string
						if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
							t.Fatal(err)
						}
						t.Logf("plan/%s/%s %d %d %s", name, stage.name, id, parent, detail)
					}
					if err := rows.Err(); err != nil {
						t.Fatal(err)
					}
					if err := rows.Close(); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
		}
	}
}
