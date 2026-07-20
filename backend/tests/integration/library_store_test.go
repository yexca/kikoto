package integration_test

import (
	"context"
	"database/sql"
	"fmt"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
)

func TestStoreListPageFiltersScopeAndSearch(t *testing.T) {
	db := openMigratedTestDB(t, "library.db")
	var err error
	first, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ01234567', 'Local work')")
	if err != nil {
		t.Fatal(err)
	}
	localWorkID, _ := first.LastInsertId()
	if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ07654321', 'Database work')"); err != nil {
		t.Fatal(err)
	}
	source, err := db.Exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('test-local', 'Test local', 'local')")
	if err != nil {
		t.Fatal(err)
	}
	sourceID, _ := source.LastInsertId()
	if _, err := db.Exec("INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (?, ?, 'local', 'available')", localWorkID, sourceID); err != nil {
		t.Fatal(err)
	}

	page, err := library.NewStore(db).ListPage(context.Background(), library.ListOptions{
		Page: 1, PageSize: 24, Scope: "local", Query: "RJ01234567", Sort: "code", Direction: "asc",
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].PrimaryCode != "RJ01234567" {
		t.Fatalf("ListPage() = total %d, works %#v", page.Total, page.Works)
	}
	if page.Works[0].SourcePresence == "" {
		t.Fatal("ListPage() omitted source presence")
	}
}

func TestStoreListPageSearchesCurrentUsersTags(t *testing.T) {
	db := openMigratedTestDB(t, "user-tags.db")
	var err error
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('search-user', 'Search User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999003', 'Ordinary title')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	tagResult, err := db.Exec("INSERT INTO user_tag (user_id, name) VALUES (?, 'Sleep aid')", userID)
	if err != nil {
		t.Fatal(err)
	}
	tagID, _ := tagResult.LastInsertId()
	if _, err := db.Exec("INSERT INTO user_work_tag (user_id, work_id, user_tag_id) VALUES (?, ?, ?)", userID, workID, tagID); err != nil {
		t.Fatal(err)
	}
	store := library.NewStore(db)
	for _, query := range []string{`mytag:"Sleep aid"`, "Sleep aid"} {
		page, err := store.ListPage(context.Background(), library.ListOptions{UserID: userID, Page: 1, PageSize: 24, Query: query})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 1 || len(page.Works) != 1 || page.Works[0].ID != workID {
			t.Fatalf("ListPage(%q) = total %d, works %#v", query, page.Total, page.Works)
		}
	}
}

