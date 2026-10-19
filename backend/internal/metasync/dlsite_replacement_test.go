package metasync

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestReplacementRequiresExactEditionIDAndLanguageWithoutParent(t *testing.T) {
	original := testfixture.WorkCode("RJ", 0)
	local := testfixture.WorkCode("RJ", 1)
	candidate := testfixture.WorkCode("RJ", 2)
	for _, tc := range []struct {
		name     string
		id       int64
		language string
		wantSame bool
	}{
		{"same edition", 7, "CHI_HANS", true},
		{"language only", 8, "CHI_HANS", false},
		{"edition id only", 7, "CHI_HANT", false},
		{"missing id", 0, "CHI_HANS", false},
		{"missing language", 7, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := openTestDB(t)
			syncer := NewDLsiteSyncer(db, fakeDLsiteClient{})
			ctx := context.Background()
			if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: original, ProductName: "Example Work"}); err != nil {
				t.Fatal(err)
			}
			previous := dlsite.Product{
				WorkNo: local, ProductName: "Example Work Chinese",
				TranslationInfo:  dlsite.TranslationInfo{OriginalWorkNo: original, Lang: "CHI_HANS"},
				LanguageEditions: []dlsite.LanguageEdition{{WorkNo: local, EditionID: 7, Lang: "CHI_HANS"}},
			}
			previous.Raw, _ = json.Marshal(previous)
			localID, err := syncer.SyncProductOnly(ctx, previous)
			if err != nil {
				t.Fatal(err)
			}
			product := dlsite.Product{
				WorkNo: candidate, ProductName: previous.ProductName,
				TranslationInfo:  dlsite.TranslationInfo{OriginalWorkNo: original, Lang: tc.language},
				LanguageEditions: []dlsite.LanguageEdition{{WorkNo: candidate, EditionID: tc.id, Lang: tc.language}},
			}
			product.Raw, _ = json.Marshal(product)
			for attempt := 0; attempt < 2; attempt++ {
				id, err := syncer.SyncProductOnly(ctx, product)
				if err != nil {
					t.Fatal(err)
				}
				if (id == localID) != tc.wantSame {
					t.Fatalf("work id = %d, local = %d, want reuse = %v", id, localID, tc.wantSame)
				}
			}
			var code string
			if err := db.QueryRow("SELECT primary_code FROM work_edition WHERE work_id = ?", localID).Scan(&code); err != nil || code != local {
				t.Fatalf("local edition = %q, error = %v", code, err)
			}
		})
	}
}

func TestParentInAnotherLanguageIsNotAReplacement(t *testing.T) {
	original := testfixture.WorkCode("RJ", 0)
	local := testfixture.WorkCode("RJ", 1)
	candidate := testfixture.WorkCode("RJ", 2)
	for _, tc := range []struct {
		name     string
		language string
		wantSame bool
	}{
		{"same language", "CHI_HANS", true},
		{"translated from the local edition", "CHI_HANT", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db := openTestDB(t)
			syncer := NewDLsiteSyncer(db, fakeDLsiteClient{})
			ctx := context.Background()
			if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: original, ProductName: "Example Work"}); err != nil {
				t.Fatal(err)
			}
			previous := dlsite.Product{
				WorkNo: local, ProductName: "Example Work Simplified Chinese",
				TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original, Lang: "CHI_HANS"},
			}
			previous.Raw, _ = json.Marshal(previous)
			localID, err := syncer.SyncProductOnly(ctx, previous)
			if err != nil {
				t.Fatal(err)
			}
			product := dlsite.Product{
				WorkNo: candidate, ProductName: "Example Work Other Edition",
				TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original, ParentWorkNo: local, Lang: tc.language},
			}
			product.Raw, _ = json.Marshal(product)
			id, err := syncer.SyncProductOnly(ctx, product)
			if err != nil {
				t.Fatal(err)
			}
			if (id == localID) != tc.wantSame {
				t.Fatalf("work id = %d, local = %d, want reuse = %v", id, localID, tc.wantSame)
			}
			if !tc.wantSame {
				var title string
				if err := db.QueryRow("SELECT title FROM work WHERE id = ?", localID).Scan(&title); err != nil || title != previous.ProductName {
					t.Fatalf("local edition title = %q, %v", title, err)
				}
			}
		})
	}
}

func TestFetchedReplacementMustBeRequestedByItsExactCode(t *testing.T) {
	for _, wrongExactResponse := range []bool{false, true} {
		t.Run(map[bool]string{false: "verified", true: "mismatched exact response"}[wrongExactResponse], func(t *testing.T) {
			db := openTestDB(t)
			syncer := NewDLsiteSyncer(db, fakeDLsiteClient{})
			ctx := context.Background()
			original, local, candidate := testfixture.WorkCode("RJ", 0), testfixture.WorkCode("RJ", 1), testfixture.WorkCode("RJ", 2)
			if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: original, ProductName: "Example Work"}); err != nil {
				t.Fatal(err)
			}
			localID, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: local, ProductName: "Example Work Chinese", TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original}})
			if err != nil {
				t.Fatal(err)
			}
			requests := []string{}
			_, id, err := syncer.syncFetchedProduct(ctx, local, func(_ context.Context, code string) (dlsite.Product, error) {
				requests = append(requests, code)
				actual := candidate
				if code == candidate && wrongExactResponse {
					actual = testfixture.WorkCode("RJ", 3)
				}
				return dlsite.Product{WorkNo: actual, TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original, ParentWorkNo: local}}, nil
			})
			if len(requests) != 2 || requests[0] != local || requests[1] != candidate {
				t.Fatalf("exact provider requests = %v", requests)
			}
			if wrongExactResponse {
				if err == nil {
					t.Fatal("mismatched exact response was accepted")
				}
				var aliases int
				if err := db.QueryRow("SELECT COUNT(*) FROM work_code_alias WHERE relationship_kind = 'provider_reissued'").Scan(&aliases); err != nil || aliases != 0 {
					t.Fatalf("unverified aliases = %d, error = %v", aliases, err)
				}
			} else if err != nil || id != localID {
				t.Fatalf("replacement owner = %d, error = %v, want %d", id, err, localID)
			}
		})
	}
}
