package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestManualOnlyLanguagePreservesOriginalDefaultAndSharedTags(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{})
	ctx := context.Background()
	tx, err := fixture.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	tagID, err := metadatatags.CreateTx(ctx, tx, "Example shared tag", fixture.userID)
	if err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO work_tag(work_id,tag_id,source) VALUES (?,?,'manual')", fixture.workID, tagID); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	response := updateManualOverridesRequest(t, fixture, `{"titles":{"ja-jp":"Example Japanese manual"}}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	detail, err := fixture.server.loadWorkDetail(ctx, fixture.userID, fixture.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail.MetadataSync.Status != workMetadataSyncStatusNotSynced {
		t.Fatalf("manual language fabricated provider sync: %+v", detail.MetadataSync)
	}
	if detail.Title != "Example Work" {
		t.Fatalf("unknown original language guessed: %q", detail.Title)
	}
	var manualVariant workMetadataVariant
	for _, variant := range detail.MetadataView.Variants {
		if variant.Key == "manual:ja-jp" {
			manualVariant = variant
		}
	}
	if manualVariant.Title != "Example Japanese manual" || len(manualVariant.Tags) != 1 || manualVariant.Tags[0] != "Example shared tag" {
		t.Fatalf("manual language lost shared tags: %+v", manualVariant)
	}
}

func TestScopedTitlePatchAndResetKeepOtherLanguagesAndFields(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{})
	for _, payload := range []string{
		`{"title":"Global","circle":{"name":"Example authored circle"}}`,
		`{"titles":{"ja-jp":"Japanese manual","zh-cn":"Chinese manual"}}`,
		`{"titles":{"zh-cn":"Chinese revised"}}`,
	} {
		response := updateManualOverridesRequest(t, fixture, payload)
		if response.Code != http.StatusOK {
			t.Fatalf("PATCH: %d %s", response.Code, response.Body.String())
		}
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/works/1/manual-overrides/title?language=zh-cn", nil)
	request.SetPathValue("id", strconv.FormatInt(fixture.workID, 10))
	request.SetPathValue("field", "title")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, manualOverrideActor(t, fixture)))
	response := httptest.NewRecorder()
	fixture.server.deleteWorkManualOverride(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("DELETE: %d %s", response.Code, response.Body.String())
	}
	got, err := fixture.server.loadWorkManualOverrides(context.Background(), fixture.workID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Titles[""] != "Global" || got.Titles["ja-jp"] != "Japanese manual" || got.Titles["zh-cn"] != "" || got.Circle == nil || got.Circle.Name != "Example authored circle" {
		t.Fatalf("scoped reset: %+v", got)
	}
	// A null title is a global reset, leaving the locale-specific title.
	response = updateManualOverridesRequest(t, fixture, `{"title":null}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	var wire workManualOverrides
	if err := json.Unmarshal(response.Body.Bytes(), &wire); err != nil {
		t.Fatal(err)
	}
	if wire.Title != nil || wire.Titles["ja-jp"] != "Japanese manual" {
		t.Fatalf("legacy reset: %+v", wire)
	}
	for _, payload := range []string{`{"titles":{"unknown":"Bad"}}`, `{"titles":null}`, `{"title":"Ambiguous","titles":{"":"Also global"}}`} {
		response = updateManualOverridesRequest(t, fixture, payload)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid PATCH accepted: %s", payload)
		}
	}
}

func TestTitlePresentationSharesEditionDescriptionWithoutRewritingProvider(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{})
	ctx := metadataLanguageViewer(fixture.userID)
	translatedCode := testfixture.WorkCode("RJ", 1)
	result, err := fixture.db.Exec("INSERT INTO work(primary_code,title,description) VALUES (?, '【简体中文版】Example Chinese','Chinese introduction')", translatedCode)
	if err != nil {
		t.Fatal(err)
	}
	translatedID, _ := result.LastInsertId()
	result, err = fixture.db.Exec("INSERT INTO logical_work(canonical_work_id,canonical_code) VALUES (?,?)", fixture.workID, testfixture.WorkCode("RJ", 0))
	if err != nil {
		t.Fatal(err)
	}
	logicalID, _ := result.LastInsertId()
	queries := []struct {
		query string
		args  []any
	}{
		{"UPDATE work SET description='Japanese introduction' WHERE id=?", []any{fixture.workID}},
		{`INSERT INTO work_edition(work_id,logical_work_id,primary_code,metadata_language,is_canonical,translation_kind) VALUES (?,?,?,'JPN',1,'origin'),(?,?,?,'CHI_HANS',0,'official')`, []any{fixture.workID, logicalID, testfixture.WorkCode("RJ", 0), translatedID, logicalID, translatedCode}},
		{`INSERT INTO dlsite_metadata_variant(logical_work_id,work_id,provider_id,external_id,edition_language,title) VALUES (?,?,?,?,'JPN','Example Japanese'),(?,?,?,?,'CHI_HANS','【简体中文版】Example Chinese')`, []any{logicalID, fixture.workID, fixture.providerID, testfixture.WorkCode("RJ", 0), logicalID, translatedID, fixture.providerID, translatedCode}},
	}
	for _, q := range queries {
		if _, err := fixture.db.Exec(q.query, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	setUserMetadataLanguages(t, fixture.db, fixture.userID, `["zh-cn","origin"]`)
	detail, err := fixture.server.loadWorkDetail(ctx, fixture.userID, fixture.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Title != "Example Chinese" || detail.Description != "Chinese introduction" {
		t.Fatalf("detail: %+v", detail)
	}
	works := []libraryWorkSummary{{ID: fixture.workID, PrimaryCode: testfixture.WorkCode("RJ", 0)}}
	if err := fixture.server.enrichLibraryWorkSummaries(ctx, fixture.userID, works); err != nil {
		t.Fatal(err)
	}
	if works[0].Title != detail.Title {
		t.Fatalf("card title=%q detail=%q", works[0].Title, detail.Title)
	}
	response := updateManualOverridesRequest(t, fixture, `{"titles":{"zh-cn":"【简体中文版】Authored Chinese","ko-kr":"Authored Korean"}}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	detail, err = fixture.server.loadWorkDetail(ctx, fixture.userID, fixture.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Title != "【简体中文版】Authored Chinese" || detail.Description != "Chinese introduction" {
		t.Fatalf("manual detail: %+v", detail)
	}
	setUserMetadataLanguages(t, fixture.db, fixture.userID, `["ko-kr","zh-cn","origin"]`)
	detail, err = fixture.server.loadWorkDetail(ctx, fixture.userID, fixture.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Title != "Authored Korean" || detail.Description != "Japanese introduction" || detail.MetadataView.DefaultVariantKey != "manual:ko-kr" {
		t.Fatalf("manual-only language: %+v", detail)
	}
	var raw string
	if err := fixture.db.QueryRow("SELECT title FROM dlsite_metadata_variant WHERE work_id=?", translatedID).Scan(&raw); err != nil || raw != "【简体中文版】Example Chinese" {
		t.Fatalf("provider projection changed: %q %v", raw, err)
	}
}
