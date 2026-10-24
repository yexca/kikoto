package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRemoteBrowseCardsCarryLibraryPresenceAndPersonalTags(t *testing.T) {
	localCode := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	remoteCode := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{
			{ID: 1, SourceID: localCode, Title: "Example Local"},
			{ID: 2, SourceID: remoteCode, Title: "Example Remote"},
		}, Pagination: kikoeru.Pagination{TotalCount: 2}, SortApplied: true})
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	metadataReviewExec(t, db, `INSERT INTO user_account(id,username,role) VALUES(1,'synthetic-user','user');
	 INSERT INTO file_source(id,code,display_name,source_type) VALUES(1,'example_local','Example Local','local_folder');
	 INSERT INTO file_source(id,code,display_name,source_type) VALUES(7,'example_remote','Example Remote','kikoeru_compatible');
	 INSERT INTO work(id,primary_code,title) VALUES(1,'`+localCode+`','Example Local');
	 INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability,raw_json) VALUES(1,1,'local','available','{}');
	 INSERT INTO user_tag(id,user_id,name) VALUES(1,1,'Wanted');
	 INSERT INTO user_work_tag(user_id,work_id,user_tag_id) VALUES(1,1,1)`)
	if _, err := db.Exec(`INSERT INTO file_source_endpoint(file_source_id,api_url,base_url) VALUES(7,?,?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db, config.Config{})
	// A personal-tag query takes the post-filtered path; a plain one reads the upstream page directly.
	for _, query := range []string{"", "?q=mytag:Wanted"} {
		source, err := s.loadRemoteSourceForUse(context.Background(), 7)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works"+query, nil)
		request := newRemoteSourceWorksRequest(r, source.SourceType, []string{"ja-jp"})
		w := httptest.NewRecorder()
		if err := s.serveRemoteSourceWorksPage(w, r, 1, source, "", request); err != nil {
			t.Fatal(err)
		}
		var result struct {
			Status string `json:"status"`
			Works  []struct {
				PrimaryCode    string            `json:"primaryCode"`
				SourcePresence []json.RawMessage `json:"sourcePresence"`
				UserTags       []workUserTag     `json:"userTags"`
			} `json:"works"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if result.Status != "ok" || len(result.Works) == 0 {
			t.Fatalf("browse %q = %s", query, w.Body.String())
		}
		for _, work := range result.Works {
			switch work.PrimaryCode {
			case localCode:
				if len(work.SourcePresence) != 1 || !strings.Contains(string(work.SourcePresence[0]), `"type":"local"`) || !strings.Contains(string(work.SourcePresence[0]), `"availability":"available"`) {
					t.Fatalf("browse %q local presence = %s", query, w.Body.String())
				}
				if len(work.UserTags) != 1 || work.UserTags[0].Name != "Wanted" {
					t.Fatalf("browse %q personal tags = %+v", query, work.UserTags)
				}
			case remoteCode:
				if work.SourcePresence == nil || len(work.SourcePresence) != 0 || work.UserTags == nil || len(work.UserTags) != 0 {
					t.Fatalf("browse %q remote-only card = %s", query, w.Body.String())
				}
			}
		}
	}
}
