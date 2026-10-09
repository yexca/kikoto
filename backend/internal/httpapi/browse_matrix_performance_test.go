package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Opt-in, with no latency assertions. Run without builds or other benchmarks.
func TestBrowseMatrixPerformance(t *testing.T) {
	if os.Getenv("KIKOTO_BROWSE_PERF") != "1" {
		t.Skip("opt-in performance experiment")
	}
	for _, summarized := range []bool{false, true} {
		for _, analyzed := range []bool{false, true} {
			db := openMigratedTestDBWithProductionPool(t)
			testfixture.SeedBrowse(t, db)
			server := NewServer(db, config.Config{Mode: config.ModeProduction, DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
			if err := server.LoadAccessPolicy(context.Background()); err != nil {
				t.Fatal(err)
			}
			if summarized {
				for {
					n, err := server.backfillSnapshotCardSummaries(context.Background(), 200)
					if err != nil {
						t.Fatal(err)
					}
					if n == 0 {
						break
					}
				}
			}
			testfixture.ClearBrowseStatistics(t, db)
			if analyzed {
				if err := storage.OptimizeStatistics(context.Background(), db); err != nil {
					t.Fatal(err)
				}
			}
			// Every pooled connection must open with the same persisted statistics.
			db.SetMaxIdleConns(0)
			db.SetMaxIdleConns(4)
			httpServer := httptest.NewServer(server.Routes())
			client := &http.Client{Timeout: 10 * time.Second}
			for _, scope := range []string{"local", "all"} {
				name := fmt.Sprintf("scope=%s/stats=%t/summary=%t", scope, analyzed, summarized)
				measure := func(size, concurrency, n int) {
					path := fmt.Sprintf("/api/works?page=1&pageSize=%d&scope=%s&sort=recent&direction=desc&recommendBadges=false", size, scope)
					request := func() (time.Duration, int64, error) {
						req, err := http.NewRequest(http.MethodGet, httpServer.URL+path, nil)
						if err != nil {
							return 0, 0, err
						}
						req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "synthetic-token"})
						start := time.Now()
						response, err := client.Do(req)
						if err != nil {
							return time.Since(start), 0, err
						}
						defer func() { _ = response.Body.Close() }()
						body, err := io.ReadAll(response.Body)
						elapsed := time.Since(start)
						var page struct {
							Total int
							Works []libraryWorkSummary
						}
						if err == nil {
							err = json.Unmarshal(body, &page)
						}
						if response.StatusCode != 200 || page.Total != 400 || len(page.Works) != size {
							err = fmt.Errorf("page contract: status=%d count=%d/%d", response.StatusCode, len(page.Works), page.Total)
						}
						return elapsed, int64(len(body)), err
					}
					for range 3 {
						if _, _, err := request(); err != nil {
							t.Fatal(err)
						}
					}
					runtime.GC()
					var before, after runtime.MemStats
					runtime.ReadMemStats(&before)
					poolBefore := db.Stats()
					var mu sync.Mutex
					var wg sync.WaitGroup
					times := make([]time.Duration, 0, n)
					var bytes int64
					failures := 0
					start := time.Now()
					for worker := range concurrency {
						wg.Go(func() {
							for i := worker; i < n; i += concurrency {
								elapsed, length, err := request()
								mu.Lock()
								times = append(times, elapsed)
								bytes += length
								if err != nil {
									failures++
								}
								mu.Unlock()
							}
						})
					}
					wg.Wait()
					wall := time.Since(start)
					poolAfter := db.Stats()
					runtime.ReadMemStats(&after)
					logBrowseTiming(t, fmt.Sprintf("matrix/%s/size=%d", name, size), times, concurrency, failures)
					t.Logf("resources/%s/size=%d concurrency=%d HTTP=%d bytes/request=%d allocated/request=%d pool-waits=%d pool-wait-total=%.3fms throughput=%.2f/s", name, size, concurrency, n, bytes/int64(n), (after.TotalAlloc-before.TotalAlloc)/uint64(n), poolAfter.WaitCount-poolBefore.WaitCount, float64(poolAfter.WaitDuration-poolBefore.WaitDuration)/float64(time.Millisecond), float64(n)/wall.Seconds())
					if failures != 0 {
						t.Fatalf("%d failed requests", failures)
					}
				}
				measure(24, 1, 60)
				if analyzed && summarized {
					measure(100, 1, 60)
					measure(24, 8, 160)
				}
				options := library.ListOptions{UserID: 1, PageSize: 24, Scope: scope, Sort: "recent", Direction: "desc"}
				page, err := server.libraryStore.ListPage(context.Background(), options)
				if err != nil {
					t.Fatal(err)
				}
				ids := make([]int64, len(page.Works))
				for i, row := range page.Works {
					ids[i] = row.ID
				}
				for _, stage := range []struct {
					name string
					run  func() error
				}{
					{"main-query-with-count", func() error { _, err := server.libraryStore.ListPage(context.Background(), options); return err }},
					{"titles", func() error { _, err := server.loadWorkTitleInputs(context.Background(), ids, false); return err }},
					{"media-selection", func() error { _, err := server.libraryStore.LoadMediaSelections(context.Background(), ids); return err }},
					{"card-and-enrichment", func() error {
						_, err := server.scanLibraryWorkRows(context.Background(), 1, page.Works, true)
						return err
					}},
					{"connection-acquire", func() error {
						conn, err := db.Conn(context.Background())
						if err == nil {
							return conn.Close()
						}
						return err
					}},
				} {
					times := make([]time.Duration, 0, 60)
					for range 60 {
						start := time.Now()
						if err := stage.run(); err != nil {
							t.Fatal(err)
						}
						times = append(times, time.Since(start))
					}
					logBrowseTiming(t, "stage/"+name+"/"+stage.name, times, 1, 0)
				}
			}
			httpServer.Close()
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Log("conditions: origin language, badges off, recent desc page 1, four DB connections, warm OS/SQLite pages and HTTP keep-alive after 3 requests; no background workers/jobs; card summary state explicit; no settled list response cache")
}
