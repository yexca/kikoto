package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Opt-in measurement, not a timing assertion. Uses the packaged migrations,
// production pool, authentication middleware and a real loopback HTTP server.
func TestBrowsePerformance(t *testing.T) {
	if os.Getenv("KIKOTO_BROWSE_PERF") != "1" {
		t.Skip("set KIKOTO_BROWSE_PERF=1 to measure browsing")
	}
	db := openMigratedTestDBWithProductionPool(t)
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	exec := func(query string, args ...any) {
		if _, err := tx.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO user_account(id,username,role) VALUES(1,'synthetic-user','user');
		INSERT INTO file_source(id,code,display_name,source_type) VALUES(1,'example_local','Example Local','local_folder');
		INSERT OR IGNORE INTO metadata_provider(id,code,display_name) VALUES(2,'dlsite','DLsite')`)
	exec(`INSERT INTO user_session(id,user_id,expires_at) VALUES(?,1,'2999-01-01 00:00:00')`, fmt.Sprintf("%x", sha256.Sum256([]byte("synthetic-token"))))
	for i := 0; i < 400; i++ {
		code := testfixture.WorkCodeAt(i)
		exec(`INSERT INTO work(id,primary_code,title) VALUES(?,?,?)`, i+1, code, fmt.Sprintf("Example Work %03d", i))
		exec(`INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES(?,?,?)`, i+1, i+1, code)
		exec(`INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,is_canonical) VALUES(?,?,2,?,1)`, i+1, i+1, code)
		exec(`INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) VALUES(?,2,'example',?)`, i+1, fmt.Sprintf(`{"workno":%q}`, code))
		exec(`INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability,raw_json) VALUES(?,1,'local','available','{"file_tree_scanned":true}')`, i+1)
		for j := 0; j < 20; j++ {
			id := i*20 + j + 1
			exec(`INSERT INTO media_item(id,work_id,kind,title,fingerprint) VALUES(?,?,'audio',?,?)`, id, i+1, fmt.Sprintf("track-%02d.mp3", j), fmt.Sprintf("example:%d", id))
			exec(`INSERT INTO media_file_location(media_item_id,file_source_id,location_type,path,availability) VALUES(?,1,'local',?,'available')`, id, fmt.Sprintf("%s/track-%02d.mp3", code, j))
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{Mode: config.ModeProduction, DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	request := func(path string) (time.Duration, error) {
		req, err := http.NewRequest(http.MethodGet, httpServer.URL+path, nil)
		if err != nil {
			return 0, err
		}
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "synthetic-token"})
		if strings.HasPrefix(path, "/api/media/") {
			req.Header.Set("Range", "bytes=0-4095")
		}
		start := time.Now()
		response, err := client.Do(req)
		if err != nil {
			return time.Since(start), err
		}
		defer func() { _ = response.Body.Close() }()
		_, err = io.Copy(io.Discard, response.Body)
		expectedStatus := http.StatusOK
		if strings.HasPrefix(path, "/api/media/") {
			expectedStatus = http.StatusPartialContent
		}
		if response.StatusCode != expectedStatus {
			err = fmt.Errorf("HTTP %d", response.StatusCode)
		}
		return time.Since(start), err
	}
	measure := func(name, path string, n, concurrency int) {
		for i := 0; i < 3; i++ {
			if _, err := request(path); err != nil {
				t.Fatal(err)
			}
		}
		var mu sync.Mutex
		times := make([]time.Duration, 0, n)
		errors := 0
		var wg sync.WaitGroup
		for worker := 0; worker < concurrency; worker++ {
			wg.Go(func() {
				for i := worker; i < n; i += concurrency {
					elapsed, err := request(path)
					mu.Lock()
					times = append(times, elapsed)
					if err != nil {
						errors++
					}
					mu.Unlock()
				}
			})
		}
		wg.Wait()
		logBrowseTiming(t, name, times, concurrency, errors)
		if errors != 0 {
			t.Errorf("%s: %d failed requests", name, errors)
		}
	}
	path := "/api/works?page=1&pageSize=24&scope=local&sort=recent&direction=desc"
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	server.listWorks(recorder, req)
	var page struct {
		Works []libraryWorkSummary
		Total int
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Works) != 24 || page.Total != 400 {
		t.Fatalf("fixture page: %d/%d, want 24/400", len(page.Works), page.Total)
	}
	selectionProbe := func(state string) {
		var ids []int64
		for i := int64(1); i <= 24; i++ {
			ids = append(ids, i)
		}
		var times []time.Duration
		for range 60 {
			start := time.Now()
			_, err := server.libraryStore.LoadMediaSelections(context.Background(), ids)
			if err != nil {
				t.Fatal(err)
			}
			times = append(times, time.Since(start))
		}
		logBrowseTiming(t, "media-selection/"+state, times, 1, 0)
		rows, err := db.Query(`EXPLAIN QUERY PLAN SELECT 1 FROM media_item AS item JOIN media_file_location AS location ON location.media_item_id=item.id WHERE item.work_id=1 AND location.location_type='local' AND location.availability='available'`)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var id, parent, unused int
			var detail string
			if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
				t.Fatal(err)
			}
			t.Logf("plan/%s: %s", state, detail)
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
	}
	selectionProbe("missing")
	measure("list/statistics-missing", path, 60, 1)
	if err := storage.OptimizeStatistics(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	selectionProbe("refreshed")
	ids := []int64{}
	for i := int64(1); i <= 24; i++ {
		ids = append(ids, i)
	}
	for _, stage := range []struct {
		name string
		run  func() error
	}{
		{"page-query", func() error {
			_, err := server.libraryStore.ListPage(context.Background(), library.ListOptions{UserID: 1, PageSize: 24, Scope: "local", Sort: "recent"})
			return err
		}},
		{"availability", func() error { _, err := server.libraryStore.LoadAvailability(context.Background(), ids); return err }},
		{"titles", func() error { _, err := server.loadWorkTitleInputs(context.Background(), ids, false); return err }},
		{"covers", func() error {
			for i := 0; i < 24; i++ {
				server.coverURL(testfixture.WorkCodeAt(i))
			}
			return nil
		}},
	} {
		var samples []time.Duration
		for range 10 {
			start := time.Now()
			if err := stage.run(); err != nil {
				t.Fatal(err)
			}
			samples = append(samples, time.Since(start))
		}
		logBrowseTiming(t, "stage/"+stage.name, samples, 1, 0)
	}
	measure("list/statistics-refreshed", path, 60, 1)
	measure("list/statistics-refreshed/concurrent", path, 160, 8)
	measure("summary", "/api/works/1?includeMedia=false", 60, 1)
	measure("directory", "/api/works/1/media", 60, 1)
	measure("resolve", "/api/works/RJ00000000/resolve", 60, 1)
	var locked []time.Duration
	for i := 0; i < 60; i++ {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		time.AfterFunc(250*time.Millisecond, func() { _ = tx.Rollback(); close(done) })
		elapsed, err := request("/api/works/RJ00000000/resolve")
		<-done
		if err != nil {
			t.Fatal(err)
		}
		locked = append(locked, elapsed)
	}
	logBrowseTiming(t, "resolve/write-lock-250ms", locked, 1, 0)
	var reads []time.Duration
	for batch := 0; batch < 20; batch++ {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		time.AfterFunc(250*time.Millisecond, func() { _ = tx.Rollback(); close(done) })
		var wg sync.WaitGroup
		failures := make(chan error, 3)
		for worker := 0; worker < 3; worker++ {
			wg.Go(func() {
				_, err := request(fmt.Sprintf("/api/works/1/recommendation?recommendationSession=example-%d-%d", batch, worker))
				failures <- err
			})
		}
		time.Sleep(50 * time.Millisecond)
		elapsed, err := request(path)
		if err != nil {
			t.Fatal(err)
		}
		reads = append(reads, elapsed)
		<-done
		wg.Wait()
		for range 3 {
			if err := <-failures; err != nil {
				t.Fatal(err)
			}
		}
	}
	logBrowseTiming(t, "list/three-cold-recommendations/write-lock-250ms", reads, 4, 0, 4)
	t.Log("cold recommendation scenario: 4 HTTP requests per sample (3 recommendation preparations + 1 measured list)")
	mediaRoot := filepath.Join(server.cfg.DataRoot, testfixture.WorkCodeAt(0))
	if err := os.MkdirAll(mediaRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(mediaRoot, "track.wav"), testWAVBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE media_file_location SET path=? WHERE id=1`, testfixture.WorkCodeAt(0)+"/track.wav"); err != nil {
		t.Fatal(err)
	}
	measure("playback/direct-wav/range-4KiB", "/api/media/1/stream?profile=audio", 60, 1)
	input := createSyntheticAAC(t, "300")
	data, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	input = filepath.Join(mediaRoot, "track.aac")
	if err := os.WriteFile(input, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE media_file_location SET path=? WHERE id=1`, testfixture.WorkCodeAt(0)+"/track.aac"); err != nil {
		t.Fatal(err)
	}
	server.mediaStreamCache = sync.Map{}
	var coldAudio []time.Duration
	for i := 0; i < 12; i++ {
		changed := time.Now().Add(time.Duration(i) * time.Second)
		if err := os.Chtimes(input, changed, changed); err != nil {
			t.Fatal(err)
		}
		elapsed, err := request("/api/media/1/stream?profile=audio&forceDirect=1")
		if err != nil {
			t.Fatal(err)
		}
		coldAudio = append(coldAudio, elapsed)
	}
	logBrowseTiming(t, "playback/300s-aac/cold-compatible/range-4KiB", coldAudio, 1, 0)
	measure("playback/300s-aac/warm-compatible/range-4KiB", "/api/media/1/stream?profile=audio&forceDirect=1", 60, 1)
	var upstreamRequests atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests.Add(1)
		time.Sleep(40 * time.Millisecond)
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		size, _ := strconv.Atoi(r.URL.Query().Get("pageSize"))
		if size <= 0 {
			size = 100
		}
		if page <= 0 {
			page = 1
		}
		works := []kikoeru.Work{}
		for i := (page - 1) * size; i < min(page*size, 400); i++ {
			works = append(works, kikoeru.Work{ID: int64(i + 1), SourceID: testfixture.WorkCodeAt(i), Title: fmt.Sprintf("Example %d", i)})
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: works, Pagination: kikoeru.Pagination{TotalCount: 400}, SortApplied: true})
	}))
	defer upstream.Close()
	if _, err := db.Exec(`INSERT INTO file_source(id,code,display_name,source_type) VALUES(7,'example_remote','Example Remote','kikoeru_compatible');
	 INSERT INTO user_tag(id,user_id,name) VALUES(1,1,'Example');
	 INSERT INTO user_work_tag(user_id,work_id,user_tag_id) SELECT 1,id,1 FROM work`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint(file_source_id,api_url,base_url) VALUES(7,?,?)`, upstream.URL, upstream.URL); err != nil {
		t.Fatal(err)
	}
	measure("remote/plain/40ms-upstream", "/api/remote-sources/7/works?page=1&pageSize=24", 60, 1)
	var remoteFirst, remoteSecond []time.Duration
	var firstCount, secondCount int32
	for i := 0; i < 60; i++ {
		// A distinct recommendation seed keeps each pair cold in both versions.
		remotePath := fmt.Sprintf("/api/remote-sources/7/works?pageSize=24&q=mytag:Example&seed=example-%d", i)
		before := upstreamRequests.Load()
		elapsed, err := request(remotePath + "&page=1")
		if err != nil {
			t.Fatal(err)
		}
		remoteFirst = append(remoteFirst, elapsed)
		firstCount += upstreamRequests.Load() - before
		before = upstreamRequests.Load()
		elapsed, err = request(remotePath + "&page=2")
		if err != nil {
			t.Fatal(err)
		}
		remoteSecond = append(remoteSecond, elapsed)
		secondCount += upstreamRequests.Load() - before
	}
	logBrowseTiming(t, "remote/post-filter/cold-page-1/40ms-upstream", remoteFirst, 1, 0)
	logBrowseTiming(t, "remote/post-filter/page-2/40ms-upstream", remoteSecond, 1, 0)
	t.Logf("remote upstream requests: page1=%d page2=%d across 60 cold pagination pairs", firstCount, secondCount)
}

func logBrowseTiming(t *testing.T, name string, times []time.Duration, concurrency, errors int, requestsPerSample ...int) {
	t.Helper()
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	requests := 1
	if len(requestsPerSample) > 0 {
		requests = requestsPerSample[0]
	}
	t.Logf("%s n=%d concurrency=%d requests/sample=%d errors=%d p50=%.2fms p95=%.2fms", name, len(times), concurrency, requests, errors, float64(times[(len(times)-1)*50/100])/float64(time.Millisecond), float64(times[(len(times)-1)*95/100])/float64(time.Millisecond))
}
