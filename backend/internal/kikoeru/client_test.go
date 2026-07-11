package kikoeru

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestWorkCodeFallsBackToOriginalWorkID(t *testing.T) {
	work := Work{OriginalWorkID: 12345}

	if got := WorkCode(work); got != "RJ00012345" {
		t.Fatalf("WorkCode() = %q, want RJ00012345", got)
	}
}

func TestReadLimitedJSONBodyRejectsOversizedResponse(t *testing.T) {
	if _, err := readLimitedJSONBody(endlessTestReader{}); err == nil {
		t.Fatal("readLimitedJSONBody() accepted an oversized response")
	}
}

type endlessTestReader struct{}

func (endlessTestReader) Read(buffer []byte) (int, error) {
	for index := range buffer {
		buffer[index] = 'x'
	}
	return len(buffer), nil
}

func TestListWorksFallsBackToLocalFilterWhenSearchFails(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/search/RJ00000002":
			http.Error(w, "search unavailable", http.StatusInternalServerError)
		case "/api/works":
			writeTestJSON(t, w, WorksPage{
				Works: []Work{
					{Title: "first", SourceID: "RJ00000001"},
					{Title: "second", OriginalWorkID: 2},
				},
				Pagination: Pagination{Page: 1, PageSize: 20, TotalCount: 2},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewNumber178Client(server.URL, server.Client())
	page, err := client.ListWorks(context.Background(), 1, 20, "RJ00000002")
	if err != nil {
		t.Fatalf("ListWorks() error = %v", err)
	}
	if len(page.Works) != 1 {
		t.Fatalf("len(page.Works) = %d, want 1", len(page.Works))
	}
	if got := WorkCode(page.Works[0]); got != "RJ00000002" {
		t.Fatalf("filtered work code = %q, want RJ00000002", got)
	}
}

func TestListWorksDoesNotFallbackWithoutCompatibilityMode(t *testing.T) {
	server := newSortRejectingWorksServer(t)
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if _, err := client.ListWorks(context.Background(), 1, 12, ""); err == nil {
		t.Fatal("ListWorks() error = nil, want error")
	}
}

func TestListWorksFallsBackWithoutSortParamsForNumber178(t *testing.T) {
	server := newSortRejectingWorksServer(t)
	defer server.Close()

	client := NewNumber178Client(server.URL, server.Client())
	page, err := client.ListWorks(context.Background(), 1, 12, "")
	if err != nil {
		t.Fatalf("ListWorks() error = %v", err)
	}
	if len(page.Works) != 1 {
		t.Fatalf("len(page.Works) = %d, want 1", len(page.Works))
	}
}

func TestListWorksSortedForwardsOrderAndDirection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("order"); got != "dl_count" {
			t.Fatalf("order = %q, want dl_count", got)
		}
		if got := r.URL.Query().Get("sort"); got != "asc" {
			t.Fatalf("sort = %q, want asc", got)
		}
		writeTestJSON(t, w, WorksPage{Works: []Work{{SourceID: "RJ00000001"}}})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	if _, err := client.ListWorksSorted(context.Background(), 1, 12, "", "dl_count", "asc"); err != nil {
		t.Fatalf("ListWorksSorted() error = %v", err)
	}
}

func TestListWorksSortedSeededForwardsGenericRandomParameters(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("order"); got != "random" {
			t.Fatalf("order = %q, want random", got)
		}
		if got := r.URL.Query().Get("seed"); got != "2468" {
			t.Fatalf("seed = %q, want 2468", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"works":[],"pagination":{"totalCount":0}}`))
	}))
	defer server.Close()
	client := NewClient(server.URL, server.Client())
	if _, err := client.ListWorksSortedSeeded(context.Background(), 1, 12, "", "random", "desc", "2468"); err != nil {
		t.Fatalf("ListWorksSortedSeeded() error = %v", err)
	}
}

func TestTagNamePrefersRequestedLocalization(t *testing.T) {
	tag := Tag{
		Name: "中文",
		I18n: map[string]LocalizedTag{
			"ja-jp": {Name: "日本語"},
		},
	}
	if got := TagName(tag, "ja_JP"); got != "日本語" {
		t.Fatalf("TagName() = %q, want 日本語", got)
	}
	if got := TagName(tag, "fr-fr"); got != "中文" {
		t.Fatalf("TagName() fallback = %q, want 中文", got)
	}
}

func TestPopularWorksPostsRecommenderRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/recommender/popular" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		var payload struct {
			Page     int `json:"page"`
			PageSize int `json:"pageSize"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload.Page != 1 || payload.PageSize != 100 {
			t.Fatalf("payload = %+v, want page 1 pageSize 100", payload)
		}
		writeTestJSON(t, w, WorksPage{
			Works:      []Work{{Title: "popular", SourceID: "RJ00000001"}},
			Pagination: Pagination{Page: 1, PageSize: 100, TotalCount: 100},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	page, err := client.PopularWorks(context.Background(), 1, 100)
	if err != nil {
		t.Fatalf("PopularWorks() error = %v", err)
	}
	if len(page.Works) != 1 || WorkCode(page.Works[0]) != "RJ00000001" {
		t.Fatalf("works = %+v", page.Works)
	}
}

func newSortRejectingWorksServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/works" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Get("order") != "" || r.URL.Query().Get("sort") != "" {
			http.Error(w, "invalid sort", http.StatusBadRequest)
			return
		}
		writeTestJSON(t, w, WorksPage{
			Works:      []Work{{Title: "second", OriginalWorkID: 2}},
			Pagination: Pagination{Page: 1, PageSize: 12, TotalCount: 1},
		})
	}))
	return server
}

func TestTracksNormalizesRelativeURLs(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tracks/10" || r.URL.Query().Get("v") != "2" {
			http.NotFound(w, r)
			return
		}
		writeTestJSON(t, w, []Track{
			{
				Title:          "root",
				MediaStreamURL: "/media/root.mp3",
				Children: []Track{
					{Title: "child", MediaDownloadURL: "download/child.mp3"},
				},
			},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, server.Client())
	tracks, _, err := client.Tracks(context.Background(), 10)
	if err != nil {
		t.Fatalf("Tracks() error = %v", err)
	}
	if got := tracks[0].MediaStreamURL; got != server.URL+"/media/root.mp3" {
		t.Fatalf("root stream URL = %q, want absolute URL", got)
	}
	if got := tracks[0].Children[0].MediaDownloadURL; got != server.URL+"/download/child.mp3" {
		t.Fatalf("child download URL = %q, want absolute URL", got)
	}
}

func writeTestJSON(t *testing.T, w http.ResponseWriter, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Fatalf("encode response: %v", err)
	}
}
