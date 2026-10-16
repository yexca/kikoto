package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/personal"
)

var smartListUser = currentUser{ID: 1, Permissions: []string{"library:read", "favorites:write"}}

// openSmartListTestServer seeds works 1–6 with metadata and personal tags.
// Work 6 is a non-canonical edition of work 5 and carries Example Tag A.
func openSmartListTestServer(t *testing.T) (*Server, *sql.DB) {
	t.Helper()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES
			(1, 'synthetic-user', 'Synthetic User', 'user'),
			(2, 'synthetic-other', 'Synthetic Other', 'user');
		INSERT INTO work (id, primary_code, title, created_at) VALUES
			(1, 'RJ00000001', 'Example Work 1', '2026-01-01 00:00:01'),
			(2, 'RJ00000002', 'Example Work 2', '2026-01-01 00:00:02'),
			(3, 'RJ00000003', 'Example Work 3', '2026-01-01 00:00:03'),
			(4, 'RJ00000004', 'Example Work 4', '2026-01-01 00:00:04'),
			(5, 'RJ00000005', 'Example Work 5', '2026-01-01 00:00:05'),
			(6, 'RJ00000006', 'Example Work 6', '2026-01-01 00:00:06');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 5, 'RJ00000005');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical) VALUES
			(5, 1, 'RJ00000005', 'RJ00000005', 'JPN', 1),
			(6, 1, 'RJ00000006', 'RJ00000005', 'CHI_HANS', 0);
		INSERT INTO tag (id, namespace, normalized_name, display_name) VALUES
			(101, 'metadata', 'custom:example-a', 'Example Tag A'),
			(102, 'metadata', 'custom:example-b', 'Example Tag B'),
			(103, 'metadata', 'custom:example-a-old', 'Example Tag A Old'),
			(104, 'metadata', 'custom:example-hidden', 'Example Hidden Tag');
		INSERT INTO metadata_tag (tag_id, merged_into_tag_id, hidden) VALUES
			(101, NULL, 0),
			(102, NULL, 0),
			(103, 101, 0),
			(104, NULL, 1);
		INSERT INTO work_tag (work_id, tag_id, source) VALUES
			(1, 101, 'manual'),
			(2, 101, 'manual'),
			(2, 102, 'manual'),
			(3, 102, 'manual'),
			(6, 101, 'manual');
		INSERT INTO user_tag (id, user_id, name) VALUES
			(7, 1, 'Sleep'),
			(8, 1, 'Calm'),
			(9, 2, 'Other');
		INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (1, 3, 7);
	`); err != nil {
		t.Fatal(err)
	}
	return NewServer(db, config.Config{}), db
}

func callSmartListHandler(t *testing.T, handler http.HandlerFunc, method, target, body string, user currentUser) (int, string) {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	segments := strings.Split(strings.Trim(strings.SplitN(target, "?", 2)[0], "/"), "/")
	for _, segment := range segments {
		if _, err := strconv.ParseInt(segment, 10, 64); err == nil {
			request.SetPathValue("id", segment)
			break
		}
	}
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response := httptest.NewRecorder()
	handler(response, request)
	return response.Code, response.Body.String()
}

func createSmartList(t *testing.T, server *Server, name, rule string) favoriteListResponse {
	t.Helper()
	code, body := callSmartListHandler(t, server.createFavoriteList, http.MethodPost, "/api/favorite-lists", `{"name":"`+name+`","kind":"smart","rule":`+rule+`}`, smartListUser)
	if code != http.StatusCreated {
		t.Fatalf("create smart list status = %d, body = %s", code, body)
	}
	var list favoriteListResponse
	if err := json.Unmarshal([]byte(body), &list); err != nil {
		t.Fatal(err)
	}
	return list
}

type smartListPage struct {
	Works      []libraryWorkSummary `json:"works"`
	Total      int                  `json:"total"`
	ShelfTotal int                  `json:"shelfTotal"`
	ListCounts map[string]int       `json:"listCounts"`
	NewCounts  map[string]int       `json:"newCounts"`
	NewWorkIDs []int64              `json:"newWorkIds"`
}

func requestSmartListPage(t *testing.T, server *Server, query string) smartListPage {
	t.Helper()
	if !strings.Contains(query, "sort=") {
		query += "&sort=code&direction=asc"
	}
	code, body := callSmartListHandler(t, server.listFavoriteWorks, http.MethodGet, "/api/favorite-works?pageSize=50&"+query, "", smartListUser)
	if code != http.StatusOK {
		t.Fatalf("list favorite works status = %d, body = %s", code, body)
	}
	var page smartListPage
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func pageCodes(page smartListPage) []string {
	codes := []string{}
	for _, work := range page.Works {
		codes = append(codes, work.PrimaryCode)
	}
	return codes
}

func workFavoriteFlag(t *testing.T, db *sql.DB, workID int64) bool {
	t.Helper()
	var favorite bool
	err := db.QueryRow("SELECT COALESCE((SELECT favorite FROM user_work_state WHERE user_id = 1 AND work_id = ?), 0)", workID).Scan(&favorite)
	if err != nil {
		t.Fatal(err)
	}
	return favorite
}

func changeSmartListMembership(t *testing.T, server *Server, body string) {
	t.Helper()
	code, response := callSmartListHandler(t, server.updateFavoriteListMembership, http.MethodPost, "/api/favorite-lists/membership", body, smartListUser)
	if code != http.StatusOK {
		t.Fatalf("membership status = %d, body = %s", code, response)
	}
}

func TestSmartListShowsRuleMatchesAndHandEditsWithoutFavoritingMatches(t *testing.T) {
	server, db := openSmartListTestServer(t)
	list := createSmartList(t, server, "Example Smart", `{"includeMatch":"all","include":[{"kind":"metadata","id":101}],"exclude":[{"kind":"metadata","id":102}]}`)
	listQuery := "listId=" + strconv.FormatInt(list.ID, 10)
	listKey := strconv.FormatInt(list.ID, 10)

	page := requestSmartListPage(t, server, listQuery)
	if got := pageCodes(page); !slices.Equal(got, []string{"RJ00000001", "RJ00000005"}) {
		t.Fatalf("rule matches = %v, want the direct match and the canonical edition of a tagged family", got)
	}
	if page.ListCounts[listKey] != 2 || len(page.NewCounts) != 0 || page.ShelfTotal != 0 {
		t.Fatalf("counts = list %v new %v shelf %d", page.ListCounts, page.NewCounts, page.ShelfTotal)
	}
	if workFavoriteFlag(t, db, 1) || workFavoriteFlag(t, db, 5) {
		t.Fatal("a rule match became a favorite")
	}

	changeSmartListMembership(t, server, `{"workIds":[3],"addListIds":[`+listKey+`]}`)
	changeSmartListMembership(t, server, `{"workIds":[1],"removeListIds":[`+listKey+`]}`)
	page = requestSmartListPage(t, server, listQuery)
	if got := pageCodes(page); !slices.Equal(got, []string{"RJ00000003", "RJ00000005"}) {
		t.Fatalf("after hand edits = %v", got)
	}
	if !workFavoriteFlag(t, db, 3) || workFavoriteFlag(t, db, 1) {
		t.Fatal("only the work added by hand is a favorite")
	}
	if page.ShelfTotal != 1 {
		t.Fatalf("shelf total = %d, want the hand-added work only", page.ShelfTotal)
	}

	changeSmartListMembership(t, server, `{"workIds":[1],"addListIds":[`+listKey+`]}`)
	page = requestSmartListPage(t, server, listQuery)
	if got := pageCodes(page); !slices.Equal(got, []string{"RJ00000001", "RJ00000003", "RJ00000005"}) {
		t.Fatalf("after restoring a removed match = %v", got)
	}
	if workFavoriteFlag(t, db, 1) {
		t.Fatal("restoring a removed rule match made it a favorite")
	}

	code, body := callSmartListHandler(t, server.getWorkFavoriteLists, http.MethodGet, "/api/works/5/favorite-lists", "", smartListUser)
	if code != http.StatusOK {
		t.Fatalf("work lists status = %d, body = %s", code, body)
	}
	var lists []favoriteListResponse
	if err := json.Unmarshal([]byte(body), &lists); err != nil {
		t.Fatal(err)
	}
	index := slices.IndexFunc(lists, func(item favoriteListResponse) bool { return item.ID == list.ID })
	if index < 0 || !lists[index].Selected || !lists[index].MatchedByRule || lists[index].Rule == nil || lists[index].Rule.Include[0].Name != "Example Tag A" {
		t.Fatalf("work lists = %#v", lists)
	}
	code, body = callSmartListHandler(t, server.getWorkFavoriteLists, http.MethodGet, "/api/works/3/favorite-lists", "", smartListUser)
	if code != http.StatusOK {
		t.Fatalf("hand-added work lists status = %d, body = %s", code, body)
	}
	lists = nil
	if err := json.Unmarshal([]byte(body), &lists); err != nil {
		t.Fatal(err)
	}
	index = slices.IndexFunc(lists, func(item favoriteListResponse) bool { return item.ID == list.ID })
	if index < 0 || !lists[index].Selected || lists[index].MatchedByRule {
		t.Fatalf("a hand-added work reports a rule match: %#v", lists)
	}

	code, body = callSmartListHandler(t, server.setWorkFavoriteLists, http.MethodPut, "/api/works/5/favorite-lists", `{"listIds":[]}`, smartListUser)
	if code != http.StatusOK || !strings.Contains(body, `"favorite":false`) {
		t.Fatalf("clear work lists status = %d, body = %s", code, body)
	}
	if got := pageCodes(requestSmartListPage(t, server, listQuery)); slices.Contains(got, "RJ00000005") {
		t.Fatalf("a rule match cleared through the work's lists stays shown: %v", got)
	}
}

func TestSmartListReportsNewMatchesUntilSeen(t *testing.T) {
	server, db := openSmartListTestServer(t)
	list := createSmartList(t, server, "Example Sleep", `{"include":[{"kind":"user","id":7}]}`)
	listQuery := "listId=" + strconv.FormatInt(list.ID, 10)
	listKey := strconv.FormatInt(list.ID, 10)

	if page := requestSmartListPage(t, server, listQuery); len(page.NewCounts) != 0 || len(page.NewWorkIDs) != 0 || page.Total != 1 {
		t.Fatalf("a new rule reports existing matches as new: %#v", page)
	}
	if _, err := db.Exec("INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (1, 4, 7)"); err != nil {
		t.Fatal(err)
	}
	page := requestSmartListPage(t, server, listQuery)
	if page.NewCounts[listKey] != 1 || !slices.Equal(page.NewWorkIDs, []int64{4}) {
		t.Fatalf("new counts = %v, new ids = %v", page.NewCounts, page.NewWorkIDs)
	}
	if newOnly := requestSmartListPage(t, server, listQuery+"&new=true"); !slices.Equal(pageCodes(newOnly), []string{"RJ00000004"}) {
		t.Fatalf("new-only page = %v", pageCodes(newOnly))
	}
	added := requestSmartListPage(t, server, listQuery+"&sort=added&direction=desc")
	if len(added.Works) == 0 || added.Works[0].PrimaryCode != "RJ00000004" {
		t.Fatalf("added sort = %v, want the unseen match first", pageCodes(added))
	}

	code, body := callSmartListHandler(t, server.markFavoriteListSeen, http.MethodPost, "/api/favorite-lists/"+listKey+"/seen", "", smartListUser)
	if code != http.StatusOK {
		t.Fatalf("seen status = %d, body = %s", code, body)
	}
	if page := requestSmartListPage(t, server, listQuery); len(page.NewCounts) != 0 || len(page.NewWorkIDs) != 0 {
		t.Fatalf("after seen: new counts = %v, ids = %v", page.NewCounts, page.NewWorkIDs)
	}

	if _, err := db.Exec("INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (1, 1, 7)"); err != nil {
		t.Fatal(err)
	}
	code, body = callSmartListHandler(t, server.updateFavoriteList, http.MethodPatch, "/api/favorite-lists/"+listKey, `{"rule":{"include":[{"kind":"user","id":7}],"exclude":[{"kind":"metadata","id":102}]}}`, smartListUser)
	if code != http.StatusOK {
		t.Fatalf("rule update status = %d, body = %s", code, body)
	}
	if page := requestSmartListPage(t, server, listQuery); len(page.NewCounts) != 0 || !slices.Equal(pageCodes(page), []string{"RJ00000001", "RJ00000004"}) {
		t.Fatalf("after a rule edit: works %v new %v", pageCodes(page), page.NewCounts)
	}
}

func TestSmartRuleRefusesUnusableTagsAndFollowsTagChanges(t *testing.T) {
	server, db := openSmartListTestServer(t)
	for name, rule := range map[string]string{
		"another account's tag": `{"include":[{"kind":"user","id":9}]}`,
		"no include":            `{"include":[],"exclude":[{"kind":"metadata","id":102}]}`,
		"hidden tag":            `{"include":[{"kind":"metadata","id":104}]}`,
		"unknown tag":           `{"include":[{"kind":"metadata","id":999}]}`,
		"included and excluded": `{"include":[{"kind":"metadata","id":101}],"exclude":[{"kind":"metadata","id":101}]}`,
	} {
		code, body := callSmartListHandler(t, server.createFavoriteList, http.MethodPost, "/api/favorite-lists", `{"name":"Refused","kind":"smart","rule":`+rule+`}`, smartListUser)
		if code != http.StatusBadRequest || !strings.Contains(body, "invalid_smart_rule") {
			t.Fatalf("%s: status = %d, body = %s", name, code, body)
		}
	}

	merged := createSmartList(t, server, "Example Merged", `{"include":[{"kind":"metadata","id":103}]}`)
	if merged.Rule == nil || merged.Rule.Include[0].State != personal.SmartTagMerged || merged.Rule.Include[0].ResolvedID != 101 {
		t.Fatalf("merged tag view = %#v", merged.Rule)
	}
	if got := pageCodes(requestSmartListPage(t, server, "listId="+strconv.FormatInt(merged.ID, 10))); !slices.Equal(got, []string{"RJ00000001", "RJ00000002", "RJ00000005"}) {
		t.Fatalf("a merged tag matches %v, want its target's works", got)
	}

	personalList := createSmartList(t, server, "Example Personal", `{"includeMatch":"any","include":[{"kind":"user","id":7},{"kind":"metadata","id":101}]}`)
	if _, err := (personal.Store{DB: db}).ChangeTag(context.Background(), 1, "work", 7, "merge", "", 8); err != nil {
		t.Fatal(err)
	}
	rules, err := personal.LoadSmartRules(context.Background(), db, []int64{personalList.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(rules[personalList.ID].Include, personal.SmartRuleTag{Kind: personal.SmartTagUser, ID: 8}) {
		t.Fatalf("merged personal tag rule = %#v, want the merge target", rules[personalList.ID])
	}
	if got := pageCodes(requestSmartListPage(t, server, "listId="+strconv.FormatInt(personalList.ID, 10))); !slices.Contains(got, "RJ00000003") {
		t.Fatalf("a personal tag merge lost its match: %v", got)
	}

	if _, err := db.Exec("UPDATE metadata_tag SET hidden = 1 WHERE tag_id = 101"); err != nil {
		t.Fatal(err)
	}
	code, body := callSmartListHandler(t, server.updateFavoriteList, http.MethodPatch, "/api/favorite-lists/"+strconv.FormatInt(merged.ID, 10), `{"name":"Example Renamed","rule":{"include":[{"kind":"metadata","id":103}]}}`, smartListUser)
	if code != http.StatusOK || !strings.Contains(body, `"state":"hidden"`) {
		t.Fatalf("editing a list keeps a condition whose tag was hidden later: status %d, body %s", code, body)
	}

	if _, err := db.Exec("INSERT INTO favorite_list (id, user_id, name, kind) VALUES (40, 1, 'Plain', 'user')"); err != nil {
		t.Fatal(err)
	}
	code, body = callSmartListHandler(t, server.updateFavoriteList, http.MethodPatch, "/api/favorite-lists/40", `{"rule":{"include":[{"kind":"metadata","id":102}]}}`, smartListUser)
	if code != http.StatusBadRequest {
		t.Fatalf("a user list accepted a rule: status %d, body %s", code, body)
	}
}

func TestConvertSmartListKeepsTheShownWorksAsFavorites(t *testing.T) {
	server, db := openSmartListTestServer(t)
	list := createSmartList(t, server, "Example Convert", `{"include":[{"kind":"metadata","id":101}]}`)
	listKey := strconv.FormatInt(list.ID, 10)
	changeSmartListMembership(t, server, `{"workIds":[2],"removeListIds":[`+listKey+`]}`)
	changeSmartListMembership(t, server, `{"workIds":[3],"addListIds":[`+listKey+`]}`)

	code, body := callSmartListHandler(t, server.convertFavoriteList, http.MethodPost, "/api/favorite-lists/"+listKey+"/convert", "", smartListUser)
	if code != http.StatusOK || !strings.Contains(body, `"kind":"user"`) {
		t.Fatalf("convert status = %d, body = %s", code, body)
	}
	if got := pageCodes(requestSmartListPage(t, server, "listId="+listKey)); !slices.Equal(got, []string{"RJ00000001", "RJ00000003", "RJ00000005"}) {
		t.Fatalf("converted list = %v", got)
	}
	for workID, want := range map[int64]bool{1: true, 2: false, 3: true, 5: true, 6: false} {
		if got := workFavoriteFlag(t, db, workID); got != want {
			t.Fatalf("work %d favorite = %v, want %v", workID, got, want)
		}
	}
	var leftovers int
	if err := db.QueryRow(`SELECT
		(SELECT COUNT(*) FROM favorite_list_smart_rule WHERE list_id = ?) +
		(SELECT COUNT(*) FROM favorite_list_smart_tag WHERE list_id = ?) +
		(SELECT COUNT(*) FROM favorite_list_smart_exclusion WHERE list_id = ?) +
		(SELECT COUNT(*) FROM favorite_list_smart_seen WHERE list_id = ?)`, list.ID, list.ID, list.ID, list.ID).Scan(&leftovers); err != nil {
		t.Fatal(err)
	}
	if leftovers != 0 {
		t.Fatalf("converted list keeps %d smart rows", leftovers)
	}
	code, _ = callSmartListHandler(t, server.convertFavoriteList, http.MethodPost, "/api/favorite-lists/"+listKey+"/convert", "", smartListUser)
	if code != http.StatusBadRequest {
		t.Fatalf("converting a user list status = %d", code)
	}
}

func TestSmartRuleTagsAndPreviewNeedOnlyLibraryRead(t *testing.T) {
	server, _ := openSmartListTestServer(t)
	reader := currentUser{ID: 1, Permissions: []string{"library:read"}}
	code, body := callSmartListHandler(t, server.listSmartRuleTags, http.MethodGet, "/api/favorite-lists/rule-tags?q=example", "", reader)
	if code != http.StatusOK {
		t.Fatalf("rule tags status = %d, body = %s", code, body)
	}
	var tags struct {
		Tags []smartRuleTagOption `json:"tags"`
	}
	if err := json.Unmarshal([]byte(body), &tags); err != nil {
		t.Fatal(err)
	}
	if len(tags.Tags) != 2 || tags.Tags[0].ID != 101 || tags.Tags[0].WorkCount != 3 || tags.Tags[1].ID != 102 {
		t.Fatalf("rule tags = %#v, want visible resolved tags by work count", tags.Tags)
	}
	code, body = callSmartListHandler(t, server.listSmartRuleTags, http.MethodGet, "/api/favorite-lists/rule-tags?q=old", "", reader)
	if code != http.StatusOK || !strings.Contains(body, `"id":101`) {
		t.Fatalf("a merged tag's name finds its target: status %d, body %s", code, body)
	}

	code, body = callSmartListHandler(t, server.previewSmartRule, http.MethodPost, "/api/favorite-lists/rule-preview", `{"rule":{"include":[{"kind":"metadata","id":101}]}}`, reader)
	if code != http.StatusOK || !strings.Contains(body, `"total":3`) {
		t.Fatalf("preview status = %d, body = %s", code, body)
	}
}
