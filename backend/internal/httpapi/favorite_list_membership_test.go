package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func seedFavoriteMembershipBatch(t *testing.T) *Server {
	t.Helper()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES
			(1, 'synthetic-user', 'Synthetic User', 'user'),
			(2, 'other-user', 'Other User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000001', 'Example Work 1'),
			(2, 'RJ00000002', 'Example Work 2'),
			(3, 'RJ00000003', 'Example Work 3');
		INSERT INTO favorite_list (id, user_id, name, sort_order, kind) VALUES
			(10, 1, '', -1, 'marked'),
			(11, 1, 'Study', 0, 'user'),
			(12, 1, 'Sleep', 1, 'user'),
			(13, 1, 'Later', 2, 'user'),
			(21, 2, 'Other', 0, 'user');
		INSERT INTO favorite_list_item (list_id, work_id, created_at) VALUES
			(11, 1, '2026-08-10 00:00:00'),
			(12, 1, '2026-08-10 00:00:00'),
			(12, 2, '2026-08-10 00:00:00');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES
			(1, 1, 'none', 1),
			(1, 2, 'none', 1);
	`); err != nil {
		t.Fatal(err)
	}
	return NewServer(db, config.Config{})
}

func favoriteMembershipRows(t *testing.T, server *Server) map[int64][]int64 {
	t.Helper()
	rows, err := server.db.Query("SELECT work_id, list_id FROM favorite_list_item ORDER BY work_id, list_id")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	memberships := map[int64][]int64{}
	for rows.Next() {
		var workID, listID int64
		if err := rows.Scan(&workID, &listID); err != nil {
			t.Fatal(err)
		}
		memberships[workID] = append(memberships[workID], listID)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return memberships
}

func TestFavoriteListMembershipBatchPreservesUnnamedLists(t *testing.T) {
	server := seedFavoriteMembershipBatch(t)
	user := currentUser{ID: 1, Permissions: []string{"library:read", "favorites:write"}}

	summaryResponse := httptest.NewRecorder()
	server.summarizeFavoriteListMembership(summaryResponse, favoriteStateRequest(http.MethodPost, "/api/favorite-lists/membership/summary", `{"workIds":[1,2,3]}`, user))
	if summaryResponse.Code != http.StatusOK {
		t.Fatalf("summary status = %d, body = %s", summaryResponse.Code, summaryResponse.Body.String())
	}
	var summary favoriteListMembershipSummary
	if err := json.Unmarshal(summaryResponse.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	wantSummary := favoriteListMembershipSummary{Total: 3, Lists: []favoriteListMembershipCount{{ListID: 11, Count: 1}, {ListID: 12, Count: 2}, {ListID: 13, Count: 0}}}
	if !reflect.DeepEqual(summary, wantSummary) {
		t.Fatalf("summary = %#v, want %#v", summary, wantSummary)
	}

	// Add all three works to Later and remove them from Sleep; Study is not named
	// and must keep work 1.
	response := httptest.NewRecorder()
	server.updateFavoriteListMembership(response, favoriteStateRequest(http.MethodPost, "/api/favorite-lists/membership", `{"workIds":[1,2,3],"addListIds":[13],"removeListIds":[12]}`, user))
	if response.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", response.Code, response.Body.String())
	}
	want := map[int64][]int64{1: {11, 13}, 2: {13}, 3: {13}}
	if got := favoriteMembershipRows(t, server); !reflect.DeepEqual(got, want) {
		t.Fatalf("memberships = %#v, want %#v", got, want)
	}
	var favoriteCount int
	if err := server.db.QueryRow("SELECT COUNT(*) FROM user_work_state WHERE user_id = 1 AND favorite = 1").Scan(&favoriteCount); err != nil {
		t.Fatal(err)
	}
	if favoriteCount != 3 {
		t.Fatalf("favorite works = %d, want 3", favoriteCount)
	}

	// Removing the last list clears the favorite flag.
	response = httptest.NewRecorder()
	server.updateFavoriteListMembership(response, favoriteStateRequest(http.MethodPost, "/api/favorite-lists/membership", `{"workIds":[2],"removeListIds":[13]}`, user))
	if response.Code != http.StatusOK {
		t.Fatalf("remove status = %d, body = %s", response.Code, response.Body.String())
	}
	var favorite int
	if err := server.db.QueryRow("SELECT favorite FROM user_work_state WHERE user_id = 1 AND work_id = 2").Scan(&favorite); err != nil {
		t.Fatal(err)
	}
	if favorite != 0 {
		t.Fatalf("work 2 favorite = %d, want 0", favorite)
	}
}

func TestFavoriteListMembershipBatchRejectsWithoutPartialWrites(t *testing.T) {
	server := seedFavoriteMembershipBatch(t)
	user := currentUser{ID: 1, Permissions: []string{"library:read", "favorites:write"}}
	before := favoriteMembershipRows(t, server)

	for name, test := range map[string]struct {
		body string
		want int
	}{
		"marked list":         {`{"workIds":[1],"addListIds":[10]}`, http.StatusBadRequest},
		"another user's list": {`{"workIds":[1],"addListIds":[21]}`, http.StatusBadRequest},
		"add and remove same": {`{"workIds":[1],"addListIds":[13],"removeListIds":[13]}`, http.StatusBadRequest},
		"no list changes":     {`{"workIds":[1]}`, http.StatusBadRequest},
		"no works":            {`{"workIds":[],"addListIds":[13]}`, http.StatusBadRequest},
		"missing work":        {`{"workIds":[1,99],"addListIds":[13]}`, http.StatusNotFound},
	} {
		t.Run(name, func(t *testing.T) {
			response := httptest.NewRecorder()
			server.updateFavoriteListMembership(response, favoriteStateRequest(http.MethodPost, "/api/favorite-lists/membership", test.body, user))
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, test.want, response.Body.String())
			}
			if got := favoriteMembershipRows(t, server); !reflect.DeepEqual(got, before) {
				t.Fatalf("memberships changed to %#v, want %#v", got, before)
			}
		})
	}
}

func TestWorkListsLeadWithTheMostRecentAddition(t *testing.T) {
	server := seedFavoriteMembershipBatch(t)
	user := currentUser{ID: 1, Permissions: []string{"library:read", "favorites:write"}}
	// Work 3 joins Study last and Later first; work 2 joins two lists in the
	// same second, so only the order of insertion tells them apart.
	if _, err := server.db.Exec(`
		INSERT INTO favorite_list_item (list_id, work_id, created_at) VALUES
			(13, 3, '2026-08-10 00:00:00'),
			(12, 3, '2026-08-11 00:00:00'),
			(11, 3, '2026-08-12 00:00:00'),
			(11, 2, '2026-08-10 00:00:00'),
			(21, 3, '2026-08-13 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}

	code, body := callSmartListHandler(t, server.listWorks, http.MethodGet, "/api/works?pageSize=50&sort=code&direction=asc", "", user)
	if code != http.StatusOK {
		t.Fatalf("list works status = %d, body = %s", code, body)
	}
	var page struct {
		Works []libraryWorkSummary `json:"works"`
	}
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	for _, work := range page.Works {
		for _, list := range work.MemberLists {
			got[work.PrimaryCode] = append(got[work.PrimaryCode], list.Name)
		}
	}
	want := map[string][]string{
		"RJ00000001": {"Sleep", "Study"},
		"RJ00000002": {"Study", "Sleep"},
		"RJ00000003": {"Study", "Sleep", "Later"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("card lists = %v, want %v: newest addition first, without another user's lists", got, want)
	}

	// The work's own answer keeps list order for the picker and says where
	// each list stands among the lists holding the work.
	code, body = callSmartListHandler(t, server.getWorkFavoriteLists, http.MethodGet, "/api/works/3/favorite-lists", "", user)
	if code != http.StatusOK {
		t.Fatalf("work lists status = %d, body = %s", code, body)
	}
	var lists []favoriteListResponse
	if err := json.Unmarshal([]byte(body), &lists); err != nil {
		t.Fatal(err)
	}
	type listOrder struct {
		Name  string
		Order int
	}
	gotOrder := []listOrder{}
	for _, list := range lists {
		gotOrder = append(gotOrder, listOrder{list.Name, list.MemberOrder})
	}
	wantOrder := []listOrder{{"Marked", 0}, {"Study", 1}, {"Sleep", 2}, {"Later", 3}}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Fatalf("work lists = %v, want %v", gotOrder, wantOrder)
	}

	// A list the work joins now leads; the lists it was already in keep their times.
	code, body = callSmartListHandler(t, server.setWorkFavoriteLists, http.MethodPut, "/api/works/1/favorite-lists", `{"listIds":[11,12,13]}`, user)
	if code != http.StatusOK {
		t.Fatalf("set work lists status = %d, body = %s", code, body)
	}
	var saved struct {
		Lists []favoriteListResponse `json:"lists"`
	}
	if err := json.Unmarshal([]byte(body), &saved); err != nil {
		t.Fatal(err)
	}
	gotOrder = gotOrder[:0]
	for _, list := range saved.Lists {
		gotOrder = append(gotOrder, listOrder{list.Name, list.MemberOrder})
	}
	wantOrder = []listOrder{{"Marked", 0}, {"Study", 3}, {"Sleep", 2}, {"Later", 1}}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Fatalf("saved work lists = %v, want %v", gotOrder, wantOrder)
	}
}
