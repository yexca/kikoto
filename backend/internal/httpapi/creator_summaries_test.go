package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListCirclesPagesSummariesWithLatestKnownWork(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO party (id, display_name) VALUES (1, 'Alpha circle'), (2, 'Beta circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id) SELECT 1, id, 'maker_id', 'RG00001' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id) SELECT 2, id, 'maker_id', 'RG00002' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO work (id, primary_code, title, release_date) VALUES (1, 'RJ00000001', 'Older work', '2024-01-01'), (2, 'RJ00000002', 'Latest work', '2025-02-03')",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date) SELECT 1, id, 'RJ00000001', 'Older work', '2024-01-01' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date) SELECT 1, id, 'RJ00000002', 'Latest work', '2025-02-03' FROM metadata_provider WHERE code = 'dlsite'",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	request := httptest.NewRequest(http.MethodGet, "/api/circles?page=1&pageSize=1", nil)
	response := httptest.NewRecorder()
	server.listCircles(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var page circleSummaryPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || page.Page != 1 || page.PageSize != 1 || len(page.Circles) != 1 {
		t.Fatalf("page = %+v, want first of two circles", page)
	}
	latest := page.Circles[0].LatestWork
	if latest == nil || latest.PrimaryCode != "RJ00000002" || latest.Title != "Latest work" {
		t.Fatalf("latestWork = %+v, want latest release", latest)
	}
}

func TestLoadVoiceSummariesIncludesLatestKnownWork(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title, release_date) VALUES (1, 'RJ00000001', 'Older voice work', '2024-01-01'), (2, 'RJ00000002', 'Latest voice work', '2025-02-03')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test'), (2, 1, 'voice_actor', 'test')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	summaries, err := (&Server{db: db}).loadVoiceSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 || summaries[0].LatestWork == nil || summaries[0].LatestWork.PrimaryCode != "RJ00000002" {
		t.Fatalf("summaries = %+v, want latest voice work", summaries)
	}
}
