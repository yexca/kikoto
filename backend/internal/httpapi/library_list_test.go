package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestListWorksPageClosesOuterRowsBeforeEnrichment(t *testing.T) {
	db := openMigratedTestDB(t)
	workResult, err := db.Exec("INSERT INTO work (primary_code, title, age_rating) VALUES ('RJ09999997', 'Single connection work', 'R18')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	logicalResult, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ09999997')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalWorkID, _ := logicalResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical)
		VALUES (?, ?, 'RJ09999997', 'RJ09999997', 1)
	`, workID, logicalWorkID); err != nil {
		t.Fatal(err)
	}
	sourceResult, err := db.Exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('test-local', 'Test local', 'local')")
	if err != nil {
		t.Fatal(err)
	}
	sourceID, _ := sourceResult.LastInsertId()
	mediaResult, err := db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'audio', 'Track 1', 'single-connection-track')", workID)
	if err != nil {
		t.Fatal(err)
	}
	mediaItemID, _ := mediaResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'local', 'RJ09999997/track.wav', 'available')
	`, mediaItemID, sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability)
		VALUES (?, ?, 'local', 'available')
	`, workID, sourceID); err != nil {
		t.Fatal(err)
	}

	// A single connection makes any query issued while the outer list cursor is
	// still open fail or wait for its context. The list path must fully scan and
	// close that cursor before enriching individual summaries.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	server := NewServer(db, config.Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/works?page=1&pageSize=10&scope=local&status=all&sort=recent&direction=desc", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()

	server.listWorks(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list works status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Works []libraryWorkSummary `json:"works"`
		Total int                  `json:"total"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Total != 1 || len(response.Works) != 1 {
		t.Fatalf("list works response = total %d, rows %d; want 1, 1", response.Total, len(response.Works))
	}
	if response.Works[0].ID != workID || response.Works[0].AvailableLocations != 1 {
		t.Fatalf("unexpected work summary: %#v", response.Works[0])
	}
	if response.Works[0].AgeRating != "R18" {
		t.Fatalf("age rating = %q, want R18", response.Works[0].AgeRating)
	}
}

func TestDemoModeReturnsOnlyAllAgesPermanentlyFreeWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title, age_rating, regular_price, current_price, price_currency, is_permanently_free) VALUES
			(201, 'RJ02000001', 'Eligible demo work', 'general', 0, 0, 'JPY', 1),
			(202, 'RJ02000002', 'Paid work', 'general', 1100, 550, 'JPY', 0),
			(203, 'RJ02000003', 'Adult free work', 'adult', 0, 0, 'JPY', 1)
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DemoMode: true})

	listRequest := httptest.NewRequest(http.MethodGet, "/api/works?page=1&pageSize=10", nil)
	listRecorder := httptest.NewRecorder()
	server.listWorks(listRecorder, listRequest)
	if listRecorder.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listRecorder.Code, listRecorder.Body.String())
	}
	var page struct {
		Works []libraryWorkSummary `json:"works"`
		Total int                  `json:"total"`
	}
	if err := json.Unmarshal(listRecorder.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].ID != 201 {
		t.Fatalf("demo list = total %d works %#v", page.Total, page.Works)
	}

	for workID, wantStatus := range map[string]int{"201": http.StatusOK, "202": http.StatusNotFound, "203": http.StatusNotFound} {
		request := httptest.NewRequest(http.MethodGet, "/api/works/"+workID+"?includeMedia=false", nil)
		request.SetPathValue("id", workID)
		recorder := httptest.NewRecorder()
		server.getWork(recorder, request)
		if recorder.Code != wantStatus {
			t.Fatalf("work %s status = %d, want %d; body = %s", workID, recorder.Code, wantStatus, recorder.Body.String())
		}
	}
}

