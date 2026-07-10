package httpapi

import (
	"reflect"
	"testing"
)

func TestParseListSearchClauses(t *testing.T) {
	got := parseListSearchClauses(`quiet $tag:耳かき$ circle:"Example Circle" RJ01234567`)
	want := []listSearchClause{
		{Kind: "tag", Value: "耳かき"},
		{Kind: "text", Value: "quiet"},
		{Kind: "circle", Value: "Example Circle"},
		{Kind: "code", Value: "RJ01234567"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseListSearchClauses() = %#v, want %#v", got, want)
	}
}

func TestPlanRemoteSourceQueryKeepsStructuredClauses(t *testing.T) {
	plan := planRemoteSourceQuery(`ambient $tag:耳かき$`)
	if plan.PushdownQuery != "$tag:耳かき$" {
		t.Fatalf("PushdownQuery = %q, want %q", plan.PushdownQuery, "$tag:耳かき$")
	}
	if plan.PushdownClause == nil || plan.PushdownClause.Kind != "tag" {
		t.Fatalf("PushdownClause = %#v, want tag clause", plan.PushdownClause)
	}
	if len(plan.PostFilterClauses) != 1 || plan.PostFilterClauses[0].Kind != "text" {
		t.Fatalf("PostFilterClauses = %#v, want one text clause", plan.PostFilterClauses)
	}
}

func TestLibrarySearchWhereMatchesNormalizedUnicodeTag(t *testing.T) {
	db := openMigratedTestDB(t)
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999999', 'Unicode tag work')")
	if err != nil {
		t.Fatal(err)
	}
	workID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	result, err = db.Exec(`
		INSERT INTO tag (namespace, normalized_name, display_name, language)
		VALUES ('dlsite', '耳かき', '耳かき', 'ja_JP')
	`)
	if err != nil {
		t.Fatal(err)
	}
	tagID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'dlsite')", workID, tagID); err != nil {
		t.Fatal(err)
	}

	where, args := librarySearchWhere("$tag:耳かき$")
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE "+where, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("tag search count = %d, want 1", count)
	}

	where, args = librarySearchWhere("$-tag:耳かき$")
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE id = ? AND "+where, append([]any{workID}, args...)...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("excluded tag search count = %d, want 0", count)
	}
}
