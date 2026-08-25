package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestCircleProjectionAssignsTranslatedCatalogAndAvailabilityToOriginCircle(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		"INSERT INTO party (id, display_name) VALUES (1, 'Origin Circle'), (2, 'Translation Circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (1, ?, 'maker_id', 'RG00000001', 1), (2, ?, 'maker_id', 'RG00000002', 1)",
		"INSERT INTO work (id, primary_code, title, release_date) VALUES (1, 'RJ00000000', 'Origin title', '2024-01-01'), (2, 'RJ00000001', 'Translated title', '2024-02-01')",
		"INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000000')",
		"INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id, origin_maker_id) VALUES (1, 1, ?, 'RJ00000000', 'RJ00000000', 1, 'origin', 'RG00000001', 'RG00000001'), (2, 1, ?, 'RJ00000001', 'RJ00000000', 0, 'third_party', 'RG00000002', 'RG00000001')",
		"INSERT INTO work_party (work_id, party_id, role, provider_id, source) VALUES (1, 1, 'circle', ?, 'dlsite_snapshot'), (2, 2, 'translator_circle', ?, 'dlsite_snapshot')",
		"INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (1, ?, 'RJ00000000', '{\"product\":{\"workno\":\"RJ00000000\",\"maker_id\":\"RG00000001\",\"maker_name\":\"Origin Circle\"}}'), (2, ?, 'RJ00000001', '{\"product\":{\"workno\":\"RJ00000001\",\"maker_id\":\"RG00000002\",\"maker_name\":\"Translation Circle\",\"translation_info\":{\"original_workno\":\"RJ00000000\"}}}')",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date, catalog_status, dlsite_available) VALUES (2, ?, 'RJ00000001', 'Translated title', '2024-02-01', 'imported', 1)",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (11, 'synthetic_local', 'Synthetic Local', 'local_scan', 1)",
		"INSERT INTO media_item (id, work_id, kind, title) VALUES (11, 2, 'audio', 'Translated track')",
		"INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (11, 11, 11, 'local', 'RJ00000001/track.mp3', 'available')",
	}
	for index, statement := range statements {
		var err error
		switch index {
		case 1:
			_, err = db.Exec(statement, providerID, providerID)
		case 4:
			_, err = db.Exec(statement, providerID, providerID)
		case 5:
			_, err = db.Exec(statement, providerID, providerID)
		case 6:
			_, err = db.Exec(statement, providerID, providerID)
		case 7:
			_, err = db.Exec(statement, providerID)
		default:
			_, err = db.Exec(statement)
		}
		if err != nil {
			t.Fatalf("statement %d: %v", index, err)
		}
	}

	server := &Server{db: db}
	if err := server.upsertAuthoritativeWorkParty(ctx, 2, 2, "dlsite_snapshot"); err != nil {
		t.Fatal(err)
	}
	var originRelationRole, translationRelationRole string
	if err := db.QueryRow("SELECT role FROM work_party WHERE work_id = 2 AND party_id = 1").Scan(&originRelationRole); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT role FROM work_party WHERE work_id = 2 AND party_id = 2").Scan(&translationRelationRole); err != nil {
		t.Fatal(err)
	}
	if originRelationRole != "circle" || translationRelationRole != "translator_circle" {
		t.Fatalf("translation relations = %q/%q, want circle/translator_circle", originRelationRole, translationRelationRole)
	}
	pageResponse := httptest.NewRecorder()
	server.listCircles(pageResponse, httptest.NewRequest(http.MethodGet, "/api/circles", nil))
	if pageResponse.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", pageResponse.Code, pageResponse.Body.String())
	}
	var page circleSummaryPage
	if err := json.Unmarshal(pageResponse.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Circles) != 1 || page.Circles[0].ExternalID != "RG00000001" {
		t.Fatalf("circles = %+v, want only the origin circle", page.Circles)
	}
	summary := page.Circles[0]
	if summary.CatalogWorks != 1 || summary.LocalWorks != 1 || summary.PlayableWorks != 1 || summary.MissingWorks != 0 {
		t.Fatalf("origin summary = %+v, want one catalog/local/playable work", summary)
	}

	works, err := server.loadCircleWorks(ctx, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 1 {
		t.Fatalf("origin works = %+v, want one canonical work", works)
	}
	work := works[0]
	if work.PrimaryCode != "RJ00000000" || work.RemoteCode != "RJ00000001" || work.CircleExternalID != "RG00000001" || work.Circle != "Origin Circle" {
		t.Fatalf("projected work = %+v, want origin identity with translated source code", work)
	}
	if !work.Local || len(work.SourceTags) == 0 {
		t.Fatalf("projected availability = local %v, tags %+v", work.Local, work.SourceTags)
	}
	if work.ReleaseDate == nil || *work.ReleaseDate != "2024-01-01" {
		t.Fatalf("projected release = %v, want canonical release", work.ReleaseDate)
	}

	translatorRequest := httptest.NewRequest(http.MethodGet, "/api/circles/RG00000002", nil)
	translatorRequest.SetPathValue("externalId", "RG00000002")
	translatorResponse := httptest.NewRecorder()
	server.getCircle(translatorResponse, translatorRequest)
	if translatorResponse.Code != http.StatusNotFound {
		t.Fatalf("translator circle status = %d, want 404", translatorResponse.Code)
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/circles/RG00000001/catalog/RJ00000000", nil)
	deleteRequest.SetPathValue("externalId", "RG00000001")
	deleteRequest.SetPathValue("code", "RJ00000000")
	deleteRequest = deleteRequest.WithContext(context.WithValue(deleteRequest.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"metadata:sync"}}))
	deleteResponse := httptest.NewRecorder()
	server.deleteCircleCatalogWork(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("projected catalog delete status = %d, body = %s", deleteResponse.Code, deleteResponse.Body.String())
	}
	var physicalRows int
	if err := db.QueryRow("SELECT COUNT(*) FROM party_catalog_item WHERE primary_code = 'RJ00000001'").Scan(&physicalRows); err != nil {
		t.Fatal(err)
	}
	if physicalRows != 0 {
		t.Fatalf("translated physical catalog rows = %d, want 0 after canonical delete", physicalRows)
	}
}

