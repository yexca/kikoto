package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestUpdateSourceHealthOnlyWritesSameStatusAfterThrottleWindow(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, base_url, health_status, last_checked_at)
		VALUES (1, 'https://example.invalid', 'healthy', '2026-01-01 00:00:00')
	`); err != nil {
		t.Fatalf("insert endpoint: %v", err)
	}
	server := NewServer(db, config.Config{})
	if err := server.updateSourceHealth(context.Background(), 1, "healthy"); err != nil {
		t.Fatal(err)
	}
	var firstChecked string
	if err := db.QueryRow(`SELECT last_checked_at FROM file_source_endpoint WHERE file_source_id = 1`).Scan(&firstChecked); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE file_source_endpoint SET last_checked_at = '2099-01-02 00:00:00' WHERE file_source_id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := server.updateSourceHealth(context.Background(), 1, "healthy"); err != nil {
		t.Fatal(err)
	}
	var unchanged string
	if err := db.QueryRow(`SELECT last_checked_at FROM file_source_endpoint WHERE file_source_id = 1`).Scan(&unchanged); err != nil {
		t.Fatal(err)
	}
	if unchanged != "2099-01-02 00:00:00" {
		t.Fatalf("same status refreshed too soon: %q", unchanged)
	}
	if err := server.updateSourceHealth(context.Background(), 1, "unavailable"); err != nil {
		t.Fatal(err)
	}
	var status string
	var changedAt sql.NullString
	if err := db.QueryRow(`SELECT health_status, last_checked_at FROM file_source_endpoint WHERE file_source_id = 1`).Scan(&status, &changedAt); err != nil {
		t.Fatal(err)
	}
	if status != "unavailable" || !changedAt.Valid || changedAt.String == unchanged {
		t.Fatalf("transition was not persisted: status=%q checked=%q", status, changedAt.String)
	}
	if firstChecked == "" || firstChecked == "2026-01-01 00:00:00" {
		t.Fatalf("stale same-status check was not refreshed: %q", firstChecked)
	}
}

func TestRemoteWorkSyncForksTrackTree(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workInfo/RJ09999999":
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 10, SourceID: "RJ09999999", Title: "Forked work"})
		case "/api/tracks/10":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: "track.mp3", MediaStreamURL: "/media/track.mp3"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	result, err := server.runRemoteWorkSync(context.Background(), 1, "RJ09999999", "test_fork")
	if err != nil {
		t.Fatal(err)
	}
	if result.SyncedMediaItems != 1 || result.SyncedLocations != 1 {
		t.Fatalf("sync counts = %d items, %d locations", result.SyncedMediaItems, result.SyncedLocations)
	}
	var locations int
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE file_source_id = 1 AND location_type = 'remote_stream' AND availability = 'available'`).Scan(&locations); err != nil {
		t.Fatal(err)
	}
	if locations != 1 {
		t.Fatalf("remote stream locations = %d, want 1", locations)
	}
}

func TestSelectedRemotePathMatches(t *testing.T) {
	tests := []struct {
		name     string
		selected []string
		filePath string
		want     bool
	}{
		{
			name:     "exact file",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "directory prefix",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "sibling directory is not selected",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/wav/01.wav",
			want:     false,
		},
		{
			name:     "same basename in other directory is not selected",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "bonus/mp3/01.mp3",
			want:     false,
		},
		{
			name:     "cleans path traversal",
			selected: []string{"honhen/../mp3"},
			filePath: "mp3/01.mp3",
			want:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			selected := normalizeSelectedRemotePaths(test.selected)
			got := selectedRemotePathMatches(selected, test.filePath)
			if got != test.want {
				t.Fatalf("selectedRemotePathMatches(%v, %q) = %v, want %v", test.selected, test.filePath, got, test.want)
			}
		})
	}
}

