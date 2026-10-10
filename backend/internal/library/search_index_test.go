package library

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

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

// migrationsBefore copies the numbered migrations that sort before filename
// into a temporary directory, so a test can build the previous schema.
func migrationsBefore(t *testing.T, migrationDir string, filename string) string {
	t.Helper()
	previousDir := t.TempDir()
	entries, err := os.ReadDir(migrationDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() >= filename {
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
	return previousDir
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

func TestSearchIndexesEveryTitleLanguageAndTracksScopedResets(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	id := insertSearchWork(t, db, 0, "【简体中文版】Example display title")
	execSearchFixture(t, db, `INSERT INTO work_manual_override(work_id,field_name,language,value_json) VALUES (?,'title','ja-jp','"Example Japanese manual"'),(?,'title','ko-kr','"Example Korean manual"')`, id, id)
	store := NewStore(db)
	assertSearchCodes(t, store, 0, "'Example Japanese manual'", 0)
	assertSearchCodes(t, store, 0, "'Example Korean manual'", 0)
	assertSearchCodes(t, store, 0, "'Example display title'", 0)
	execSearchFixture(t, db, `UPDATE work_manual_override SET value_json='"Example revised Korean"' WHERE work_id=? AND language='ko-kr'`, id)
	assertSearchCodes(t, store, 0, "'Example revised Korean'", 0)
	assertSearchCodes(t, store, 0, "'Example Korean manual'")
	execSearchFixture(t, db, `DELETE FROM work_manual_override WHERE work_id=? AND language='ja-jp'`, id)
	assertSearchCodes(t, store, 0, "'Example Japanese manual'")
	assertSearchCodes(t, store, 0, "'Example revised Korean'", 0)
}

func tagSearchWork(t *testing.T, db *sql.DB, workID int64, name string) int64 {
	t.Helper()
	tagID := execSearchFixture(t, db, `INSERT INTO tag (namespace, normalized_name, display_name, language) VALUES ('dlsite', ?, ?, 'ja_JP')`, name, name)
	execSearchFixture(t, db, `INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'dlsite')`, workID, tagID)
	return tagID
}

func searchCodes(t *testing.T, store *Store, userID int64, query string) []string {
	t.Helper()
	return searchCodesSorted(t, store, userID, query, "code", "asc")
}

func searchCodesSorted(t *testing.T, store *Store, userID int64, query string, sort string, direction string) []string {
	t.Helper()
	page, err := store.ListPage(context.Background(), ListOptions{UserID: userID, Query: query, Sort: sort, Direction: direction, PageSize: 100})
	if err != nil {
		t.Fatalf("ListPage(%q, %s %s): %v", query, sort, direction, err)
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
	db := openSearchTestDB(t, migrationsBefore(t, migrationDir, searchIndexMigration))
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

func TestSearchLeavesLongQueueToBackgroundWorker(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	backlog := searchIndexInlineLimit + 1
	ordinals := make([]int, 0, backlog)
	for ordinal := range backlog {
		insertSearchWork(t, db, ordinal, "Backlog Example")
		ordinals = append(ordinals, ordinal)
	}
	store := NewStore(db)
	pending := func() int {
		t.Helper()
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM work_search_dirty`).Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}

	// The request reads the previous index state instead of rebuilding the
	// backlog, and asks the worker for a pass.
	assertSearchCodes(t, store, 0, "backlog")
	if got := pending(); got != backlog {
		t.Fatalf("pending search documents after search = %d, want %d", got, backlog)
	}
	if len(store.searchIndexWake) != 1 {
		t.Fatal("search did not wake the search index worker")
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		store.RunSearchIndexWorker(ctx)
	}()
	deadline := time.Now().Add(10 * time.Second)
	for pending() > 0 {
		if time.Now().After(deadline) {
			t.Fatal("search index worker did not drain the queue")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	assertSearchCodes(t, store, 0, "backlog", ordinals...)
}

// A leading "-" excludes on the circle and voice actor fields exactly as it does
// on tags, and a quoted phrase is one needle rather than independent words.
func TestSearchExcludesCirclesAndVoicesAndKeepsQuotedPhrasesWhole(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	credited := insertSearchWork(t, db, 6, "Example calm night")
	other := insertSearchWork(t, db, 7, "Example night calm")
	personID := execSearchFixture(t, db, `INSERT INTO person (display_name) VALUES ('Example Voice')`)
	execSearchFixture(t, db, `INSERT INTO work_credit (work_id, person_id, role) VALUES (?, ?, 'voice_actor')`, credited, personID)
	circleID := execSearchFixture(t, db, `INSERT INTO party (display_name) VALUES ('Example Circle')`)
	execSearchFixture(t, db, `INSERT INTO work_party (work_id, party_id, role, source) VALUES (?, ?, 'circle', 'test')`, credited, circleID)
	otherCircleID := execSearchFixture(t, db, `INSERT INTO party (display_name) VALUES ('Other Group')`)
	execSearchFixture(t, db, `INSERT INTO work_party (work_id, party_id, role, source) VALUES (?, ?, 'circle', 'test')`, other, otherCircleID)
	store := NewStore(db)

	for _, tc := range []struct {
		query    string
		ordinals []int
	}{
		{`va:"Example Voice"`, []int{6}},
		{`-va:"Example Voice"`, []int{7}},
		{`$-va:Example Voice$`, []int{7}},
		{`-voice:"Example Voice"`, []int{7}},
		{`circle:"Example Circle"`, []int{6}},
		{`-circle:"Example Circle"`, []int{7}},
		{`$-circle:Example Circle$`, []int{7}},
		{`-circle:"Example Circle" -va:"Example Voice"`, []int{7}},
		{`-circle:"Other Group" -va:"Example Voice"`, nil},
		{`calm night`, []int{6, 7}},
		{`"calm night"`, []int{6}},
		{`'night calm'`, []int{7}},
	} {
		assertSearchCodes(t, store, 0, tc.query, tc.ordinals...)
	}
}
