package httpapi

import (
	"context"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestParseListSearchClauses(t *testing.T) {
	got := parseListSearchClauses(`quiet $tag:耳かき$ circle:"Example Circle" RJ00000001`)
	want := []listSearchClause{
		{Kind: "tag", Value: "耳かき"},
		{Kind: "text", Value: "quiet"},
		{Kind: "circle", Value: "Example Circle"},
		{Kind: "code", Value: "RJ00000001"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseListSearchClauses() = %#v, want %#v", got, want)
	}
}

func TestRemoteAgeSearchUsesProtocolValuesAndSharedAliases(t *testing.T) {
	for _, sourceType := range []string{sourceTypeKikoeruCompatible, sourceTypeKikoeruCompatible178} {
		plan := planRemoteSourceQuery("age:R18", sourceType)
		if plan.PushdownQuery != "$age:adult$" || len(plan.PostFilterClauses) != 0 {
			t.Fatalf("age plan=%+v", plan)
		}
		clauses := []listSearchClause{{Kind: "age", Value: "R18"}}
		for _, age := range []string{"adult", "R-18", "18"} {
			if !remoteWorkSummaryMatchesClauses(remoteWorkSummary{AgeRating: age}, clauses) {
				t.Fatalf("age %q did not match R18", age)
			}
		}
		if remoteWorkSummaryMatchesClauses(remoteWorkSummary{AgeRating: "r15"}, clauses) {
			t.Fatal("R15 matched R18")
		}
		for _, query := range []string{"age:all", "age:全年齢", "age:全年龄"} {
			if got := planRemoteSourceQuery(query, sourceType).PushdownQuery; got != "$age:general$" {
				t.Fatalf("query %q pushdown=%q", query, got)
			}
		}
	}
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	plan := planRemoteSourceQuery(code+" age:R18", sourceTypeKikoeruCompatible178)
	if plan.PushdownQuery != code || len(plan.PostFilterClauses) != 1 || plan.PostFilterClauses[0].Kind != "age" {
		t.Fatalf("compound age plan=%+v", plan)
	}
}

func TestPlanRemoteSourceQueryKeepsStructuredClauses(t *testing.T) {
	plan := planRemoteSourceQuery(`ambient $tag:耳かき$`, sourceTypeKikoeruCompatible178)
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

func TestPlanRemoteSourceQueryPushesCompoundQueryToCompatibleSource(t *testing.T) {
	plan := planRemoteSourceQuery(`ambient $tag:耳かき$ $-tag:男性向け$ $va:Example Voice$`, sourceTypeKikoeruCompatible)
	want := `$tag:耳かき$ $-tag:男性向け$ $va:Example Voice$ ambient`
	if plan.PushdownQuery != want {
		t.Fatalf("PushdownQuery = %q, want %q", plan.PushdownQuery, want)
	}
	if len(plan.PostFilterClauses) != 0 {
		t.Fatalf("PostFilterClauses = %#v, want none", plan.PostFilterClauses)
	}
}

func TestPlanRemoteSourceCodeQueryTrustsCompatibleSourceAliasMatches(t *testing.T) {
	plan := planRemoteSourceQuery(`RJ00000000`, sourceTypeKikoeruCompatible)
	if plan.PushdownQuery != "RJ00000000" {
		t.Fatalf("PushdownQuery = %q, want code query", plan.PushdownQuery)
	}
	if len(plan.PostFilterClauses) != 0 {
		t.Fatalf("PostFilterClauses = %#v, want source-owned alias matching", plan.PostFilterClauses)
	}
}

func TestPlanLimitedRemoteSourceQueryPrioritizesLanguagePushdown(t *testing.T) {
	plan := planRemoteSourceQuery(`RJ00000001 $lang:CHI_HANS$`, sourceTypeKikoeruCompatible178)
	if plan.PushdownQuery != "$lang:CHI_HANS$" {
		t.Fatalf("PushdownQuery = %q, want language clause", plan.PushdownQuery)
	}
	if len(plan.PostFilterClauses) != 1 || plan.PostFilterClauses[0].Kind != "code" {
		t.Fatalf("PostFilterClauses = %#v, want one code clause", plan.PostFilterClauses)
	}
}

func TestLibrarySearchWhereMatchesNormalizedUnicodeTag(t *testing.T) {
	db := openMigratedTestDB(t)
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000002', 'Unicode tag work')")
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
	if err := library.NewStore(db).RefreshSearchIndex(context.Background()); err != nil {
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

// Exclusions reach a compatible source in its own negated syntax, and a source
// that is filtered locally drops the excluded circle or voice rather than
// requiring it.
func TestRemoteSourceQueryExcludesCirclesAndVoices(t *testing.T) {
	plan := planRemoteSourceQuery(`-circle:"Example Circle" -va:"Example Voice"`, sourceTypeKikoeruCompatible)
	if want := `$-circle:Example Circle$ $-va:Example Voice$`; plan.PushdownQuery != want {
		t.Fatalf("PushdownQuery = %q, want %q", plan.PushdownQuery, want)
	}

	clauses := parseListSearchClauses(`-circle:"Example Circle" -va:"Example Voice"`)
	works := []remoteWorkSummary{
		{PrimaryCode: "RJ00000000", Circle: "Example Circle", VoiceActors: []string{"Other Voice"}},
		{PrimaryCode: "RJ00000001", Circle: "Other Group", VoiceActors: []string{"Example Voice"}},
		{PrimaryCode: "RJ00000002", Circle: "Other Group", VoiceActors: []string{"Other Voice"}},
	}
	filtered := filterRemoteWorkSummaries(works, clauses)
	if len(filtered) != 1 || filtered[0].PrimaryCode != "RJ00000002" {
		t.Fatalf("filtered = %#v, want only the work with neither excluded value", filtered)
	}
}
