package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestSyncVoiceCreditPersistsProviderScopedExternalIdentity(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec("INSERT INTO work (id, primary_code, title) VALUES (50, 'RJ05000000', 'Remote identity work')"); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("INSERT INTO metadata_provider (code, display_name) VALUES ('test_remote_metadata', 'Test remote metadata') RETURNING id").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := syncVoiceCreditSnapshot(context.Background(), tx, voiceCreditSnapshotRow{
		WorkID: 50, ProviderID: sql.NullInt64{Int64: providerID, Valid: true}, Raw: `{"vas":[{"id":"va-72","name":"Scoped voice"}]}`,
	}); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var name, externalID string
	if err := db.QueryRow(`
		SELECT person.display_name, external.external_id
		FROM person_external_id AS external
		INNER JOIN person ON person.id = external.person_id
		WHERE external.provider_id = ? AND external.id_type = 'voice_actor_id'
	`, providerID).Scan(&name, &externalID); err != nil {
		t.Fatal(err)
	}
	if name != "Scoped voice" || externalID != "va-72" {
		t.Fatalf("identity = %q / %q", name, externalID)
	}
}

func TestResolveWorkEntityLinkUsesPersistedRelationshipsWithoutFetching(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (10, 'RJ01234567', 'Linked work')",
		"INSERT INTO party (id, display_name) VALUES (20, 'Linked circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary) SELECT 20, id, 'maker_id', 'RG01234567', 1 FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO work_party (work_id, party_id, role, provider_id, source) SELECT 10, 20, 'circle', id, 'test' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_series (id, party_id, provider_id, title_id, name) SELECT 30, 20, id, 'SRI0000000001', 'Linked series' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_series_work (series_id, primary_code) VALUES (30, 'RJ01234567')",
		"INSERT INTO person (id, display_name) VALUES (40, 'Linked voice')",
		"INSERT INTO person_alias (person_id, alias, source) VALUES (40, 'Voice alias', 'test')",
		"INSERT INTO work_credit (work_id, person_id, role, provider_id, source) SELECT 10, 40, 'voice_actor', id, 'test' FROM metadata_provider WHERE code = 'dlsite'",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	tests := []struct {
		kind string
		name string
		want string
	}{
		{kind: "circle", name: "Linked circle", want: "/circles/RG01234567"},
		{kind: "series", name: "Linked series", want: "/circles/RG01234567/series/SRI0000000001"},
		{kind: "voice", name: "Voice alias", want: "/voices/40"},
	}
	for _, test := range tests {
		t.Run(test.kind, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/works/RJ01234567/entity-links/resolve", strings.NewReader(`{"kind":"`+test.kind+`","name":"`+test.name+`"}`))
			request.SetPathValue("code", "RJ01234567")
			response := httptest.NewRecorder()
			server.resolveWorkEntityLink(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			var body workEntityLinkResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body.Route != test.want || !body.Resolved || body.Fetched {
				t.Fatalf("response = %+v, want route %q without fetch", body, test.want)
			}
		})
	}
}
