package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// remoteFoldFamily declares one work family: the origin edition, a Simplified
// Chinese edition persisted as a local work, and an English edition the
// library knows only as a provider-declared alias.
var remoteFoldFamily = []kikoeru.LanguageEdition{
	{WorkNo: testfixture.WorkCodeAt(0), Language: "JPN", Label: "Japanese", DisplayOrder: 1},
	{WorkNo: testfixture.WorkCodeAt(1), Language: "CHI_HANS", Label: "Simplified Chinese", DisplayOrder: 2},
	{WorkNo: testfixture.WorkCodeAt(2), Language: "ENG", Label: "English", DisplayOrder: 3},
}

func remoteFoldEntry(id int64, code, title string) kikoeru.Work {
	return kikoeru.Work{
		ID: id, SourceID: code, Title: title, OriginalWorkNumber: testfixture.WorkCodeAt(0),
		LanguageEditions: remoteFoldFamily,
	}
}

func seedRemoteFoldFamily(t *testing.T, db *sql.DB) {
	t.Helper()
	metadataReviewExec(t, db, fmt.Sprintf(`INSERT INTO work(id,primary_code,title) VALUES(1,%[1]q,'Origin'),(2,%[2]q,'Chinese');
	 INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES(1,1,%[1]q);
	 INSERT INTO work_edition(work_id,logical_work_id,provider_id,primary_code,is_canonical) VALUES
	  (1,1,(SELECT id FROM metadata_provider WHERE code='dlsite'),%[1]q,1),
	  (2,1,(SELECT id FROM metadata_provider WHERE code='dlsite'),%[2]q,0);
	 INSERT INTO work_code_alias(logical_work_id,provider_id,primary_code,relationship_kind)
	  VALUES(1,(SELECT id FROM metadata_provider WHERE code='dlsite'),%[3]q,'provider_declared')`,
		testfixture.WorkCodeAt(0), testfixture.WorkCodeAt(1), testfixture.WorkCodeAt(2)))
}

