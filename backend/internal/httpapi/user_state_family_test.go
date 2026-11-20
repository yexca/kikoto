package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A mark, rating, personal tag, or list change made through an edition's URL
// lands on the family's canonical work.
func TestEditionWritesLandOnTheCanonicalWork(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000013', 'Example Origin'), (2, 'RJ00000014', 'Example Edition');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000013');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(1, 1, 'RJ00000013', 'RJ00000013', 1), (2, 1, 'RJ00000014', 'RJ00000013', 0);
		INSERT INTO favorite_list (id, user_id, name, kind) VALUES (12, 1, 'Study', 'user');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	user := currentUser{ID: 1, Permissions: []string{"favorites:write", "library:read"}}

	response := httptest.NewRecorder()
	server.updateWorkUserState(response, favoriteStateRequest(http.MethodPatch, "/api/works/2/state", `{"listeningStatus":"listening","userRating":4}`, user))
	if response.Code != http.StatusOK {
		t.Fatalf("state through the edition = %d %s", response.Code, response.Body.String())
	}
	tagger := currentUser{ID: 1, Permissions: []string{"tags:write"}}
	response = httptest.NewRecorder()
	server.setWorkUserTags(response, favoriteStateRequest(http.MethodPut, "/api/works/2/user-tags", `{"tags":["Example Tag"]}`, tagger))
	if response.Code != http.StatusOK {
		t.Fatalf("tags through the edition = %d %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.setWorkFavoriteLists(response, favoriteStateRequest(http.MethodPut, "/api/works/2/favorite-lists", `{"listIds":[12]}`, user))
	if response.Code != http.StatusOK {
		t.Fatalf("lists through the edition = %d %s", response.Code, response.Body.String())
	}

	var editionRows int
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM user_work_state WHERE work_id = 2) + (SELECT COUNT(*) FROM favorite_list_item WHERE work_id = 2) + (SELECT COUNT(*) FROM user_work_tag WHERE work_id = 2)`).Scan(&editionRows); err != nil || editionRows != 0 {
		t.Fatalf("rows on the edition = %d, %v", editionRows, err)
	}
	var status string
	var rating int
	var favorite bool
	if err := db.QueryRow(`SELECT listening_status, rating, favorite FROM user_work_state WHERE user_id = 1 AND work_id = 1`).Scan(&status, &rating, &favorite); err != nil {
		t.Fatal(err)
	}
	if status != "listening" || rating != 4 || !favorite {
		t.Fatalf("canonical state = %q %d favorite=%v", status, rating, favorite)
	}
	var tags int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_work_tag WHERE user_id = 1 AND work_id = 1`).Scan(&tags); err != nil || tags != 1 {
		t.Fatalf("canonical tags = %d, %v", tags, err)
	}
}

// Reads that name an edition see the state its family's canonical work holds:
// list membership counts, card lists, personal tags, and ratings.
func TestEditionReadsSeeTheCanonicalWorkState(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'synthetic-user', 'Synthetic User', 'user');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000022', 'Example Origin'), (2, 'RJ00000023', 'Example Edition');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000022');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(1, 1, 'RJ00000022', 'RJ00000022', 1), (2, 1, 'RJ00000023', 'RJ00000022', 0);
		INSERT INTO favorite_list (id, user_id, name, kind) VALUES (12, 1, 'Study', 'user');
		INSERT INTO favorite_list_item (list_id, work_id) VALUES (12, 1);
		INSERT INTO user_tag (id, user_id, name) VALUES (1, 1, 'Example Tag');
		INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (1, 1, 1);
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite, rating) VALUES (1, 1, 'listening', 1, 4);
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	ctx := context.Background()

	response := httptest.NewRecorder()
	server.summarizeFavoriteListMembership(response, favoriteStateRequest(http.MethodPost, "/api/favorite-lists/membership", `{"workIds":[2]}`, currentUser{ID: 1, Permissions: []string{"library:read"}}))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `{"listId":12,"count":1}`) {
		t.Fatalf("membership summary for the edition = %d %s", response.Code, response.Body.String())
	}
	lists, err := server.loadWorkMemberListsBatch(ctx, 1, []int64{2})
	if err != nil || len(lists[2]) != 1 || lists[2][0].ID != 12 {
		t.Fatalf("card lists for the edition = %+v, %v", lists, err)
	}
	tags, err := server.loadWorkUserTagsBatch(ctx, 1, []int64{2})
	if err != nil || len(tags[2]) != 1 || tags[2][0].Name != "Example Tag" {
		t.Fatalf("tags for the edition = %+v, %v", tags, err)
	}
	ratings, err := server.loadWorkUserRatingsBatch(ctx, 1, []int64{2})
	if err != nil || ratings[2] == nil || *ratings[2] != 4 {
		t.Fatalf("rating for the edition = %+v, %v", ratings, err)
	}
}