func TestTranslationOnlyCircleWithoutWorkPartyRelationIsHidden(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	statements := []string{
		"INSERT INTO party (id, display_name) VALUES (1, 'Example Origin Circle'), (2, 'Example Translation Circle')",
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Origin'), (2, 'RJ00000001', 'Example Translation')",
		"INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000000')",
		"INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical, translation_kind, maker_id, origin_maker_id) VALUES (1, 1, ?, 'RJ00000000', 'RJ00000000', 1, 'origin', 'RG00000001', 'RG00000001'), (2, 1, ?, 'RJ00000001', 'RJ00000000', 0, 'third_party', 'RG00000002', 'RG00000001')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) VALUES (1, ?, 'maker_id', 'RG00000001', 1), (2, ?, 'maker_id', 'RG00000002', 1)",
		"INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, catalog_status, dlsite_available) VALUES (2, ?, 'RJ00000001', 'Example Translation', 'imported', 1)",
	}
	for index, statement := range statements {
		var err error
		switch index {
		case 3, 4:
			_, err = db.Exec(statement, providerID, providerID)
		case 5:
			_, err = db.Exec(statement, providerID)
		default:
			_, err = db.Exec(statement)
		}
		if err != nil {
			t.Fatalf("statement %d: %v", index, err)
		}
	}

	server := &Server{db: db}
	visible, err := server.circlePartyVisible(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if visible {
		t.Fatal("translation-only circle without work_party relation is visible")
	}
	response := httptest.NewRecorder()
	server.listCircles(response, httptest.NewRequest(http.MethodGet, "/api/circles", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", response.Code, response.Body.String())
	}
	var page circleSummaryPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Circles) != 1 || page.Circles[0].ExternalID != "RG00000001" {
		t.Fatalf("circles = %+v, want only the origin circle", page.Circles)
	}
}

func TestLoadCircleWorksLimitsLogicalWorksAfterEditionExpansion(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO party (id, display_name) VALUES (1, 'Example Origin Circle')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
		VALUES (1, ?, 'maker_id', 'RG00000001', 1)
	`, providerID); err != nil {
		t.Fatal(err)
	}
	// One logical work has more physical language editions than the old SQL
	// LIMIT. The second logical work must still survive that expansion.
	for index := 0; index <= 101; index++ {
		code := testfixture.WorkCodeAt(index)
		workID := int64(1000 + index)
		releaseDate := "2025-01-01"
		if index == 101 {
			releaseDate = "2024-01-01"
		}
		if _, err := db.Exec(`
			INSERT INTO work (id, primary_code, title, release_date)
			VALUES (?, ?, ?, ?)
		`, workID, code, "Example "+code, releaseDate); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO logical_work (id, canonical_work_id, canonical_code)
		VALUES (1, 1000, ?), (2, 1101, ?)
	`, testfixture.WorkCodeAt(0), testfixture.WorkCodeAt(101)); err != nil {
		t.Fatal(err)
	}
	for index := 0; index <= 101; index++ {
		code := testfixture.WorkCodeAt(index)
		workID := int64(1000 + index)
		isCanonical := 0
		makerID := "RG00000002"
		if index == 0 {
			isCanonical = 1
			makerID = "RG00000001"
		}
		logicalID := int64(1)
		if index == 101 {
			logicalID = 2
		}
		if _, err := db.Exec(`
			INSERT INTO work_edition (
				work_id, logical_work_id, provider_id, primary_code, base_code,
				is_canonical, translation_kind, maker_id, origin_maker_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, workID, logicalID, providerID, code, testfixture.WorkCodeAt(0), isCanonical,
			map[bool]string{true: "origin", false: "third_party"}[isCanonical == 1], makerID, "RG00000001"); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`
			INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date, catalog_status, dlsite_available)
			VALUES (1, ?, ?, ?, ?, 'imported', 1)
		`, providerID, code, "Catalog "+code, func() string {
			if index == 101 {
				return "2024-01-01"
			}
			return "2025-01-01"
		}()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO work_party (work_id, party_id, role, provider_id, source)
		VALUES (1000, 1, 'circle', ?, 'dlsite_snapshot'), (1101, 1, 'circle', ?, 'dlsite_snapshot')
	`, providerID, providerID); err != nil {
		t.Fatal(err)
	}

	works, err := (&Server{db: db}).loadCircleWorks(ctx, 0, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 2 {
		t.Fatalf("projected works = %d (%+v), want two logical works", len(works), works)
	}
	seen := map[string]bool{}
	for _, work := range works {
		seen[work.PrimaryCode] = true
	}
	if !seen[testfixture.WorkCodeAt(0)] || !seen[testfixture.WorkCodeAt(101)] {
		t.Fatalf("projected codes = %v, want canonical and second logical work", seen)
	}
}
