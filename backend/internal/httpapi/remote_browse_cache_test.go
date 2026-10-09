package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRemoteBrowseCacheBoundsExpiryCancellationAndIsolation(t *testing.T) {
	cache := &remoteBrowsePageCache{}
	calls := 0
	load := func() (kikoeru.WorksPage, error) {
		calls++
		return kikoeru.WorksPage{Works: []kikoeru.Work{{SourceID: testfixture.WorkCode(testfixture.PrefixRJ, 0), Title: strings.Repeat("x", 600000)}}, SortApplied: true}, nil
	}
	for i := 0; i < 40; i++ {
		if _, err := cache.page(context.Background(), fmt.Sprint(i), load); err != nil {
			t.Fatal(err)
		}
	}
	if len(cache.entries) > remoteBrowseCacheEntries || cache.bytes > remoteBrowseCacheBytes {
		t.Fatalf("unbounded cache: %d/%d", len(cache.entries), cache.bytes)
	}
	before := calls
	if page, err := cache.page(context.Background(), "39", load); err != nil {
		t.Fatal(err)
	} else if !page.SortApplied {
		t.Fatal("cache lost the upstream sorting contract")
	}
	if calls != before {
		t.Fatal("fresh page was fetched again")
	}
	entry := cache.entries["39"]
	entry.expires = time.Now().Add(-time.Second)
	cache.entries["39"] = entry
	if _, err := cache.page(context.Background(), "39", load); err != nil {
		t.Fatal(err)
	}
	if calls != before+1 {
		t.Fatal("expired page was reused")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.page(ctx, "39", load); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled hit = %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	if _, err := cache.page(ctx, "cancelled-miss", func() (kikoeru.WorksPage, error) {
		cancel()
		return kikoeru.WorksPage{}, nil
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled miss = %v", err)
	}
	if _, retained := cache.entries["cancelled-miss"]; retained {
		t.Fatal("cancelled load populated the cache")
	}
	if _, err := cache.page(context.Background(), "oversized", func() (kikoeru.WorksPage, error) {
		return kikoeru.WorksPage{Works: []kikoeru.Work{{Title: strings.Repeat("x", 2<<20)}}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, retained := cache.entries["oversized"]; retained {
		t.Fatal("oversized page displaced the bounded cache")
	}
	source := remoteSourceForUse{ID: 7, Enabled: true, Endpoint: fileSourceEndpoint{APIURL: "https://source.example.invalid"}}
	request := remoteSourceWorksRequest{Page: 1, Query: "user_tag:example", Languages: []string{"ja-jp"}, Seed: "example-a"}
	key := remoteBrowsePageKey(source, 1, request, 1)
	assertDifferent := func(source remoteSourceForUse, user int64, request remoteSourceWorksRequest, page int) {
		if remoteBrowsePageKey(source, user, request, page) == key {
			t.Fatal("cache scopes overlap")
		}
	}
	assertDifferent(source, 2, request, 1)
	assertDifferent(source, 1, request, 2)
	changed := source
	changed.cacheGeneration++
	assertDifferent(changed, 1, request, 1)
	changed = source
	changed.Endpoint.APIURL = "https://other.example.invalid"
	assertDifferent(changed, 1, request, 1)
	for _, field := range []string{"language", "query", "seed", "sort"} {
		changedRequest := request
		switch field {
		case "language":
			changedRequest.Languages = []string{"en-us"}
		case "query":
			changedRequest.Query = "user_tag:other"
		case "seed":
			changedRequest.Seed = "example-b"
		case "sort":
			changedRequest.UpstreamOrder = "id"
		}
		assertDifferent(source, 1, changedRequest, 1)
	}
}

func TestRemoteFilteredPaginationReusesPagesButReadsCurrentPersonalTags(t *testing.T) {
	requests := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		works := []kikoeru.Work{}
		for i := (page - 1) * 100; i < min(page*100, 102); i++ {
			works = append(works, kikoeru.Work{ID: int64(i + 1), SourceID: testfixture.WorkCodeAt(i), Title: fmt.Sprintf("Example %d", i)})
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: works, Pagination: kikoeru.Pagination{TotalCount: 102}, SortApplied: true})
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	metadataReviewExec(t, db, `INSERT INTO user_account(id,username,role) VALUES(1,'synthetic-user','user');
	 INSERT INTO file_source(id,code,display_name,source_type) VALUES(7,'example_remote','Example Remote','kikoeru_compatible');
	 INSERT INTO work(id,primary_code,title) VALUES(1,'RJ00000000','Example');
	 INSERT INTO user_tag(id,user_id,name) VALUES(1,1,'Wanted');
	 INSERT INTO user_work_tag(user_id,work_id,user_tag_id) VALUES(1,1,1)`)
	if _, err := db.Exec(`INSERT INTO file_source_endpoint(file_source_id,api_url,base_url) VALUES(7,?,?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db, config.Config{})
	browse := func() remoteWorksResponse {
		source, err := s.loadRemoteSourceForUse(context.Background(), 7)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works?q=mytag:Wanted", nil)
		request := newRemoteSourceWorksRequest(r, source.SourceType, []string{"ja-jp"})
		w := httptest.NewRecorder()
		if err := s.serveRemoteSourceWorksPage(w, r, 1, source, "", request); err != nil {
			t.Fatal(err)
		}
		var result remoteWorksResponse
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Status != "ok" {
			t.Fatalf("browse = %s", w.Body.String())
		}
		if !result.SortApplied {
			t.Fatal("cached browse lost upstream sorting")
		}
		return result
	}
	if result := browse(); result.Total != 1 {
		t.Fatalf("initial result = %+v", result)
	}
	if requests != 2 {
		t.Fatalf("initial upstream requests = %d", requests)
	}
	metadataReviewExec(t, db, `DELETE FROM user_work_tag`)
	if result := browse(); result.Total != 0 {
		t.Fatalf("cached personal tag was returned: %+v", result)
	}
	if requests != 2 {
		t.Fatalf("pagination fetched pages again: %d", requests)
	}
	s.invalidateRemoteWorkCache(7)
	browse()
	if requests != 4 {
		t.Fatalf("source invalidation retained pages: %d", requests)
	}
	metadataReviewExec(t, db, `UPDATE file_source SET enabled=0 WHERE id=7`)
	source, err := s.loadRemoteSourceForUse(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	load := s.remoteBrowsePageLoader(context.Background(), 1, source, remoteSourceWorksRequest{}, s.kikoeruClientForSource(context.Background(), source))
	if _, err := load(1); err == nil {
		t.Fatal("disabled source returned a cached page")
	}
}
