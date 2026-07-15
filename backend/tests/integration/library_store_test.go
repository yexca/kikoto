package integration_test

import (
	"context"
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
