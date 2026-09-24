package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A scoped metadata sync covers the existing works of its target only. A
// catalog code without a work is left to the follow presets.
func TestMetadataSyncScopeSelectsExistingCreatorWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO party (id, display_name) VALUES (20, 'Example circle'), (21, 'Other circle')",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id) SELECT 20, id, 'maker_id', 'RG00001' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO party_external_id (party_id, provider_id, id_type, external_id) SELECT 21, id, 'maker_id', 'RG00002' FROM metadata_provider WHERE code = 'dlsite'",
		"INSERT INTO person (id, display_name) VALUES (7, 'Example Voice')",
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Credited'), (2, 'RJ00000002', 'Catalog only work'), (3, 'RJ00000003', 'Other circle'), (4, 'RJ00000004', 'Voiced')",
		"INSERT INTO work_party (work_id, party_id, role) VALUES (1, 20, 'circle'), (3, 21, 'circle')",
		`INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title)
			SELECT 20, metadata_provider.id, codes.value, 'Catalog' FROM metadata_provider, (SELECT 'RJ00000002' AS value UNION ALL SELECT 'RJ00000009') AS codes WHERE metadata_provider.code = 'dlsite'`,
		"INSERT INTO work_credit (work_id, person_id, role) VALUES (4, 7, 'voice_actor')",
		"INSERT INTO voice_catalog_item (person_id, primary_code) VALUES (7, 'RJ00000001'), (7, 'RJ00000008')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	for _, testCase := range []struct {
		options metadataSyncOptions
		want    []int64
	}{
		{metadataSyncOptions{Scope: "circle", CircleID: "rg00001"}, []int64{1, 2}},
		{metadataSyncOptions{Scope: "voice", PersonID: 7, Mode: "full"}, []int64{1, 4}},
	} {
		options, err := server.validateMetadataSyncOptions(context.Background(), testCase.options)
		if err != nil {
			t.Fatal(err)
		}
		scope, err := server.metadataSyncScope(context.Background(), options)
		if err != nil {
			t.Fatal(err)
		}
		slices.Sort(scope.WorkIDs)
		if !slices.Equal(scope.WorkIDs, testCase.want) || scope.Full != (options.Mode == "full") {
			t.Fatalf("%s scope = %+v, want works %v", options.Scope, scope, testCase.want)
		}
	}
	all, err := server.metadataSyncScope(context.Background(), metadataSyncOptions{Scope: "all", Mode: "missing"})
	if err != nil {
		t.Fatal(err)
	}
	if all.WorkIDs != nil || all.Full {
		t.Fatalf("unscoped sync = %+v, want every work with missing metadata", all)
	}
}

func TestMetadataSyncDeduplicatesPerScope(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	all, err := server.enqueueDLsiteMetadataSync(ctx, "manual", "manual")
	if err != nil {
		t.Fatal(err)
	}
	circle := metadataSyncOptions{Scope: "circle", CircleID: "RG00001", Mode: "full"}
	first, err := server.enqueueScopedDLsiteMetadataSync(ctx, "manual", "manual", 0, circle)
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.enqueueScopedDLsiteMetadataSync(ctx, "manual", "manual", 0, circle)
	if err != nil {
		t.Fatal(err)
	}
	if first.RunID == all.RunID || first.Deduplicated || second.RunID != first.RunID || !second.Deduplicated {
		t.Fatalf("scoped runs = all %d, first %+v, second %+v", all.RunID, first, second)
	}
	// A local scan follow-up joins only the unscoped queued run.
	followUp, coalesced, err := server.enqueueDLsiteMetadataSyncFollowUp(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if !coalesced || followUp.RunID != all.RunID {
		t.Fatalf("follow-up = %+v coalesced %t, want run %d", followUp, coalesced, all.RunID)
	}
}

func TestCreateMetadataSyncRunValidatesScope(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	post := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/dlsite-sync", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"metadata:sync"}}))
		response := httptest.NewRecorder()
		server.createDLsiteSyncRun(response, request)
		return response
	}
	for body, want := range map[string]string{
		`{"scope":"circle","circleId":"RJ00000001"}`: "circleId",
		`{"scope":"voice","personId":404}`:           "voice actor not found",
		`{"scope":"all","mode":"deep"}`:              "mode",
	} {
		if response := post(body); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), want) {
			t.Fatalf("%s = %d, %s", body, response.Code, response.Body.String())
		}
	}
	if response := post(``); response.Code != http.StatusAccepted {
		t.Fatalf("empty body = %d, %s", response.Code, response.Body.String())
	}
	var inputJSON string
	if err := db.QueryRow("SELECT input_json FROM workflow_run WHERE workflow_code = 'metadata_sync'").Scan(&inputJSON); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(inputJSON, `"scope":"all"`) || !strings.Contains(inputJSON, `"mode":"missing"`) {
		t.Fatalf("default metadata sync input = %s", inputJSON)
	}
}
