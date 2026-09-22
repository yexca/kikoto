package library

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

const searchIndexMigration = "036_work_search_index.sql"

func openSearchTestDB(t *testing.T, migrationDir string) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "search.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}
	return db
}

func execSearchFixture(t *testing.T, db *sql.DB, query string, args ...any) int64 {
	t.Helper()
	result, err := db.Exec(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func insertSearchWork(t *testing.T, db *sql.DB, ordinal int, title string) int64 {
	t.Helper()
	return execSearchFixture(t, db, `INSERT INTO work (primary_code, title) VALUES (?, ?)`, testfixture.WorkCode(testfixture.PrefixRJ, ordinal), title)
}

func tagSearchWork(t *testing.T, db *sql.DB, workID int64, name string) int64 {
	t.Helper()
	tagID := execSearchFixture(t, db, `INSERT INTO tag (namespace, normalized_name, display_name, language) VALUES ('dlsite', ?, ?, 'ja_JP')`, name, name)
	execSearchFixture(t, db, `INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'dlsite')`, workID, tagID)
	return tagID
}

func searchCodes(t *testing.T, store *Store, userID int64, query string) []string {
	t.Helper()
	page, err := store.ListPage(context.Background(), ListOptions{UserID: userID, Query: query, Sort: "code", Direction: "asc", PageSize: 100})
	if err != nil {
		t.Fatalf("ListPage(%q): %v", query, err)
	}
	codes := []string{}
	for _, work := range page.Works {
		codes = append(codes, work.PrimaryCode)
	}
	if page.Total != len(codes) {
		t.Fatalf("ListPage(%q) total = %d, want %d", query, page.Total, len(codes))
	}
	return codes
}

func assertSearchCodes(t *testing.T, store *Store, userID int64, query string, ordinals ...int) {
	t.Helper()
	want := []string{}
	for _, ordinal := range ordinals {
		want = append(want, testfixture.WorkCode(testfixture.PrefixRJ, ordinal))
	}
	if got := searchCodes(t, store, userID, query); !reflect.DeepEqual(got, want) {
		t.Fatalf("search %q = %v, want %v", query, got, want)
	}
}

func TestSearchMatchesWildcardAndSyntaxCharactersLiterally(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	insertSearchWork(t, db, 0, "Example 100% Voice")
	insertSearchWork(t, db, 1, "Example 1000 Voice")
	insertSearchWork(t, db, 2, "Example a_b")
	insertSearchWork(t, db, 3, "Example axb")
	store := NewStore(db)

	for _, tc := range []struct {
		query    string
		ordinals []int
	}{
		{"100%", []int{0}},
		{"0%", []int{0}},
		{"a_b", []int{2}},
		{"_", []int{2}},
		{"Example*", nil},
		{`'Voice" OR "Example'`, nil},
	} {
		assertSearchCodes(t, store, 0, tc.query, tc.ordinals...)
	}
}

func TestSearchFoldsWidthCaseAndKana(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	userID := execSearchFixture(t, db, `INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-user', 'Example User', 'user')`)
	whisper := insertSearchWork(t, db, 4, "ささやきボイス")
	other := insertSearchWork(t, db, 5, "Other Work")
	tagSearchWork(t, db, whisper, "癒し")
	personID := execSearchFixture(t, db, `INSERT INTO person (display_name) VALUES ('Example Voice')`)
	execSearchFixture(t, db, `INSERT INTO work_credit (work_id, person_id, role) VALUES (?, ?, 'voice_actor')`, whisper, personID)
	userTagID := execSearchFixture(t, db, `INSERT INTO user_tag (user_id, name) VALUES (?, 'ボイス集')`, userID)
	execSearchFixture(t, db, `INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (?, ?, ?)`, userID, other, userTagID)
	store := NewStore(db)

	for _, tc := range []struct {
		query    string
		ordinals []int
	}{
		{"ササヤキ", []int{4}},
		{"ｻｻﾔｷ", []int{4}},
		{"va:'ＥＸＡＭＰＬＥ　ｖｏｉｃｅ'", []int{4}},
		{"tag:癒し", []int{4}},
		{"tag: いやし", nil},
		{"-tag:癒し", []int{5}},
		{"mytag:ぼいす", []int{5}},
		{"ぼいす", []int{4, 5}},
	} {
		assertSearchCodes(t, store, userID, tc.query, tc.ordinals...)
	}
}

func TestSearchIndexFollowsMetadataChangesAcrossEditionFamily(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	canonical := insertSearchWork(t, db, 6, "Canonical Example")
	translated := insertSearchWork(t, db, 7, "Translated Example")
	logicalID := execSearchFixture(t, db, `INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, ?)`, canonical, testfixture.WorkCode(testfixture.PrefixRJ, 6))
	execSearchFixture(t, db, `INSERT INTO work_edition (work_id, logical_work_id, primary_code, is_canonical) VALUES (?, ?, ?, 1), (?, ?, ?, 0)`,
		canonical, logicalID, testfixture.WorkCode(testfixture.PrefixRJ, 6),
		translated, logicalID, testfixture.WorkCode(testfixture.PrefixRJ, 7))
	tagID := tagSearchWork(t, db, translated, "癒し")
	partyID := execSearchFixture(t, db, `INSERT INTO party (display_name) VALUES ('Example Circle')`)
	execSearchFixture(t, db, `INSERT INTO work_party (work_id, party_id, role) VALUES (?, ?, 'circle')`, translated, partyID)
	store := NewStore(db)

	// Sibling-edition metadata finds the visible canonical edition.
	assertSearchCodes(t, store, 0, "circle:'example circle'", 6)
	assertSearchCodes(t, store, 0, "tag:癒し", 6)

	execSearchFixture(t, db, `UPDATE tag SET display_name = '安眠' WHERE id = ?`, tagID)
	execSearchFixture(t, db, `UPDATE party SET display_name = 'Renamed Circle' WHERE id = ?`, partyID)
	execSearchFixture(t, db, `INSERT INTO work_manual_override (work_id, field_name, value_json) VALUES (?, 'voice_actors', '[{"name":"Override Person","personId":0}]')`, canonical)
	assertSearchCodes(t, store, 0, "tag:癒し")
	assertSearchCodes(t, store, 0, "tag:安眠", 6)
	assertSearchCodes(t, store, 0, "circle:example")
	assertSearchCodes(t, store, 0, "circle:renamed", 6)
	assertSearchCodes(t, store, 0, "va:'override person'", 6)
	// Only JSON string values are indexed, not keys such as "name".
	assertSearchCodes(t, store, 0, "va:name")

	execSearchFixture(t, db, `DELETE FROM work_tag WHERE tag_id = ?`, tagID)
	assertSearchCodes(t, store, 0, "tag:安眠")
}

func TestSearchIndexMigrationIndexesExistingWorks(t *testing.T) {
	migrationDir := filepath.Join("..", "..", "migrations")
	previousDir := t.TempDir()
	entries, err := os.ReadDir(migrationDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() >= searchIndexMigration {
			continue
		}
		contents, err := os.ReadFile(filepath.Join(migrationDir, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(previousDir, entry.Name()), contents, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	db := openSearchTestDB(t, previousDir)
	workID := insertSearchWork(t, db, 8, "Existing Example")
	tagSearchWork(t, db, workID, "癒し")

	if err := storage.Migrate(db, migrationDir); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	if err := store.RefreshSearchIndex(context.Background()); err != nil {
		t.Fatal(err)
	}
	var pending int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_search_dirty`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 0 {
		t.Fatalf("pending search documents = %d, want 0 after refresh", pending)
	}
	assertSearchCodes(t, store, 0, "tag:癒し", 8)
	assertSearchCodes(t, store, 0, "existing", 8)
}
