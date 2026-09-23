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
