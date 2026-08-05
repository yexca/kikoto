package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
		INSERT INTO user_work_state (user_id, work_id, favorite) VALUES
			(1, 1, 1),
			(1, 2, 1),
			(1, 3, 1);
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
	Works []libraryWorkSummary `json:"works"`
	Total int                  `json:"total"`
} {
	t.Helper()
	response := httptest.NewRecorder()
	server.listFavoriteWorks(response, favoriteWorksRequest(target))
	if response.Code != http.StatusOK {
		t.Fatalf("list favorite works status = %d, body = %s", response.Code, response.Body.String())
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
