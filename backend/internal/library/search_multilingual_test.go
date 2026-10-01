package library

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func dlsiteProviderID(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	var id int64
	if err := db.QueryRow(`SELECT id FROM metadata_provider WHERE code = 'dlsite'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// searchEditionFamily links works into one logical family; the first work is
// the canonical edition.
func searchEditionFamily(t *testing.T, db *sql.DB, ordinals []int, workIDs ...int64) int64 {
	t.Helper()
	logicalID := execSearchFixture(t, db, `INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, ?)`,
		workIDs[0], testfixture.WorkCode(testfixture.PrefixRJ, ordinals[0]))
	for index, workID := range workIDs {
		execSearchFixture(t, db, `INSERT INTO work_edition (work_id, logical_work_id, primary_code, is_canonical) VALUES (?, ?, ?, ?)`,
			workID, logicalID, testfixture.WorkCode(testfixture.PrefixRJ, ordinals[index]), index == 0)
	}
	return logicalID
}

func searchVariant(t *testing.T, db *sql.DB, logicalID, workID int64, ordinal int, locale, title string) int64 {
	t.Helper()
	return execSearchFixture(t, db, `INSERT INTO dlsite_metadata_variant (logical_work_id, work_id, provider_id, external_id, request_locale, title)
		VALUES (?, ?, ?, ?, ?, ?)`, logicalID, workID, dlsiteProviderID(t, db), testfixture.WorkCode(testfixture.PrefixRJ, ordinal), locale, title)
}

func searchGenre(t *testing.T, db *sql.DB, workID int64, genreID int64, names map[string]string) {
	t.Helper()
	execSearchFixture(t, db, `INSERT INTO work_dlsite_genre (work_id, genre_id) VALUES (?, ?)`, workID, genreID)
	for language, name := range names {
		execSearchFixture(t, db, `INSERT INTO dlsite_genre_name (genre_id, language, name) VALUES (?, ?, ?)
			ON CONFLICT(genre_id, language) DO UPDATE SET name = excluded.name`, genreID, language, name)
	}
}

func TestSearchFindsOwnVariantTitleAfterPriorityProjection(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	// The priority projection rewrote the canonical title into another language.
	canonical := insertSearchWork(t, db, 10, "Projected simplified title")
	translated := insertSearchWork(t, db, 11, "Projected simplified title")
	logicalID := searchEditionFamily(t, db, []int{10, 11}, canonical, translated)
	variantID := searchVariant(t, db, logicalID, canonical, 10, "ja-jp", "原作タイトル")
	searchVariant(t, db, logicalID, translated, 11, "zh-cn", "Projected simplified title")
	store := NewStore(db)

	assertSearchCodes(t, store, 0, "原作タイトル", 10)

	execSearchFixture(t, db, `UPDATE dlsite_metadata_variant SET title = '改題タイトル' WHERE id = ?`, variantID)
	assertSearchCodes(t, store, 0, "原作タイトル")
	assertSearchCodes(t, store, 0, "改題タイトル", 10)
}

func TestSearchExpandsDLsiteGenreIDsAcrossLanguages(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	girl := insertSearchWork(t, db, 12, "Example One")
	healing := insertSearchWork(t, db, 13, "Example Two")
	tagSearchWork(t, db, girl, "少女")
	tagSearchWork(t, db, healing, "癒し")
	searchGenre(t, db, girl, 206, map[string]string{"ja-jp": "少女", "en-us": "Girl"})
	searchGenre(t, db, healing, 56, map[string]string{"ja-jp": "癒し"})
	store := NewStore(db)

	assertSearchCodes(t, store, 0, "tag:girl", 12)
	assertSearchCodes(t, store, 0, "-tag:girl", 13)
	assertSearchCodes(t, store, 0, "girl", 12)
	assertSearchCodes(t, store, 0, "tag:healing")

	// A name learned later from another work reindexes every work with that id.
	execSearchFixture(t, db, `INSERT INTO dlsite_genre_name (genre_id, language, name) VALUES (56, 'en-us', 'Healing')`)
	assertSearchCodes(t, store, 0, "tag:healing", 13)

	execSearchFixture(t, db, `DELETE FROM work_dlsite_genre WHERE work_id = ?`, girl)
	assertSearchCodes(t, store, 0, "tag:girl")
	assertSearchCodes(t, store, 0, "tag:少女", 12)
}

func TestSearchRanksExactMatchesAheadOfPartialMatches(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	older := insertSearchWork(t, db, 15, "Example One")
	exact := insertSearchWork(t, db, 16, "Example Two")
	insertSearchWork(t, db, 17, "Girl Next Door")
	searchGenre(t, db, older, 220, map[string]string{"ja-jp": "お姉さん", "en-us": "Older Girl"})
	searchGenre(t, db, exact, 206, map[string]string{"ja-jp": "少女", "en-us": "Girl"})
	store := NewStore(db)
	codes := func(ordinals ...int) []string {
		values := []string{}
		for _, ordinal := range ordinals {
			values = append(values, testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
		}
		return values
	}

	for _, tc := range []struct {
		query, sort, direction string
		want                   []string
	}{
		// Matching stays a substring test; the exact tag name only moves first.
		{"tag:girl", "code", "asc", codes(16, 15)},
		{"tag:girl", "code", "desc", codes(16, 15)},
		{"girl", "code", "asc", codes(16, 15, 17)},
		{"girl", "code", "desc", codes(16, 17, 15)},
		{"'girl next door'", "code", "desc", codes(17)},
	} {
		if got := searchCodesSorted(t, store, 0, tc.query, tc.sort, tc.direction); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("search %q sorted %s %s = %v, want %v", tc.query, tc.sort, tc.direction, got, tc.want)
		}
	}
	for _, sort := range []string{"random", "recommend", "recent"} {
		got := searchCodesSorted(t, store, 0, "girl", sort, "desc")
		if len(got) != 3 || got[0] != testfixture.WorkCode(testfixture.PrefixRJ, 16) {
			t.Fatalf("search girl sorted %s = %v, want the exact tag match first of 3", sort, got)
		}
	}
}

func TestMultilingualSearchMigrationsIndexExistingWorks(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	db := openSearchTestDB(t, migrationsBefore(t, migrationDir, "046_work_search_variant_title.sql"))
	projected := insertSearchWork(t, db, 18, "Projected title")
	legacy := insertSearchWork(t, db, 19, "Legacy Example")
	logicalID := searchEditionFamily(t, db, []int{18}, projected)
	searchVariant(t, db, logicalID, projected, 18, "en-us", "Origin title")
	providerID := dlsiteProviderID(t, db)
	snapshot := func(workID int64, ordinal int, locale, fetchedAt, body string) {
		t.Helper()
		execSearchFixture(t, db, `INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json, request_locale, fetched_at)
			VALUES (?, ?, ?, ?, ?, ?)`, workID, providerID, testfixture.WorkCode(testfixture.PrefixRJ, ordinal), body, locale, fetchedAt)
	}
	snapshot(projected, 18, "en-us", "2000-01-01 00:00:00", `{"product":{"genres":[{"id":206,"name":"Stale Girl","name_base":"少女"}]}}`)
	snapshot(projected, 18, "en-us", "2000-01-02 00:00:00", `{"product":{"genres":[{"id":206,"name":"Girl","name_base":"少女"},{"id":"9","name":"Text id"}]}}`)
	snapshot(legacy, 19, "", "2000-01-01 00:00:00", `{"genres":[{"id":56,"name":"癒し","name_base":"癒し"}]}`)

	if err := storage.Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	if err := store.RefreshSearchIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	var genreRows, nameRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_dlsite_genre`).Scan(&genreRows); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM dlsite_genre_name`).Scan(&nameRows); err != nil {
		t.Fatal(err)
	}
	if genreRows != 2 || nameRows != 3 {
		t.Fatalf("backfilled genre rows = %d, names = %d; want 2 and 3", genreRows, nameRows)
	}
	assertSearchCodes(t, store, 0, "origin title", 18)
	assertSearchCodes(t, store, 0, "tag:girl", 18)
	assertSearchCodes(t, store, 0, "tag:少女", 18)
	assertSearchCodes(t, store, 0, "tag:stale")
	assertSearchCodes(t, store, 0, "tag:'text id'")
	assertSearchCodes(t, store, 0, "tag:癒し", 19)
}