func TestStoreListPageSearchesDeclaredCodeAliasesWithoutRawSnapshots(t *testing.T) {
	db := openMigratedTestDB(t, "code-aliases.db")
	providerID := testMetadataProviderID(t, db)
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09992001', 'Canonical title')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	logicalResult, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ09992001')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalWorkID, _ := logicalResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, is_canonical)
		VALUES (?, ?, ?, 'RJ09992001', 1)
	`, workID, logicalWorkID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_code_alias (logical_work_id, provider_id, primary_code, metadata_language, edition_label)
		VALUES (?, ?, 'RJ09992002', 'ENG', 'English')
	`, logicalWorkID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (?, ?, 'RJ09992001', '{"internal_only":"RawSnapshotNeedle"}')
	`, workID, providerID); err != nil {
		t.Fatal(err)
	}

	store := library.NewStore(db)
	page, err := store.ListPage(context.Background(), library.ListOptions{Page: 1, PageSize: 24, Query: "RJ09992002"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].ID != workID {
		t.Fatalf("alias search = total %d, works %#v", page.Total, page.Works)
	}
	page, err = store.ListPage(context.Background(), library.ListOptions{Page: 1, PageSize: 24, Query: "RawSnapshotNeedle"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 || len(page.Works) != 0 {
		t.Fatalf("raw snapshot search = total %d, works %#v", page.Total, page.Works)
	}
}

func TestStoreListPageSearchesNormalizedFamilyRelations(t *testing.T) {
	db := openMigratedTestDB(t, "family-search.db")
	providerID := testMetadataProviderID(t, db)
	canonicalResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09993001', 'Canonical title')")
	if err != nil {
		t.Fatal(err)
	}
	canonicalID, _ := canonicalResult.LastInsertId()
	siblingResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09993002', 'Translated title')")
	if err != nil {
		t.Fatal(err)
	}
	siblingID, _ := siblingResult.LastInsertId()
	logicalResult, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ09993001')", canonicalID)
	if err != nil {
		t.Fatal(err)
	}
	logicalWorkID, _ := logicalResult.LastInsertId()
	for _, item := range []struct {
		workID int64
		code   string
		base   string
		canon  int
	}{{canonicalID, "RJ09993001", "", 1}, {siblingID, "RJ09993002", "RJ09993001", 0}} {
		if _, err := db.Exec(`
			INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, is_canonical)
			VALUES (?, ?, ?, ?, ?, ?)
		`, item.workID, logicalWorkID, providerID, item.code, item.base, item.canon); err != nil {
			t.Fatal(err)
		}
	}
	partyResult, err := db.Exec("INSERT INTO party (display_name) VALUES ('Normalized Circle')")
	if err != nil {
		t.Fatal(err)
	}
	partyID, _ := partyResult.LastInsertId()
	if _, err := db.Exec("INSERT INTO work_party (work_id, party_id, role) VALUES (?, ?, 'circle')", siblingID, partyID); err != nil {
		t.Fatal(err)
	}
	personResult, err := db.Exec("INSERT INTO person (display_name) VALUES ('Normalized Voice')")
	if err != nil {
		t.Fatal(err)
	}
	personID, _ := personResult.LastInsertId()
	if _, err := db.Exec("INSERT INTO work_credit (work_id, person_id, role) VALUES (?, ?, 'voice_actor')", siblingID, personID); err != nil {
		t.Fatal(err)
	}
	tagResult, err := db.Exec("INSERT INTO tag (namespace, normalized_name, display_name) VALUES ('dlsite', 'normalized-tag', 'Normalized Tag')")
	if err != nil {
		t.Fatal(err)
	}
	tagID, _ := tagResult.LastInsertId()
	if _, err := db.Exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'test')", siblingID, tagID); err != nil {
		t.Fatal(err)
	}

	store := library.NewStore(db)
	for _, query := range []string{"Normalized Circle", "Normalized Voice", "Normalized Tag"} {
		page, err := store.ListPage(context.Background(), library.ListOptions{Page: 1, PageSize: 24, Query: query})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 1 || len(page.Works) != 1 || page.Works[0].ID != canonicalID {
			t.Fatalf("family search %q = total %d, works %#v", query, page.Total, page.Works)
		}
	}
}

func testMetadataProviderID(t *testing.T, db interface {
	QueryRow(query string, args ...any) *sql.Row
}) int64 {
	t.Helper()
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	return providerID
}

func TestStoreListPageRandomSortIsStableForSeed(t *testing.T) {
	db := openMigratedTestDB(t, "random.db")
	for index := 1; index <= 12; index++ {
		if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", fmt.Sprintf("RJ0999%04d", index), fmt.Sprintf("Work %d", index)); err != nil {
			t.Fatal(err)
		}
	}
	load := func(seed int64) []string {
		codes := []string{}
		for pageNumber := 1; pageNumber <= 3; pageNumber++ {
			page, err := library.NewStore(db).ListPage(context.Background(), library.ListOptions{Page: pageNumber, PageSize: 4, Sort: "random", RandomSeed: seed})
			if err != nil {
				t.Fatal(err)
			}
			for _, work := range page.Works {
				codes = append(codes, work.PrimaryCode)
			}
		}
		return codes
	}
	first := load(11)
	second := load(11)
	different := load(29)
	if fmt.Sprint(first) != fmt.Sprint(second) {
		t.Fatalf("same seed changed order: %v != %v", first, second)
	}
	if fmt.Sprint(first) == fmt.Sprint(different) {
		t.Fatalf("different seeds produced the same order: %v", first)
	}
	seen := map[string]bool{}
	for _, code := range first {
		seen[code] = true
	}
	if len(seen) != 12 {
		t.Fatalf("random pagination returned %d unique works, want 12: %v", len(seen), first)
	}
}

func TestStoreListPageRecommendSortUsesPositiveHistory(t *testing.T) {
	db := openMigratedTestDB(t, "recommend.db")
	var err error
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('recommend-user', 'Recommend User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workIDs := map[string]int64{}
	for _, item := range []struct{ code, title string }{{"RJ09999101", "Liked"}, {"RJ09999102", "Candidate"}, {"RJ09999103", "Unrelated"}} {
		result, insertErr := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", item.code, item.title)
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		workIDs[item.code], _ = result.LastInsertId()
	}
	if _, err := db.Exec("INSERT INTO user_work_state (user_id, work_id, listening_status) VALUES (?, ?, 'relisten')", userID, workIDs["RJ09999101"]); err != nil {
		t.Fatal(err)
	}
	tagResult, err := db.Exec("INSERT INTO tag (namespace, normalized_name, display_name) VALUES ('dlsite', 'sleep', 'Sleep')")
	if err != nil {
		t.Fatal(err)
	}
	tagID, _ := tagResult.LastInsertId()
	for _, code := range []string{"RJ09999101", "RJ09999102"} {
		if _, err := db.Exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'test')", workIDs[code], tagID); err != nil {
			t.Fatal(err)
		}
	}
	page, err := library.NewStore(db).ListPage(context.Background(), library.ListOptions{UserID: userID, Page: 1, PageSize: 3, Sort: "recommend", Direction: "desc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Works) != 3 || page.Works[0].PrimaryCode != "RJ09999102" {
		t.Fatalf("recommend order = %#v, want candidate first", page.Works)
	}
}

func TestStoreListPageNormalizesPagination(t *testing.T) {
	db := openMigratedTestDB(t, "pagination.db")
	page, err := library.NewStore(db).ListPage(context.Background(), library.ListOptions{Page: -1, PageSize: 1000})
	if err != nil {
		t.Fatal(err)
	}
	if page.Page != 1 || page.PageSize != 24 {
		t.Fatalf("ListPage() normalized to page %d size %d, want 1 and 24", page.Page, page.PageSize)
	}
}
