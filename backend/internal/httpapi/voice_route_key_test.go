package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func seedVoiceRouteKeyFixture(t *testing.T, db *sql.DB) {
	t.Helper()
	for _, statement := range []string{
		"INSERT INTO metadata_provider (id, code, display_name) VALUES (11, 'kikoeru_source_example_remote_a', 'Example Remote A')",
		"INSERT INTO work (id, primary_code, title) VALUES (10, 'RJ00000000', 'Example Work')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice 1', 'example voice 1'), (2, 'Example Voice 2', 'example voice 2'), (3, 'Example Voice 3', 'example voice 3'), (4, 'Example Voice 4', 'example voice 4')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (10, 1, 'voice_actor', 'test'), (10, 2, 'voice_actor', 'test'), (10, 3, 'voice_actor', 'test'), (10, 4, 'voice_actor', 'test')",
		// Person 1 holds two DLsite ids; the primary one is canonical even though
		// its row is newer.
		"INSERT INTO person_external_id (id, person_id, provider_id, id_type, external_id, is_primary) SELECT 100, 1, id, 'voice_actor_id', '00000002', 0 FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO person_external_id (id, person_id, provider_id, id_type, external_id, is_primary) SELECT 101, 1, id, 'voice_actor_id', '00000001', 1 FROM metadata_provider WHERE code = 'dlsite'",
		// Person 3 holds only a remote source's voice actor id.
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) VALUES (3, 11, 'voice_actor_id', '00000003', 1)",
		// Person 4 holds a DLsite id of another type and a non-numeric one.
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) SELECT 4, id, 'maker_id', '00000004', 1 FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) SELECT 4, id, 'voice_actor_id', 'local-1', 1 FROM metadata_provider WHERE code = 'dlsite'",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
}