func TestRemoteBrowseFoldsKnownFamilyIntoOneCardListingEveryEdition(t *testing.T) {
	upstream := []kikoeru.Work{
		remoteFoldEntry(10, testfixture.WorkCodeAt(0), "Origin title"),
		remoteFoldEntry(11, testfixture.WorkCodeAt(1), "Chinese title"),
		remoteFoldEntry(12, testfixture.WorkCodeAt(2), "English title"),
		{ID: 13, SourceID: testfixture.WorkCodeAt(3), Title: "Unrelated title"},
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: upstream, Pagination: kikoeru.Pagination{TotalCount: len(upstream)}})
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	metadataReviewExec(t, db, `INSERT INTO file_source(id,code,display_name,source_type) VALUES(7,'example_remote','Example Remote','kikoeru_compatible')`)
	if _, err := db.Exec(`INSERT INTO file_source_endpoint(file_source_id,api_url,base_url) VALUES(7,?,?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	seedRemoteFoldFamily(t, db)
	s := NewServer(db, config.Config{})
	browse := func(t *testing.T, query string, languages []string) remoteWorksResponse {
		t.Helper()
		source, err := s.loadRemoteSourceForUse(context.Background(), 7)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works?q="+url.QueryEscape(query), nil)
		w := httptest.NewRecorder()
		if err := s.serveRemoteSourceWorksPage(w, r, 0, source, "", newRemoteSourceWorksRequest(r, source.SourceType, languages)); err != nil {
			t.Fatal(err)
		}
		var result remoteWorksResponse
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Status != "ok" || len(result.Works) != 2 || result.Total != 2 {
			t.Fatalf("browse = %s, want two cards counted as two", w.Body.String())
		}
		return result
	}
	for _, test := range []struct {
		name      string
		query     string
		languages []string
		presented int
	}{
		{name: "searched edition", query: testfixture.WorkCodeAt(1), languages: []string{"en-us", "ja-jp"}, presented: 1},
		{name: "viewer language", languages: []string{"en-us", "ja-jp"}, presented: 2},
		{name: "canonical edition", languages: []string{"ko-kr"}, presented: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			family := browse(t, test.query, test.languages).Works[0]
			presented := upstream[test.presented]
			if family.PrimaryCode != testfixture.WorkCodeAt(0) || family.RemoteCode != presented.SourceID ||
				family.RemoteID != fmt.Sprint(presented.ID) || family.Title != presented.Title {
				t.Fatalf("card = %+v, want family %s presenting %s", family, testfixture.WorkCodeAt(0), presented.SourceID)
			}
			if family.WorkID == nil || *family.WorkID != 1 {
				t.Fatalf("card work = %v, want the family's canonical work", family.WorkID)
			}
			want := []remoteWorkEdition{
				{RemoteID: "10", RemoteCode: testfixture.WorkCodeAt(0), Title: "Origin title", Language: "ja-jp", Label: "Japanese", Origin: true},
				{RemoteID: "11", RemoteCode: testfixture.WorkCodeAt(1), Title: "Chinese title", Language: "zh-cn", Label: "Simplified Chinese"},
				{RemoteID: "12", RemoteCode: testfixture.WorkCodeAt(2), Title: "English title", Language: "en-us", Label: "English"},
			}
			if fmt.Sprint(family.Editions) != fmt.Sprint(want) {
				t.Fatalf("editions = %+v, want %+v", family.Editions, want)
			}
		})
	}
	unrelated := browse(t, "", []string{"ja-jp"}).Works[1]
	if unrelated.PrimaryCode != testfixture.WorkCodeAt(3) || len(unrelated.Editions) != 1 {
		t.Fatalf("unknown family card = %+v, want its own card", unrelated)
	}
}

func TestRemotePostFilteredPageFoldsFamilyAcrossUpstreamPages(t *testing.T) {
	wanted := []kikoeru.Tag{{Name: "Wanted"}}
	pages := [][]kikoeru.Work{{}, {}}
	for index := 0; index < 99; index++ {
		pages[0] = append(pages[0], kikoeru.Work{ID: int64(100 + index), SourceID: testfixture.WorkCodeAt(10 + index), Tags: []kikoeru.Tag{{Name: "Other"}}})
	}
	origin := remoteFoldEntry(10, testfixture.WorkCodeAt(0), "Origin title")
	origin.Tags = wanted
	translation := remoteFoldEntry(11, testfixture.WorkCodeAt(1), "Chinese title")
	translation.Tags = wanted
	pages[0] = append(pages[0], origin)
	pages[1] = append(pages[1], translation)
	db := openMigratedTestDB(t)
	seedRemoteFoldFamily(t, db)
	s := NewServer(db, config.Config{})
	plan := remoteSourceQueryPlan{PostFilterClauses: []listSearchClause{{Kind: "tag", Value: "wanted"}}, FocusCodes: []string{testfixture.WorkCodeAt(1)}}
	works, total, _, err := s.remotePostFilteredPageUsing(context.Background(), 0, 7, plan, 1, 24, []string{"ja-jp"}, func(page int) (kikoeru.WorksPage, error) {
		return kikoeru.WorksPage{Works: pages[page-1], Pagination: kikoeru.Pagination{TotalCount: 100 + len(pages[1])}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(works) != 1 || len(works[0].Editions) != 2 {
		t.Fatalf("works = %+v, total = %d, want one card holding both pages' editions", works, total)
	}
	if works[0].RemoteCode != testfixture.WorkCodeAt(1) || works[0].Title != "Chinese title" {
		t.Fatalf("card = %+v, want the searched edition presented", works[0])
	}
}

func TestRemotePostFilterMatchesAnyFoldedEditionCode(t *testing.T) {
	work := remoteWorkSummary{
		PrimaryCode: testfixture.WorkCodeAt(0), RemoteCode: testfixture.WorkCodeAt(0), RemoteID: "10",
		Editions: []remoteWorkEdition{
			{RemoteID: "10", RemoteCode: testfixture.WorkCodeAt(0)},
			{RemoteID: "12", RemoteCode: testfixture.WorkCodeAt(2), Title: "English title"},
		},
	}
	for _, clause := range []listSearchClause{
		{Kind: "code", Value: testfixture.WorkCodeAt(2)},
		{Kind: "text", Value: "english title"},
	} {
		if !remoteWorkSummaryMatchesClause(work, clause) {
			t.Fatalf("clause %#v did not match a folded edition of %#v", clause, work)
		}
	}
}

func TestRemoteFoldedPageTotalKeepsUpstreamCountWhenMorePagesExist(t *testing.T) {
	works := make([]kikoeru.Work, 24)
	for _, test := range []struct {
		name  string
		page  kikoeru.WorksPage
		index int
		want  int
	}{
		{name: "single page", page: kikoeru.WorksPage{Works: works[:3], Pagination: kikoeru.Pagination{TotalCount: 3}}, index: 1, want: 2},
		{name: "unknown total on a short page", page: kikoeru.WorksPage{Works: works[:3]}, index: 1, want: 2},
		{name: "more pages", page: kikoeru.WorksPage{Works: works, Pagination: kikoeru.Pagination{TotalCount: 30}}, index: 1, want: 30},
		{name: "later page", page: kikoeru.WorksPage{Works: works[:6], Pagination: kikoeru.Pagination{TotalCount: 30}}, index: 2, want: 30},
	} {
		if got := remoteFoldedPageTotal(test.page, test.index, 24, 2); got != test.want {
			t.Fatalf("%s: total = %d, want %d", test.name, got, test.want)
		}
	}
}
