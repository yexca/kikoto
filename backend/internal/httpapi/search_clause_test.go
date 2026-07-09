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
