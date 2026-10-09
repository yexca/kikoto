package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func newTitleReviewFamily(t *testing.T, originalLanguage string, translations bool) manualOverrideFixture {
	t.Helper()
	f := newManualOverrideFixture(t, config.Config{})
	exec := func(query string, args ...any) sql.Result {
		t.Helper()
		result, err := f.db.Exec(query, args...)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	result := exec("INSERT INTO logical_work(canonical_work_id,canonical_code) VALUES (?,?)", f.workID, testfixture.WorkCode("RJ", 0))
	logicalID, _ := result.LastInsertId()
	exec("UPDATE work SET title='【ASMR】Example original', description='Example original introduction' WHERE id=?", f.workID)
	editions := []struct{ language, title, kind string }{{originalLanguage, "【ASMR】Example original", "origin"}}
	if translations {
		editions = append(editions, struct{ language, title, kind string }{"CHI_HANS", "【简体中文版】Example Chinese", "third_party"}, struct{ language, title, kind string }{"GER", "【ドイツ語版】Example German", "unknown"})
	}
	for ordinal, edition := range editions {
		code := testfixture.WorkCode("RJ", ordinal)
		id := f.workID
		if ordinal > 0 {
			result := exec("INSERT INTO work(primary_code,title,description) VALUES (?,?,?)", code, edition.title, "Example edition introduction")
			id, _ = result.LastInsertId()
		}
		exec(`INSERT INTO work_edition(work_id,logical_work_id,primary_code,metadata_language,is_canonical,translation_kind) VALUES (?,?,?,?,?,?)`, id, logicalID, code, edition.language, ordinal == 0, edition.kind)
		exec(`INSERT INTO dlsite_metadata_variant(logical_work_id,work_id,provider_id,external_id,edition_language,request_locale,title) VALUES (?,?,?,?,?,'ja-jp',?)`, logicalID, id, f.providerID, code, edition.language, edition.title)
	}
	exec("INSERT INTO party_catalog_item(party_id,provider_id,primary_code,title) VALUES (?,?,?,'Example catalog title')", f.partyID, f.providerID, testfixture.WorkCode("RJ", 0))
	exec("INSERT INTO work_credit(work_id,person_id,role,source) VALUES (?,?,'voice_actor','test')", f.workID, f.personID)
	return f
}

func TestTranslationTitlesUseFamilyPositionAndTheirOwnEdition(t *testing.T) {
	f := newTitleReviewFamily(t, "JPN", true)
	ctx := metadataLanguageViewer(f.userID)
	setUserMetadataLanguages(t, f.db, f.userID, `["zh-cn","origin"]`)
	detail, err := f.server.loadWorkDetail(ctx, f.userID, f.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail.Title != "Example Chinese" {
		t.Fatalf("third-party title: %q", detail.Title)
	}
	want := map[string]string{testfixture.WorkCode("RJ", 0): "【ASMR】Example original", testfixture.WorkCode("RJ", 1): "Example Chinese", testfixture.WorkCode("RJ", 2): "Example German"}
	if len(detail.Translations) != len(want) || len(detail.MetadataView.Variants) != len(want) {
		t.Fatalf("missing editions: %+v %+v", detail.Translations, detail.MetadataView)
	}
	for _, edition := range detail.Translations {
		if edition.Title != want[edition.PrimaryCode] {
			t.Errorf("edition %s title=%q want=%q", edition.PrimaryCode, edition.Title, want[edition.PrimaryCode])
		}
	}
	for _, variant := range detail.MetadataView.Variants {
		if variant.Title != want[variant.Key] {
			t.Errorf("menu %s title=%q", variant.Key, variant.Title)
		}
	}
	works := []libraryWorkSummary{{ID: f.workID}}
	if err := f.server.enrichLibraryWorkSummaries(ctx, f.userID, works); err != nil || works[0].Title != "Example Chinese" {
		t.Fatalf("card/search presentation: %+v %v", works, err)
	}
	var raw string
	if err := f.db.QueryRow("SELECT title FROM dlsite_metadata_variant WHERE external_id=?", testfixture.WorkCode("RJ", 2)).Scan(&raw); err != nil || raw != "【ドイツ語版】Example German" {
		t.Fatalf("raw title was changed: %q %v", raw, err)
	}
}

func TestUndeclaredOriginalLanguageIsConsistentAcrossTitleSurfaces(t *testing.T) {
	f := newTitleReviewFamily(t, "", false)
	ctx := context.Background()
	response := updateManualOverridesRequest(t, f, `{"titles":{"ja-jp":"Example authored Japanese"}}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	detail, err := f.server.loadWorkDetail(ctx, f.userID, f.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	want := "【ASMR】Example original"
	if detail.Title != want || detail.TitleChoices["origin"].Language != "" || detail.TitleChoices["origin"].Source != "original" {
		t.Fatalf("origin inferred from request locale: %+v", detail.TitleChoices)
	}
	for _, variant := range detail.MetadataView.Variants {
		if variant.Origin && (variant.Language != "" || variant.Title != want || variant.Key != detail.MetadataView.DefaultVariantKey) {
			t.Fatalf("unknown menu origin: %+v", variant)
		}
	}
	cards := []libraryWorkSummary{{ID: f.workID}}
	if err := f.server.enrichLibraryWorkSummaries(ctx, f.userID, cards); err != nil || cards[0].Title != want {
		t.Fatalf("card/search: %+v %v", cards, err)
	}
	circles, err := f.server.loadCircleWorks(ctx, f.userID, f.partyID)
	if err != nil || len(circles) != 1 || circles[0].Title != want {
		t.Fatalf("circle titles: %+v %v", circles, err)
	}
	voices, err := f.server.loadVoiceKnownWorks(ctx, f.userID, f.personID)
	if err != nil || len(voices) != 1 || voices[0].Title != want {
		t.Fatalf("voice titles: %+v %v", voices, err)
	}
	resolved, err := f.server.resolveWorkCodeDetail(ctx, testfixture.WorkCode("RJ", 0))
	if err != nil || resolved.Title != want {
		t.Fatalf("code lookup title: %+v %v", resolved, err)
	}
}

func TestUniversalManualTitleDoesNotInventLanguageOptions(t *testing.T) {
	f := newTitleReviewFamily(t, "JPN", false)
	if response := updateManualOverridesRequest(t, f, `{"title":"Example universal manual"}`); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	setUserMetadataLanguages(t, f.db, f.userID, `["zh-cn","origin"]`)
	detail, err := f.server.loadWorkDetail(metadataLanguageViewer(f.userID), f.userID, f.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(detail.MetadataView.Variants) != 1 || detail.MetadataView.Variants[0].Language != "ja-jp" || detail.MetadataView.DefaultVariantKey != testfixture.WorkCode("RJ", 0) || detail.Title != "Example universal manual" {
		t.Fatalf("universal manual invented an edition: %+v", detail.MetadataView)
	}
}

// A manual title stored only as a universal title must replace the displayed
// text without moving the default edition, introduction, or tags to
// the original when an earlier preferred language has no edition.
func TestUniversalManualTitleKeepsTheDefaultEdition(t *testing.T) {
	f := newTitleReviewFamily(t, "JPN", true)
	ctx := metadataLanguageViewer(f.userID)
	setUserMetadataLanguages(t, f.db, f.userID, `["zh-tw","zh-cn","origin"]`)
	before, err := f.server.loadWorkDetail(ctx, f.userID, f.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	translation := testfixture.WorkCode("RJ", 1)
	if before.MetadataView.DefaultVariantKey != translation || before.Description != "Example edition introduction" {
		t.Fatalf("baseline default edition: %+v %q", before.MetadataView, before.Description)
	}
	if response := updateManualOverridesRequest(t, f, `{"title":"Example universal manual"}`); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	after, err := f.server.loadWorkDetail(ctx, f.userID, f.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if after.Title != "Example universal manual" || after.MetadataView.DefaultVariantKey != translation || after.Description != before.Description || after.MetadataLanguage != before.MetadataLanguage {
		t.Fatalf("universal title moved the default edition: %+v %q %q", after.MetadataView, after.Description, after.MetadataLanguage)
	}
	if choice := after.TitleChoices["zh-cn"]; choice.Code != translation || choice.Source != "manual" {
		t.Fatalf("language choice: %+v", choice)
	}
	works := []libraryWorkSummary{{ID: f.workID}}
	if err := f.server.enrichLibraryWorkSummaries(ctx, f.userID, works); err != nil || works[0].Title != "Example universal manual" {
		t.Fatalf("card title: %+v %v", works, err)
	}
}

type titleQueryCounter struct {
	*sql.DB
	queries []string
}

func (q *titleQueryCounter) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	q.queries = append(q.queries, query)
	return q.DB.QueryContext(ctx, query, args...)
}

func TestTitleListReadsAreBatchedAndExcludeIntroductions(t *testing.T) {
	f := newTitleReviewFamily(t, "JPN", true)
	ids := []int64{f.workID}
	for ordinal := 3; ordinal < 25; ordinal++ {
		result, err := f.db.Exec("INSERT INTO work(primary_code,title,description) VALUES (?,?,?)", testfixture.WorkCode("RJ", ordinal), fmt.Sprintf("Example Work %d", ordinal), "Example long introduction")
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		ids = append(ids, id)
	}
	queryer := &titleQueryCounter{DB: f.db}
	inputs, err := loadWorkTitleInputs(context.Background(), queryer, ids, false)
	if err != nil || len(inputs) != len(ids) || len(queryer.queries) > 3 {
		t.Fatalf("list read did not stay bounded: inputs=%d queries=%d err=%v", len(inputs), len(queryer.queries), err)
	}
	for _, query := range queryer.queries {
		if strings.Contains(query, ".description") {
			t.Fatalf("title-only batch reads introduction columns: %s", query)
		}
	}
	variants, err := metasync.ListDLsiteMetadataVariants(context.Background(), f.db, f.workID)
	if err != nil || len(variants) != 3 {
		t.Fatalf("tag/list variants: %+v %v", variants, err)
	}
	for _, variant := range variants {
		if variant.Description != "" {
			t.Fatal("tag/list selection loaded introductions")
		}
	}
}
