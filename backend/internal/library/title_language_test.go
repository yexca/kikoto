package library

import (
	"context"
	"database/sql"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func titleSortCodes(t *testing.T, store *Store, languages []string, ordinals ...int) []string {
	t.Helper()
	page, err := store.ListPage(context.Background(), ListOptions{PageSize: 100, Sort: "title", Direction: "asc", TitleLanguages: languages})
	if err != nil {
		t.Fatal(err)
	}
	wanted := map[string]bool{}
	for _, ordinal := range ordinals {
		wanted[testfixture.WorkCode(testfixture.PrefixRJ, ordinal)] = true
	}
	codes := []string{}
	for _, work := range page.Works {
		if wanted[work.PrimaryCode] {
			codes = append(codes, work.PrimaryCode)
		}
	}
	return codes
}

func titleLanguageVariant(t *testing.T, db *sql.DB, logicalID, workID int64, ordinal int, language, title string) int64 {
	t.Helper()
	return execSearchFixture(t, db, `INSERT INTO dlsite_metadata_variant (logical_work_id, work_id, provider_id, external_id, edition_language, request_locale, title)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, logicalID, workID, dlsiteProviderID(t, db), testfixture.WorkCode(testfixture.PrefixRJ, ordinal), language, language, title)
}

func queuedTitleLanguageWorks(t *testing.T, db *sql.DB) []int64 {
	t.Helper()
	rows, err := db.Query(`SELECT work_id FROM work_title_language_dirty ORDER BY work_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return ids
}

// A title sort follows the titles each viewer sees, from stored language
// titles that no preference change rewrites.
func TestTitleSortFollowsViewerLanguage(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	translatedFamily := insertSearchWork(t, db, 20, "Bravo original")
	translation := insertSearchWork(t, db, 21, "Bravo original")
	logicalID := searchEditionFamily(t, db, []int{20, 21}, translatedFamily, translation)
	titleLanguageVariant(t, db, logicalID, translatedFamily, 20, "ja-jp", "Bravo original")
	titleLanguageVariant(t, db, logicalID, translation, 21, "zh-cn", "【简体中文版】Aaa translated")
	insertSearchWork(t, db, 22, "Alpha original")
	store := NewStore(db)
	if err := store.RefreshTitleLanguages(context.Background()); err != nil {
		t.Fatal(err)
	}

	if got, want := titleSortCodes(t, store, []string{"origin"}, 20, 22), []string{"RJ00000022", "RJ00000020"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("origin title order = %v, want %v", got, want)
	}
	// The translated edition's title, without its edition label, sorts first;
	// a work without a Chinese title keeps its original title.
	if got, want := titleSortCodes(t, store, []string{"zh-cn", "origin"}, 20, 22), []string{"RJ00000020", "RJ00000022"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("zh-cn title order = %v, want %v", got, want)
	}

	// A language-specific manual title is that language's title.
	execSearchFixture(t, db, `INSERT INTO work_manual_override(work_id,field_name,language,value_json) VALUES (?,'title','zh-cn','"Zulu manual"')`, translatedFamily)
	if got := queuedTitleLanguageWorks(t, db); !reflect.DeepEqual(got, []int64{translatedFamily}) {
		t.Fatalf("queued after manual title = %v", got)
	}
	if err := store.RefreshTitleLanguages(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, want := titleSortCodes(t, store, []string{"zh-cn", "origin"}, 20, 22), []string{"RJ00000022", "RJ00000020"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("zh-cn order after manual title = %v, want %v", got, want)
	}
}

// An edition's title is part of every family member's titles, so changing
// it queues the whole family.
func TestTitleLanguageQueueCoversWholeFamily(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	canonical := insertSearchWork(t, db, 23, "Example original")
	translation := insertSearchWork(t, db, 24, "Example original")
	logicalID := searchEditionFamily(t, db, []int{23, 24}, canonical, translation)
	variantID := titleLanguageVariant(t, db, logicalID, translation, 24, "en-us", "Example English")
	store := NewStore(db)
	if err := store.RefreshTitleLanguages(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := queuedTitleLanguageWorks(t, db); len(got) != 0 {
		t.Fatalf("queue after refresh = %v", got)
	}
	execSearchFixture(t, db, `UPDATE dlsite_metadata_variant SET title = 'Example English revised' WHERE id = ?`, variantID)
	if got := queuedTitleLanguageWorks(t, db); !reflect.DeepEqual(got, []int64{canonical, translation}) {
		t.Fatalf("queued after variant change = %v", got)
	}
	if err := store.RefreshTitleLanguages(context.Background()); err != nil {
		t.Fatal(err)
	}
	var title string
	if err := db.QueryRow(`SELECT title FROM work_title_language WHERE work_id = ? AND language = 'en-us'`, canonical).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Example English revised" {
		t.Fatalf("canonical English title = %q", title)
	}
}
