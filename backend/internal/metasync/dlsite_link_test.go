package metasync

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func TestSyncFamilyStoresLinkedSourceMetadataOnTheLinkedWork(t *testing.T) {
	db := openTestDB(t)
	if _, err := db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('dlsite', 'DLsite')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ00000040', 'Bonus edition folder')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_metadata_link (work_id, provider_id, source_code)
		SELECT work.id, provider.id, 'RJ00000041' FROM work, metadata_provider AS provider
		WHERE work.primary_code = 'RJ00000040' AND provider.code = 'dlsite'`); err != nil {
		t.Fatal(err)
	}
	source := dlsite.Product{
		WorkNo: "RJ00000041", ProductName: "Regular edition", MakerName: "Circle",
		Genres:           []dlsite.Genre{{Name: "Binaural"}},
		TranslationInfo:  dlsite.TranslationInfo{ParentWorkNo: "RJ00000042"},
		LanguageEditions: []dlsite.LanguageEdition{{WorkNo: "RJ00000041", DisplayOrder: 1, Lang: "JPN"}, {WorkNo: "RJ00000042", DisplayOrder: 2, Lang: "ENG"}},
		Raw: json.RawMessage(`{"product":{"workno":"RJ00000041","product_id":"RJ00000041","product_name":"Regular edition",` +
			`"translation_info":{"parent_workno":"RJ00000042"},"language_editions":[{"workno":"RJ00000042"}]},"dynamic":{"rate_count":3}}`),
	}
	client := &localizedFakeDLsiteClient{products: map[string]map[string]dlsite.Product{
		"RJ00000041": {"": source, "ja-jp": source},
	}}
	result, err := NewDLsiteSyncer(db, client).WithCacheRoot(t.TempDir()).SyncFamily(context.Background(), "RJ00000040")
	if err != nil {
		t.Fatalf("SyncFamily() error = %v", err)
	}
	if result.CanonicalCode != "RJ00000040" || len(result.SyncedCodes) != 1 || result.SyncedCodes[0] != "RJ00000040" {
		t.Fatalf("result = %+v, want only the linked work", result)
	}
	if len(client.calls) == 0 {
		t.Fatal("linked sync made no provider request")
	}
	for _, call := range client.calls {
		if !strings.HasPrefix(call, "RJ00000041:") {
			t.Fatalf("provider calls = %v, want only the linked source product", client.calls)
		}
	}
	if len(client.covers) != 1 || client.covers[0] != "RJ00000040" {
		t.Fatalf("cover downloads = %v, want the source cover stored for RJ00000040", client.covers)
	}

	var title string
	if err := db.QueryRow(`SELECT title FROM work WHERE primary_code = 'RJ00000040'`).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Regular edition" {
		t.Fatalf("linked work title = %q, want source metadata", title)
	}
	var works int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work WHERE primary_code IN ('RJ00000041', 'RJ00000042')`).Scan(&works); err != nil {
		t.Fatal(err)
	}
	var aliases int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_code_alias WHERE primary_code IN ('RJ00000041', 'RJ00000042')`).Scan(&aliases); err != nil {
		t.Fatal(err)
	}
	if works != 0 || aliases != 0 {
		t.Fatalf("source identities = %d works, %d aliases; want none", works, aliases)
	}
	var canonical string
	if err := db.QueryRow(`SELECT logical.canonical_code FROM work_edition AS edition
		JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		JOIN work ON work.id = edition.work_id WHERE work.primary_code = 'RJ00000040'`).Scan(&canonical); err != nil {
		t.Fatal(err)
	}
	if canonical != "RJ00000040" {
		t.Fatalf("linked work family = %q, want its own family", canonical)
	}

	var snapshot string
	if err := db.QueryRow(`SELECT snapshot_json FROM metadata_snapshot
		JOIN work ON work.id = metadata_snapshot.work_id WHERE work.primary_code = 'RJ00000040'`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Product map[string]json.RawMessage `json:"product"`
		Dynamic map[string]json.RawMessage `json:"dynamic"`
		Kikoto  struct {
			SourceCode string `json:"metadata_source_code"`
		} `json:"_kikoto"`
	}
	if err := json.Unmarshal([]byte(snapshot), &envelope); err != nil {
		t.Fatal(err)
	}
	if string(envelope.Product["workno"]) != `"RJ00000040"` || string(envelope.Product["product_id"]) != `"RJ00000040"` {
		t.Fatalf("snapshot product codes = %s/%s, want the linked work", envelope.Product["workno"], envelope.Product["product_id"])
	}
	if _, ok := envelope.Product["translation_info"]; ok {
		t.Fatal("snapshot kept the source translation relationship")
	}
	if _, ok := envelope.Product["language_editions"]; ok {
		t.Fatal("snapshot kept the source language editions")
	}
	if envelope.Kikoto.SourceCode != "RJ00000041" || string(envelope.Dynamic["rate_count"]) != "3" {
		t.Fatalf("snapshot provenance = %q, dynamic = %v", envelope.Kikoto.SourceCode, envelope.Dynamic)
	}
}

func TestSyncFamilyMarksLinkedWorkUnavailableWhenTheSourceIsGone(t *testing.T) {
	db := openTestDB(t)
	if _, err := db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('dlsite', 'DLsite')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ00000043', 'Local title')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_metadata_link (work_id, provider_id, source_code)
		SELECT work.id, provider.id, 'RJ00000044' FROM work, metadata_provider AS provider
		WHERE work.primary_code = 'RJ00000043' AND provider.code = 'dlsite'`); err != nil {
		t.Fatal(err)
	}
	result, err := NewDLsiteSyncer(db, fakeDLsiteClient{
		errors: map[string]error{"RJ00000044": dlsite.ErrNoProduct},
	}).SyncFamily(context.Background(), "RJ00000043")
	if err == nil || !result.RequestedUnavailable || len(result.SyncedCodes) != 0 {
		t.Fatalf("SyncFamily() = %+v, %v; want requested product unavailable", result, err)
	}
	var status, title string
	if err := db.QueryRow(`SELECT state.status, work.title FROM work_metadata_provider_state AS state
		JOIN work ON work.id = state.work_id WHERE work.primary_code = 'RJ00000043'`).Scan(&status, &title); err != nil {
		t.Fatal(err)
	}
	if status != "not_found" || title != "Local title" {
		t.Fatalf("linked work state = %q, title %q; want not_found with retained metadata", status, title)
	}
}
