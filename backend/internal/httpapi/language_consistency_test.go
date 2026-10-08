package httpapi

import (
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// A translated work must use the same personal default as its Library card,
// including origin fallback and a manual language without a provider edition.
func TestPersonalMetadataDefaultIsConsistentForEveryEdition(t *testing.T) {
	f := newTitleReviewFamily(t, "JPN", true)
	ctx := metadataLanguageViewer(f.userID)
	metadataReviewExec(t, f.db, "UPDATE work_edition SET metadata_language='CHI_HANT' WHERE primary_code=?", testfixture.WorkCode(testfixture.PrefixRJ, 2))
	metadataReviewExec(t, f.db, "UPDATE dlsite_metadata_variant SET edition_language='CHI_HANT',title='Example Traditional',request_locale='zh-tw' WHERE external_id=?", testfixture.WorkCode(testfixture.PrefixRJ, 2))
	metadataReviewExec(t, f.db, "UPDATE work SET description='Example Simplified introduction' WHERE primary_code=?", testfixture.WorkCode(testfixture.PrefixRJ, 1))
	metadataReviewExec(t, f.db, "UPDATE work SET description='Example Traditional introduction' WHERE primary_code=?", testfixture.WorkCode(testfixture.PrefixRJ, 2))
	for ordinal := range 3 {
		var id int64
		if err := f.db.QueryRow("SELECT id FROM work WHERE primary_code=?", testfixture.WorkCode(testfixture.PrefixRJ, ordinal)).Scan(&id); err != nil {
			t.Fatal(err)
		}
		metadataReviewExec(t, f.db, `INSERT INTO work_manual_override(work_id,field_name,language,value_json) VALUES (?,'title','ko-kr','"Example Korean"')`, id)
		for _, tc := range []struct{ priority, title, description, language, key string }{
			{`["zh-cn","origin"]`, "Example Chinese", "Example Simplified introduction", "zh-cn", testfixture.WorkCode(testfixture.PrefixRJ, 1)},
			{`["zh-tw","origin"]`, "Example Traditional", "Example Traditional introduction", "zh-tw", testfixture.WorkCode(testfixture.PrefixRJ, 2)},
			{`["en-us","origin"]`, "【ASMR】Example original", "Example original introduction", "origin", testfixture.WorkCode(testfixture.PrefixRJ, 0)},
			{`["ko-kr","origin"]`, "Example Korean", "Example original introduction", "ko-kr", "manual:ko-kr"},
		} {
			setUserMetadataLanguages(t, f.db, f.userID, tc.priority)
			detail, err := f.server.loadWorkDetail(ctx, f.userID, id, false)
			if err != nil {
				t.Fatal(err)
			}
			cards, err := f.server.loadWorkTitles(ctx, []int64{id})
			if err != nil {
				t.Fatal(err)
			}
			if detail.Title != tc.title || cards[id].Title != tc.title || detail.Description != tc.description || detail.MetadataLanguage != tc.language || detail.MetadataView.DefaultVariantKey != tc.key {
				t.Fatalf("edition %d priority %s: card=%+v detail=%q description=%q language=%q default=%q", ordinal, tc.priority, cards[id], detail.Title, detail.Description, detail.MetadataLanguage, detail.MetadataView.DefaultVariantKey)
			}
		}
	}
}
