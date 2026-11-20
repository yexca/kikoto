package metasync

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// A response without translation_info and language_editions says nothing
// about the family, so an edition that is already classified keeps it.
func TestEditionKeepsItsFamilyWhenAResponseDeclaresNone(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{})
	translated := dlsite.Product{
		WorkNo: "RJ00000011", SiteID: "maniax", ProductName: "Translated title",
		TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: "RJ00000010", Lang: "CHI_HANS"},
		Raw:             json.RawMessage(`{"workno":"RJ00000011","product_name":"Translated title","translation_info":{"original_workno":"RJ00000010","lang":"CHI_HANS"}}`),
	}
	if _, err := syncer.SyncProductOnly(ctx, translated); err != nil {
		t.Fatal(err)
	}
	family := func() (string, int) {
		t.Helper()
		var canonical string
		var isCanonical int
		if err := db.QueryRow(`SELECT logical.canonical_code, edition.is_canonical FROM work_edition AS edition
			INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			WHERE edition.primary_code = 'RJ00000011'`).Scan(&canonical, &isCanonical); err != nil {
			t.Fatal(err)
		}
		return canonical, isCanonical
	}
	if canonical, isCanonical := family(); canonical != "RJ00000010" || isCanonical != 0 {
		t.Fatalf("classified family = %s canonical=%d", canonical, isCanonical)
	}

	bare := dlsite.Product{
		WorkNo: "RJ00000011", SiteID: "maniax", ProductName: "Translated title, renamed",
		Raw: json.RawMessage(`{"workno":"RJ00000011","product_name":"Translated title, renamed"}`),
	}
	if _, err := syncer.SyncProductOnly(ctx, bare); err != nil {
		t.Fatal(err)
	}
	if canonical, isCanonical := family(); canonical != "RJ00000010" || isCanonical != 0 {
		t.Fatalf("family after a response without family data = %s canonical=%d, want RJ00000010 and not canonical", canonical, isCanonical)
	}
}
