package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Mirror the production client's dependency graph against real authenticated
// handlers. The browser experiment separately measures rendering built assets.
func TestWorkCodeHTTPPerformance(t *testing.T) {
	if os.Getenv("KIKOTO_BROWSE_PERF") != "1" {
		t.Skip("opt-in performance experiment")
	}
	db := openMigratedTestDBWithProductionPool(t)
	testfixture.SeedBrowse(t, db)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	for {
		n, err := server.backfillSnapshotCardSummaries(context.Background(), 200)
		if err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			break
		}
	}
	if err := storage.OptimizeStatistics(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	var delay time.Duration
	routes := server.Routes()
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(delay); routes.ServeHTTP(w, r) }))
	defer host.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	get := func(path string) (int, int, error) {
		request, err := http.NewRequest(http.MethodGet, host.URL+path, nil)
		if err != nil {
			return 0, 0, err
		}
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "synthetic-token"})
		response, err := client.Do(request)
		if err != nil {
			return 0, 0, err
		}
		defer func() { _ = response.Body.Close() }()
		body, err := io.ReadAll(response.Body)
		if err != nil {
			return response.StatusCode, len(body), err
		}
		if response.StatusCode == 200 {
			var result struct{ ID, WorkID int64 }
			if err := json.Unmarshal(body, &result); err != nil {
				return response.StatusCode, len(body), err
			}
			if result.ID != 1 && result.WorkID != 1 {
				return response.StatusCode, len(body), fmt.Errorf("wrong identity")
			}
		}
		return response.StatusCode, len(body), nil
	}
	status, _, err := get("/api/works/RJ00000000?includeMedia=false")
	if err != nil {
		t.Fatal(err)
	}
	if status != 200 && status != 400 {
		t.Fatalf("code read support probe returned unexpected HTTP %d", status)
	}
	byCode := status == 200
	for _, latency := range []time.Duration{0, 200 * time.Millisecond} {
		delay = latency
		var samples []time.Duration
		var totalBytes int
		for i := range 63 {
			start := time.Now()
			bytes := 0
			if !byCode {
				status, size, err := get("/api/works/RJ00000000/resolve")
				if err != nil || status != 200 {
					t.Fatalf("resolve: %d %v", status, err)
				}
				bytes += size
			}
			id := "1"
			if byCode {
				id = "RJ00000000"
			}
			var wg sync.WaitGroup
			var mu sync.Mutex
			var failure error
			for _, path := range []string{"/api/works/" + id + "?includeMedia=false", "/api/works/" + id + "/media"} {
				wg.Go(func() {
					status, size, err := get(path)
					mu.Lock()
					defer mu.Unlock()
					bytes += size
					if err != nil {
						failure = err
					} else if status != 200 {
						failure = fmt.Errorf("HTTP %d", status)
					}
				})
			}
			wg.Wait()
			if failure != nil {
				t.Fatal(failure)
			}
			if i >= 3 {
				samples = append(samples, time.Since(start))
				totalBytes += bytes
			}
		}
		requests := 3
		if byCode {
			requests = 2
		}
		logBrowseTiming(t, fmt.Sprintf("direct-code/real-api/code-reads=%t/delay=%dms", byCode, latency/time.Millisecond), samples, 1, 0, requests)
		t.Logf("direct-code resources: requests/operation=%d bytes/operation=%d; origin language, summary populated, statistics refreshed, no workers, warm keep-alive, four DB connections", requests, totalBytes/len(samples))
	}
}
