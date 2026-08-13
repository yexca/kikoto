package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestListFavoriteWorksFiltersByAnySelectedFileSourceAcrossLogicalFamily(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES
			(1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000001', 'Example Work 1'),
			(2, 'RJ00000002', 'Example Work 2'),
			(3, 'RJ00000003', 'Example Work 3'),
			(4, 'RJ00000004', 'Example Work 4');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES
			(1, 1, 'RJ00000001');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, is_canonical) VALUES
			(1, 1, 'RJ00000001', 'RJ00000001', 'JPN', 1),
			(4, 1, 'RJ00000004', 'RJ00000001', 'CHI_HANS', 0);
		INSERT INTO file_source (id, code, display_name, source_type) VALUES
			(11, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible'),
			(12, 'example_remote_b', 'Example Remote B', 'kikoeru_compatible'),
			(13, 'example_remote_c', 'Example Remote C', 'kikoeru_compatible');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES
			(4, 11, 'tracked', 'available'),
			(3, 13, 'source', 'available');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(21, 2, 'audio', 'Track 1', 'favorite-source-b-track');
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES
			(21, 12, 'cache', 'RJ00000002/track.mp3', 'available');
		INSERT INTO favorite_list (id, user_id, name, kind) VALUES
			(1, 1, 'Study', 'user');
		INSERT INTO favorite_list_item (list_id, work_id) VALUES
			(1, 1),
			(1, 2),
			(1, 3);
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	page := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&sort=code&direction=asc&sourceId=11&sourceId=12")
	if page.Total != 2 || len(page.Works) != 2 {
		t.Fatalf("selected source page = total %d works %#v, want 2", page.Total, page.Works)
	}
	if page.Works[0].PrimaryCode != "RJ00000001" || page.Works[1].PrimaryCode != "RJ00000002" {
		t.Fatalf("selected source works = %#v", page.Works)
	}

	cachePage := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&availability=cache&sourceId=12")
	if cachePage.Total != 1 || len(cachePage.Works) != 1 || cachePage.Works[0].PrimaryCode != "RJ00000002" {
		t.Fatalf("cached source page = total %d works %#v", cachePage.Total, cachePage.Works)
	}

	missingPage := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&availability=missing&sourceId=11")
	if missingPage.Total != 1 || len(missingPage.Works) != 1 || missingPage.Works[0].PrimaryCode != "RJ00000001" {
		t.Fatalf("presence-only source page = total %d works %#v", missingPage.Total, missingPage.Works)
	}
}

func TestListFavoriteWorksSeparatesMarkedFromUserListsAndPlaybackHistory(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES
			(1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000001', 'Example User List Work'),
			(2, 'RJ00000002', 'Example Listening Mark'),
			(3, 'RJ00000003', 'Example Played Work'),
			(4, 'RJ00000004', 'Example Unmarked Work');
		INSERT INTO favorite_list (id, user_id, name, sort_order, kind) VALUES
			(11, 1, '', -1, 'marked'),
			(12, 1, 'Study', 0, 'user');
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (12, 1);
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES
			(1, 1, 'none', 1),
			(1, 2, 'finished', 0),
			(1, 3, 'none', 0),
			(1, 4, 'none', 0);
		INSERT INTO media_item (id, work_id, kind, title) VALUES
			(21, 3, 'audio', 'Example track');
		INSERT INTO user_work_playback_cursor (user_id, work_id, media_item_id, position_seconds, last_played_at)
		VALUES (1, 3, 21, 12, '2026-08-10 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	page := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&sort=code&direction=asc")
	if page.Total != 2 || len(page.Works) != 2 || page.Works[0].PrimaryCode != "RJ00000001" || page.Works[1].PrimaryCode != "RJ00000002" {
		t.Fatalf("all favorites = total %d works %#v, want explicit list and marked works", page.Total, page.Works)
	}

	markedPage := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&sort=code&direction=asc&listId=11")
	if markedPage.Total != 1 || len(markedPage.Works) != 1 || markedPage.Works[0].PrimaryCode != "RJ00000002" {
		t.Fatalf("marked page = total %d works %#v, want only quick-marked work", markedPage.Total, markedPage.Works)
	}

	listPage := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&sort=code&direction=asc&listId=12")
	if listPage.Total != 1 || len(listPage.Works) != 1 || listPage.Works[0].PrimaryCode != "RJ00000001" {
		t.Fatalf("user list page = total %d works %#v, want only explicit list work", listPage.Total, listPage.Works)
	}

	if page.StatusCounts["finished"] != 1 {
		t.Fatalf("all favorite status counts = %#v, want marked finished work", page.StatusCounts)
	}
	if markedPage.StatusCounts["none"] != 0 {
		t.Fatalf("marked status counts = %#v, must not include user-list-only work", markedPage.StatusCounts)
	}

	libraryPage := requestLibraryWorksPage(t, server, "/api/works?page=1&pageSize=10&q=shelf:true&sort=code&direction=asc")
	if libraryPage.Total != 2 || len(libraryPage.Works) != 2 || libraryPage.Works[0].PrimaryCode != "RJ00000001" || libraryPage.Works[1].PrimaryCode != "RJ00000002" {
		t.Fatalf("shelf search = total %d works %#v, want explicit list and marked works without cursor-only work", libraryPage.Total, libraryPage.Works)
	}
}

func TestFavoriteAddedSortUsesCurrentMembershipTimes(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000001', 'Example Earlier Mark'),
			(2, 'RJ00000002', 'Example Later List Work'),
			(3, 'RJ00000003', 'Example Removed Mark');
		INSERT INTO favorite_list (id, user_id, name, sort_order, kind) VALUES
			(11, 1, '', -1, 'marked'),
			(12, 1, 'Study', 0, 'user');
		INSERT INTO favorite_list_item (list_id, work_id, created_at) VALUES
			(12, 2, '2026-08-12 00:00:00');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite, updated_at) VALUES
			(1, 1, 'finished', 0, '2026-08-10 00:00:00'),
			(1, 2, 'none', 1, '2026-08-01 00:00:00'),
			(1, 3, 'none', 0, '2026-08-13 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	allPage := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&sort=added&direction=desc")
	if len(allPage.Works) != 2 || allPage.Works[0].PrimaryCode != "RJ00000002" || allPage.Works[1].PrimaryCode != "RJ00000001" {
		t.Fatalf("all added order = %#v, want latest current membership first", allPage.Works)
	}
	markedPage := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&sort=added&direction=desc&listId=11")
	if len(markedPage.Works) != 1 || markedPage.Works[0].PrimaryCode != "RJ00000001" {
		t.Fatalf("marked added order = %#v, want only current quick mark", markedPage.Works)
	}
	listPage := requestFavoriteWorksPage(t, server, "/api/favorite-works?page=1&pageSize=10&sort=added&direction=desc&listId=12")
	if len(listPage.Works) != 1 || listPage.Works[0].PrimaryCode != "RJ00000002" {
		t.Fatalf("user-list added order = %#v, want explicit membership time", listPage.Works)
	}
}

func TestSetWorkFavoriteListsPreservesExistingMembershipTime(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Example Listed Work');
		INSERT INTO favorite_list (id, user_id, name, sort_order, kind) VALUES (12, 1, 'Study', 0, 'user');
		INSERT INTO favorite_list_item (list_id, work_id, created_at) VALUES (12, 1, '2026-08-10 00:00:00');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite, updated_at)
		VALUES (1, 1, 'none', 1, '2026-08-01 00:00:00');
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	user := currentUser{ID: 1, Permissions: []string{"favorites:write"}}
	response := httptest.NewRecorder()
	server.setWorkFavoriteLists(response, favoriteStateRequest(http.MethodPut, "/api/works/1/favorite-lists", `{"listIds":[12]}`, user))
	if response.Code != http.StatusOK {
		t.Fatalf("set unchanged list membership status = %d, body = %s", response.Code, response.Body.String())
	}
	var createdAt string
	if err := db.QueryRow("SELECT created_at FROM favorite_list_item WHERE list_id = 12 AND work_id = 1").Scan(&createdAt); err != nil {
		t.Fatal(err)
	}
	if createdAt != "2026-08-10 00:00:00" {
		t.Fatalf("membership timestamp = %q, want unchanged timestamp", createdAt)
	}
}

func TestFavoriteListEndpointsProtectMarkedAndPreserveListSummaries(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES
			(1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES
			(1, 'RJ00000001', 'Example Marked Work'),
			(2, 'RJ00000002', 'Example User List Work');
		INSERT INTO favorite_list (id, user_id, name, sort_order, kind) VALUES
			(11, 1, '', -1, 'marked'),
			(12, 1, 'Study', 0, 'user');
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES
			(1, 1, 'want_to_listen', 0),
			(1, 2, 'none', 1);
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (12, 2);
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	user := currentUser{ID: 1, Permissions: []string{"library:read", "favorites:write"}}

	updateMarked := favoriteStateRequest(http.MethodPatch, "/api/favorite-lists/11", `{"name":"Changed"}`, user)
	updateMarkedResponse := httptest.NewRecorder()
	server.updateFavoriteList(updateMarkedResponse, updateMarked)
	if updateMarkedResponse.Code != http.StatusBadRequest {
		t.Fatalf("update marked status = %d, body = %s", updateMarkedResponse.Code, updateMarkedResponse.Body.String())
	}

	deleteMarked := favoriteStateRequest(http.MethodDelete, "/api/favorite-lists/11", "", user)
	deleteMarkedResponse := httptest.NewRecorder()
	server.deleteFavoriteList(deleteMarkedResponse, deleteMarked)
	if deleteMarkedResponse.Code != http.StatusBadRequest {
		t.Fatalf("delete marked status = %d, body = %s", deleteMarkedResponse.Code, deleteMarkedResponse.Body.String())
	}

	setMarked := favoriteStateRequest(http.MethodPut, "/api/works/1/favorite-lists", `{"listIds":[11]}`, user)
	setMarkedResponse := httptest.NewRecorder()
	server.setWorkFavoriteLists(setMarkedResponse, setMarked)
	if setMarkedResponse.Code != http.StatusBadRequest {
		t.Fatalf("set marked membership status = %d, body = %s", setMarkedResponse.Code, setMarkedResponse.Body.String())
	}

	legacyFavorite := favoriteStateRequest(http.MethodPatch, "/api/works/2/user-state", `{"favorite":false}`, user)
	legacyFavoriteResponse := httptest.NewRecorder()
	server.updateWorkUserState(legacyFavoriteResponse, legacyFavorite)
	if legacyFavoriteResponse.Code != http.StatusBadRequest {
		t.Fatalf("legacy favorite mutation status = %d, body = %s", legacyFavoriteResponse.Code, legacyFavoriteResponse.Body.String())
	}

	listRequest := favoriteStateRequest(http.MethodGet, "/api/works/1/favorite-lists", "", user)
	listResponse := httptest.NewRecorder()
	server.getWorkFavoriteLists(listResponse, listRequest)
	if listResponse.Code != http.StatusOK {
		t.Fatalf("get work lists status = %d, body = %s", listResponse.Code, listResponse.Body.String())
	}
	var lists []favoriteListResponse
	if err := json.Unmarshal(listResponse.Body.Bytes(), &lists); err != nil {
		t.Fatal(err)
	}
	if len(lists) != 2 || lists[0].Kind != "marked" || lists[0].Name != "Marked" || !lists[0].Selected || lists[1].Kind != "user" || lists[1].Selected {
		t.Fatalf("work lists = %#v", lists)
	}

	markedWorkIDs := favoriteStateRequest(http.MethodGet, "/api/favorite-lists/11/work-ids", "", user)
	markedWorkIDsResponse := httptest.NewRecorder()
	server.listFavoriteListWorkIDs(markedWorkIDsResponse, markedWorkIDs)
	if markedWorkIDsResponse.Code != http.StatusOK || !strings.Contains(markedWorkIDsResponse.Body.String(), `"workIds":[1]`) {
		t.Fatalf("marked work ids status = %d, body = %s", markedWorkIDsResponse.Code, markedWorkIDsResponse.Body.String())
	}
}

func TestListFavoriteWorksRejectsInvalidSourceID(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	request := favoriteWorksRequest("/api/favorite-works?sourceId=invalid")
	response := httptest.NewRecorder()

	server.listFavoriteWorks(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, http.StatusBadRequest, response.Body.String())
	}
}

func requestFavoriteWorksPage(t *testing.T, server *Server, target string) struct {
	Works        []libraryWorkSummary `json:"works"`
	Total        int                  `json:"total"`
	StatusCounts map[string]int       `json:"statusCounts"`
} {
	t.Helper()
	response := httptest.NewRecorder()
	server.listFavoriteWorks(response, favoriteWorksRequest(target))
	if response.Code != http.StatusOK {
		t.Fatalf("list favorite works status = %d, body = %s", response.Code, response.Body.String())
	}
	var page struct {
		Works        []libraryWorkSummary `json:"works"`
		Total        int                  `json:"total"`
		StatusCounts map[string]int       `json:"statusCounts"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func requestLibraryWorksPage(t *testing.T, server *Server, target string) struct {
	Works []libraryWorkSummary `json:"works"`
	Total int                  `json:"total"`
} {
	t.Helper()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"library:read"}}))
	server.listWorks(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list library works status = %d, body = %s", response.Code, response.Body.String())
	}
	var page struct {
		Works []libraryWorkSummary `json:"works"`
		Total int                  `json:"total"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func favoriteWorksRequest(target string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	user := currentUser{ID: 1, Permissions: []string{"library:read"}}
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
}

func favoriteStateRequest(method string, target string, body string, user currentUser) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	for _, segment := range strings.Split(strings.Trim(target, "/"), "/") {
		if _, err := strconv.ParseInt(segment, 10, 64); err == nil {
			request.SetPathValue("id", segment)
			break
		}
	}
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
}