func TestVoiceRouteKeyUsesCanonicalDLsiteIDOrLocalFallback(t *testing.T) {
	db := openMigratedTestDB(t)
	seedVoiceRouteKeyFixture(t, db)
	server := &Server{db: db}
	ctx := context.Background()

	keys, err := server.voiceRouteKeys(ctx, []int64{1, 2, 3, 4, 1})
	if err != nil {
		t.Fatal(err)
	}
	want := map[int64]string{1: "00000001", 2: "local-2", 3: "local-3", 4: "local-4"}
	for personID, key := range want {
		if keys[personID] != key {
			t.Fatalf("route key of person %d = %q, want %q (all %v)", personID, keys[personID], key, keys)
		}
	}

	summaries, err := server.loadVoiceSummaryRows(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, summary := range summaries {
		if summary.RouteKey != want[summary.PersonID] {
			t.Fatalf("summary of person %d route key = %q, want %q", summary.PersonID, summary.RouteKey, want[summary.PersonID])
		}
	}

	credits, err := server.voiceCreditsForWork(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.fillVoiceCreditRouteKeys(ctx, credits); err != nil {
		t.Fatal(err)
	}
	for _, credit := range credits {
		if credit.RouteKey != want[credit.PersonID] {
			t.Fatalf("credit of person %d route key = %q, want %q", credit.PersonID, credit.RouteKey, want[credit.PersonID])
		}
	}
}

func TestResolveVoiceRouteKey(t *testing.T) {
	db := openMigratedTestDB(t)
	seedVoiceRouteKeyFixture(t, db)
	server := &Server{db: db}
	ctx := context.Background()

	for _, test := range []struct {
		key  string
		want voiceRoute
	}{
		{"00000001", voiceRoute{PersonID: 1, RouteKey: "00000001"}},
		// A non-canonical DLsite id and the local key of a person with a DLsite
		// id address the person and report the canonical key.
		{"00000002", voiceRoute{PersonID: 1, RouteKey: "00000001"}},
		{"local-1", voiceRoute{PersonID: 1, RouteKey: "00000001"}},
		{"local-2", voiceRoute{PersonID: 2, RouteKey: "local-2"}},
		{"local-3", voiceRoute{PersonID: 3, RouteKey: "local-3"}},
	} {
		route, err := server.resolveVoiceRouteKey(ctx, test.key)
		if err != nil || route != test.want {
			t.Fatalf("resolve %q = %+v, %v; want %+v", test.key, route, err, test.want)
		}
	}
	// A bare number is always a DLsite id: never a person id, a remote
	// source's id, or a DLsite id of another type.
	for _, key := range []string{"1", "2", "00000003", "00000004", "00000099", "local-99", "local-02", "local-", "local-0", "local--1", "Example Voice 1", ""} {
		if route, err := server.resolveVoiceRouteKey(ctx, key); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("resolve %q = %+v, %v; want not found", key, route, err)
		}
	}
}

func TestVoiceRouteKeyFollowsIdentityChanges(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice 1', 'example voice 1'), (2, 'Example Voice 2', 'example voice 2')",
		"INSERT INTO person_alias (person_id, alias, source) VALUES (1, 'Example Voice 1', 'primary_name'), (2, 'Example Voice 2', 'primary_name')",
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) SELECT 1, id, 'voice_actor_id', '00000001', 1 FROM metadata_provider WHERE code = 'dlsite'",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{db: db}
	ctx := context.Background()
	resolve := func(key string) voiceRoute {
		t.Helper()
		route, err := server.resolveVoiceRouteKey(ctx, key)
		if err != nil {
			t.Fatalf("resolve %q: %v", key, err)
		}
		return route
	}

	// Person 2 gains a DLsite id; its local key now reports the DLsite id.
	if route := resolve("local-2"); route.RouteKey != "local-2" {
		t.Fatalf("before the DLsite id, local-2 = %+v", route)
	}
	var dlsiteProviderID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&dlsiteProviderID); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := upsertPersonIdentity(ctx, tx, voiceCreditTarget{}, "Example Voice 2", sql.NullInt64{Int64: dlsiteProviderID, Valid: true}, "00000002"); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if route := resolve("local-2"); route != (voiceRoute{PersonID: 2, RouteKey: "00000002"}) {
		t.Fatalf("after the DLsite id, local-2 = %+v", route)
	}

	// Merging person 2 into person 1 keeps person 1's id canonical, and the
	// merged id addresses person 1.
	merged, err := server.mergeVoicePeople(ctx, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if route := resolve("00000002"); route != (voiceRoute{PersonID: 1, RouteKey: "00000001"}) {
		t.Fatalf("after the merge, 00000002 = %+v", route)
	}
	if _, err := server.resolveVoiceRouteKey(ctx, "local-2"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("after the merge, local-2 err = %v, want not found", err)
	}

	// Undo returns the id to the restored person.
	if _, err := server.undoVoiceMerge(ctx, 1, merged["mergeId"].(int64)); err != nil {
		t.Fatal(err)
	}
	if route := resolve("00000002"); route != (voiceRoute{PersonID: 2, RouteKey: "00000002"}) {
		t.Fatalf("after the undo, 00000002 = %+v", route)
	}
	if route := resolve("00000001"); route != (voiceRoute{PersonID: 1, RouteKey: "00000001"}) {
		t.Fatalf("after the undo, 00000001 = %+v", route)
	}
}

func TestGetVoiceRouteReportsUnknownKeyAsNotFound(t *testing.T) {
	db := openMigratedTestDB(t)
	seedVoiceRouteKeyFixture(t, db)
	server := &Server{db: db}
	get := func(key string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/voice-routes/"+key, nil)
		request.SetPathValue("routeKey", key)
		response := httptest.NewRecorder()
		server.getVoiceRoute(response, request)
		return response
	}

	response := get("00000002")
	var route voiceRoute
	if err := json.Unmarshal(response.Body.Bytes(), &route); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || route != (voiceRoute{PersonID: 1, RouteKey: "00000001"}) {
		t.Fatalf("known key = %d %s", response.Code, response.Body.String())
	}
	if response := get("00000099"); response.Code != http.StatusNotFound {
		t.Fatalf("unknown key = %d %s", response.Code, response.Body.String())
	}
}
