package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Retry metadata on a circle detail reads its count from the response, so the
// count covers the whole stored catalog whatever works page or filter is shown,
// and equals what the stored-catalog retry's missing-metadata filter accepts.
func TestCircleDetailCountsMetadataMissingWorksAcrossTheCatalog(t *testing.T) {
	db := openMigratedTestDB(t)
	ctx := context.Background()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO party (id, display_name) VALUES (1, 'Example Circle')")
	exec(`
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
		VALUES (1, ?, 'maker_id', 'RG00000001', 1)
	`, providerID)
	code := func(ordinal int) string { return testfixture.WorkCode(testfixture.PrefixRJ, ordinal) }
	catalog := func(ordinal int, release, status string) {
		exec(`
			INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date, catalog_status, dlsite_available)
			VALUES (1, ?, ?, 'Example Work', ?, ?, 1)
		`, providerID, code(ordinal), release, status)
	}
	// Newest first: the settled works fill the first page, the ones still
	// lacking metadata come after it.
	catalog(0, "2026-05-01", "imported")
	exec("INSERT INTO work (id, primary_code, title) VALUES (1, ?, 'Example Work')", code(0))
	exec(`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json) VALUES (1, ?, ?, '{}')`, providerID, code(0))
	catalog(1, "2026-04-01", "catalog_only")
	exec("INSERT INTO work (id, primary_code, title) VALUES (2, ?, 'Example Work')", code(1))
	exec(`INSERT INTO work_metadata_provider_state (work_id, provider_id, status) VALUES (2, ?, 'not_found')`, providerID)
	catalog(2, "2026-03-01", "catalog_only")
	exec("INSERT INTO work (id, primary_code, title) VALUES (3, ?, 'Example Work')", code(2))
	catalog(3, "2026-02-01", "catalog_only")
	catalog(4, "2026-01-01", "catalog_only")
	const wantMissing = 3

	server := &Server{db: db}
	profile, err := server.loadCircleProfileForRefresh(ctx, 1, "RG00000001")
	if err != nil {
		t.Fatal(err)
	}
	queued := 0
	for _, workCode := range profile.WorkCodes {
		missing, err := server.graphWorkMissingMetadata(ctx, workCode)
		if err != nil {
			t.Fatal(err)
		}
		if missing {
			queued++
		}
	}
	if queued != wantMissing {
		t.Fatalf("retry filter accepts %d works, want %d", queued, wantMissing)
	}

	for _, test := range []struct {
		name  string
		query string
	}{
		{"first page", "?page=1&pageSize=2"},
		{"later page", "?page=3&pageSize=2"},
		{"filtered to a settled work", "?q=" + code(0)},
		{"local works only", "?availability=local"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/circles/RG00000001"+test.query, nil)
			request.SetPathValue("externalId", "RG00000001")
			response := httptest.NewRecorder()
			server.getCircle(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			var detail struct {
				MetadataMissingWorks int `json:"metadataMissingWorks"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &detail); err != nil {
				t.Fatal(err)
			}
			if detail.MetadataMissingWorks != wantMissing {
				t.Fatalf("metadataMissingWorks = %d, want %d", detail.MetadataMissingWorks, wantMissing)
			}
		})
	}
}