func TestDemoRemoteSourcePageUsesFilteredUpstreamPagination(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keyword, _ := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/api/search/"))
		wantKeyword := `$age:general$ $-price:1$ $tag:Wanted$ ambient`
		if keyword != wantKeyword {
			t.Errorf("keyword = %q, want %q", keyword, wantKeyword)
		}
		if r.URL.Query().Get("page") != "3" || r.URL.Query().Get("pageSize") != "17" {
			t.Errorf("pagination query = %q", r.URL.RawQuery)
		}
		if r.URL.Query().Get("order") != "dl_count" || r.URL.Query().Get("sort") != "asc" || r.URL.Query().Get("seed") != "42" {
			t.Errorf("sort query = %q", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{
			// Demo trusts the upstream filtered page and does not inspect these fields.
			Works:      []kikoeru.Work{{ID: 11, SourceID: "RJ02000011", Title: "Filtered remote work"}},
			Pagination: kikoeru.Pagination{CurrentPage: 3, PageSize: 17, TotalCount: 57},
		})
	}))
	defer remote.Close()

	server := NewServer(openMigratedTestDB(t), config.Config{DemoMode: true})
	works, total, sortApplied, err := server.demoRemoteSourcePage(
		context.Background(), 0, 1, kikoeru.NewClient(remote.URL, remote.Client()), sourceTypeKikoeruCompatible,
		`ambient $tag:Wanted$`, "dl_count", "asc", "42", 3, 17, "ja-jp", false,
	)
	if err != nil {
		t.Fatal(err)
	}
	if total != 57 || len(works) != 1 || works[0].RemoteCode != "RJ02000011" || !sortApplied {
		t.Fatalf("demo remote page = total %d works %#v sortApplied %t", total, works, sortApplied)
	}
}

func TestDemoRemoteWorkAccessUsesFilteredExactCodeSearch(t *testing.T) {
	paid := int64(900)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		keyword, _ := url.PathUnescape(strings.TrimPrefix(r.URL.EscapedPath(), "/api/search/"))
		if keyword != `$age:general$ $-price:1$ RJ02000011` {
			t.Errorf("keyword = %q", keyword)
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{
			{ID: 10, SourceID: "RJ02000010"},
			// Search membership is authoritative; response fields are presentation data.
			{ID: 11, SourceID: "RJ02000011", AgeCategoryString: "adult", Price: &paid},
		}})
	}))
	defer remote.Close()

	server := NewServer(openMigratedTestDB(t), config.Config{DemoMode: true})
	work, _, err := server.resolveRemoteWorkForAccess(context.Background(), kikoeru.NewClient(remote.URL, remote.Client()), "rj02000011")
	if err != nil {
		t.Fatal(err)
	}
	if work.ID != 11 {
		t.Fatalf("resolved work = %#v, want exact filtered match", work)
	}
}

func TestListWorksSearchesLanguageFamilyAliasesAndReturnsOrigin(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(101, 'RJ01000011', 'Origin title'),
			(102, 'RJ01000012', 'Translated searchable title');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (101, 101, 'RJ01000011');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, edition_label, is_canonical) VALUES
			(101, 101, 'RJ01000011', 'RJ01000011', 'JPN', 'Japanese', 1),
			(102, 101, 'RJ01000012', 'RJ01000011', 'CHI_HANS', 'Simplified Chinese', 0);
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (101, 'test-local-family', 'Test local family', 'local');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (102, 101, 'local', 'available');
	`); err != nil {
		t.Fatal(err)
	}

	for _, query := range []string{"RJ01000012", "Translated searchable", `$lang:CHI_HANS$`} {
		request := httptest.NewRequest(http.MethodGet, "/api/works?page=1&pageSize=10&scope=local&status=all&q="+url.QueryEscape(query), nil)
		recorder := httptest.NewRecorder()
		server.listWorks(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("query %q status = %d, body = %s", query, recorder.Code, recorder.Body.String())
		}
		var response struct {
			Works []libraryWorkSummary `json:"works"`
			Total int                  `json:"total"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Total != 1 || len(response.Works) != 1 || response.Works[0].PrimaryCode != "RJ01000011" {
			t.Fatalf("query %q response = total %d works %#v, want the origin only", query, response.Total, response.Works)
		}
	}
}