func TestRemoteSourceSortMapping(t *testing.T) {
	tests := []struct {
		input string
		name  string
		order string
	}{
		{input: "recent", name: "recent", order: "create_date"},
		{input: "code", name: "code", order: "id"},
		{input: "release", name: "release", order: "release"},
		{input: "rating", name: "rating", order: "rate_average_2dp"},
		{input: "sales", name: "sales", order: "dl_count"},
		{input: "title", name: "recent", order: "create_date"},
	}
	for _, test := range tests {
		name, order := remoteSourceSort(test.input)
		if name != test.name || order != test.order {
			t.Fatalf("remoteSourceSort(%q) = (%q, %q), want (%q, %q)", test.input, name, order, test.name, test.order)
		}
	}
}

func TestRemotePostFilteredPageCollectsMatchesAcrossUpstreamPages(t *testing.T) {
	upstream := make([]kikoeru.Work, 0, 102)
	for index := 1; index <= 102; index++ {
		tags := []kikoeru.Tag{{Name: "Other"}}
		if index == 1 || index == 102 {
			tags = []kikoeru.Tag{{Name: "Wanted"}}
		}
		upstream = append(upstream, kikoeru.Work{
			ID:       int64(index),
			SourceID: fmt.Sprintf("RJ%08d", index),
			Title:    fmt.Sprintf("Work %d", index),
			Tags:     tags,
		})
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		start := (page - 1) * 100
		if start < 0 {
			start = 0
		}
		end := min(start+100, len(upstream))
		works := []kikoeru.Work{}
		if start < len(upstream) {
			works = upstream[start:end]
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{
			Works: works,
			Pagination: kikoeru.Pagination{
				CurrentPage: page,
				PageSize:    100,
				TotalCount:  len(upstream),
			},
		})
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	works, total, sortApplied, err := server.remotePostFilteredPage(
		context.Background(),
		0,
		7,
		kikoeru.NewClient(remote.URL, remote.Client()),
		remoteSourceQueryPlan{PostFilterClauses: []listSearchClause{{Kind: "tag", Value: "wanted"}}},
		"create_date",
		"desc",
		"",
		2,
		1,
		"ja-jp",
	)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(works) != 1 || works[0].PrimaryCode != "RJ00000102" {
		t.Fatalf("works = %+v, total = %d", works, total)
	}
	if !sortApplied {
		t.Fatal("sortApplied = false, want true")
	}
}

func TestRemoteFetchRequestIDValidation(t *testing.T) {
	if !validRemoteFetchRequestID("fetch:12345678") {
		t.Fatal("valid request id was rejected")
	}
	for _, value := range []string{"short", "contains spaces", "../../escape"} {
		if validRemoteFetchRequestID(value) {
			t.Fatalf("invalid request id %q was accepted", value)
		}
	}
}

func TestRemoteFetchRequestResultReturnsExistingRun(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	runInsert, err := db.Exec(`
		INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type)
		VALUES ('remote_work_fetch', 'Fetch remote work', 'queued', 'manual')
	`)
	if err != nil {
		t.Fatalf("insert run: %v", err)
	}
	runID, err := runInsert.LastInsertId()
	if err != nil {
		t.Fatalf("run id: %v", err)
	}
	want := remoteWorkSaveResult{RunID: runID, WorkID: 9, PrimaryCode: "RJ00000001", Status: "queued", RequestID: "fetch:12345678"}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_request (request_id, source_id, work_code, workflow_run_id, result_json)
		VALUES ('fetch:12345678', 1, 'RJ00000001', ?, ?)
	`, runID, string(raw)); err != nil {
		t.Fatalf("insert request: %v", err)
	}

	server := &Server{db: db}
	got, found, err := server.remoteFetchRequestResult(context.Background(), "fetch:12345678", 1, "rj00000001")
	if err != nil {
		t.Fatalf("remoteFetchRequestResult() error = %v", err)
	}
	if !found || got.RunID != runID || !got.Deduplicated {
		t.Fatalf("remoteFetchRequestResult() = %+v, found %v", got, found)
	}
}
