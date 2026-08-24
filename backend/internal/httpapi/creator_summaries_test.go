package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
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

func TestCircleDetailReadDoesNotQueueARefreshWorkflow(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO party (id, display_name) VALUES (1, 'Example Circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id) SELECT 1, id, 'maker_id', 'RG00001' FROM metadata_provider WHERE code = 'dlsite'",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := NewServer(db, config.Config{})
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('anonymous_access_enabled', 'true')`); err != nil {
		t.Fatal(err)
	}
	if err := server.LoadAccessPolicy(context.Background()); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/circles/RG00001", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("detail GET status = %d, body = %s", response.Code, response.Body.String())
	}
	var runCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'circle_metadata_refresh'").Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 0 {
		t.Fatalf("detail GET created %d workflows, want none", runCount)
	}

	response = httptest.NewRecorder()
	legacyRequest := httptest.NewRequest(http.MethodPost, "/api/circles/RG00001/auto-refresh", nil)
	legacyRequest = legacyRequest.WithContext(context.WithValue(legacyRequest.Context(), currentUserKey, currentUser{ID: 1}))
	server.Routes().ServeHTTP(response, legacyRequest)
	if response.Code != http.StatusNotFound {
		t.Fatalf("legacy auto-refresh status = %d, want %d", response.Code, http.StatusNotFound)
	}
}

func TestCircleWorkSourceTagsUsesAnEmptyArrayWhenNoSourceExists(t *testing.T) {
	db := openMigratedTestDB(t)
	server := &Server{db: db}

	tags, err := server.workSourceTags(context.Background(), 0, "RJ00000000")
	if err != nil {
		t.Fatal(err)
	}
	if tags == nil {
		t.Fatal("source tags = nil, want an empty slice")
	}
	if len(tags) != 0 {
		t.Fatalf("source tags = %+v, want empty", tags)
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

func TestLoadCircleAvailableWorksCountsCanonicalUnionOnce(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO party (id, display_name) VALUES (1, 'Example Circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id) SELECT 1, id, 'maker_id', 'RG00001' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO metadata_provider (code, display_name) VALUES ('kikoeru_source_example_remote_a', 'Example Remote A')",
		"INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'example_local', 'Example Local', 'local_scan', 10, 1), (12, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 20, 1)",
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Example Work 1'), (2, 'RJ00000002', 'Example Work 2')",
		"INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000001')",
		"INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES (1, 1, 'RJ00000001', 'RJ00000001', 1), (2, 1, 'RJ00000002', 'RJ00000001', 0)",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title) SELECT 1, id, 'RJ00000001', 'Example Work 1' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title) SELECT 1, id, 'RJ00000002', 'Example Work 2' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title) SELECT 1, id, 'RJ00000003', 'Example Work 3' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title) SELECT 1, id, 'RJ00000002', 'Example Work 2' FROM metadata_provider WHERE code = 'kikoeru_source_example_remote_a'",
		"INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Example Track')",
		"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 11, 'local', 'Library/RJ00000001/track.mp3', 'available'), (2, 1, 12, 'cache', 'cache/RJ00000001/track.mp3', 'available')",
		"INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability) VALUES (2, 12, 'source', 'RJ00000002', 'available')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	available, err := server.loadCircleAvailableWorks(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if available != 1 {
		t.Fatalf("available works = %d, want one canonical work across editions and sources", available)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/circles", nil)
	response := httptest.NewRecorder()
	server.listCircles(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var page circleSummaryPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Circles) != 1 {
		t.Fatalf("circles = %+v, want one circle", page.Circles)
	}
	summary := page.Circles[0]
	if summary.CatalogWorks != 2 || summary.PlayableWorks != 1 || summary.MissingWorks != 1 {
		t.Fatalf("summary = %+v, want catalog 2, available 1, and missing 1", summary)
	}
	if page.CatalogWorks != 2 || page.AvailableWorks != 1 {
		t.Fatalf("page totals = %+v, want catalog 2 and available 1", page)
	}
}
