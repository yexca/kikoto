package library

import (
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestParseSearchClausesSupportsStructuredAndQuotedValues(t *testing.T) {
	want := []SearchClause{
		{Kind: "tag", Value: "耳かき ASMR"},
		{Kind: "voice_actor", Value: "Example Voice"},
		{Kind: "rating_min", Value: "4.5"},
		{Kind: "code", Value: "RJ00000000"},
	}
	got := ParseSearchClauses(`tag:"耳かき ASMR" va:'Example Voice' rating:4.5 RJ00000000`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSearchClauses() = %#v, want %#v", got, want)
	}
}

func TestParseSearchClausesRecognizesSupportedWorkCodePrefixes(t *testing.T) {
	for _, prefix := range []testfixture.WorkCodePrefix{
		testfixture.PrefixRJ,
		testfixture.PrefixBJ,
		testfixture.PrefixVJ,
		testfixture.PrefixCC,
	} {
		code := testfixture.WorkCode(prefix, 0)
		query := strings.ToLower(code)
		if got := ParseSearchClauses(query); !reflect.DeepEqual(got, []SearchClause{{Kind: "code", Value: query}}) {
			t.Fatalf("ParseSearchClauses(%q) = %#v", code, got)
		}
	}
	if got := ParseSearchClauses("RJ0000"); !reflect.DeepEqual(got, []SearchClause{{Kind: "text", Value: "RJ0000"}}) {
		t.Fatalf("four-digit work code parsed as code: %#v", got)
	}
}

func TestParseSearchClausesSupportsWrappedLegacySyntax(t *testing.T) {
	want := []SearchClause{{Kind: "exclude_tag", Value: "男性向け"}}
	if got := ParseSearchClauses(`$-tag:男性向け$`); !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSearchClauses() = %#v, want %#v", got, want)
	}
}

func TestParseSearchClausesSupportsPersonalTags(t *testing.T) {
	want := []SearchClause{
		{Kind: "user_tag", Value: "Sleep aid"},
		{Kind: "exclude_user_tag", Value: "Archived"},
	}
	if got := ParseSearchClauses(`mytag:"Sleep aid" -mytag:Archived`); !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSearchClauses() = %#v, want %#v", got, want)
	}
}

func TestParseSearchClausesSupportsShelfMembership(t *testing.T) {
	want := []SearchClause{{Kind: "shelf", Value: "true"}}
	if got := ParseSearchClauses(`shelf:true`); !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSearchClauses() = %#v, want %#v", got, want)
	}

	where, args := SearchWhereForUser(`shelf:true`, 42)
	if !strings.Contains(where, "user_work_state.listening_status") || !strings.Contains(where, "search_shelf_list.kind = 'user'") {
		t.Fatalf("shelf predicate = %s", where)
	}
	if strings.Contains(where, "user_work_playback_cursor") || strings.Contains(where, "user_work_state.favorite") {
		t.Fatalf("shelf predicate must not use playback or favorite summaries: %s", where)
	}
	if !reflect.DeepEqual(args, []any{int64(42)}) {
		t.Fatalf("shelf args = %#v, want [42]", args)
	}
}

func TestNumericClauseValueIgnoresUnits(t *testing.T) {
	if got := NumericClauseValue("4.75 stars"); got != 4.75 {
		t.Fatalf("NumericClauseValue() = %v, want 4.75", got)
	}
}

func TestCodeAndTextSearchPredicatesAvoidRawMetadataSnapshots(t *testing.T) {
	for _, query := range []string{"RJ00000000", "Example title"} {
		where, _ := SearchWhereForUser(query, 42)
		lower := strings.ToLower(where)
		if strings.Contains(lower, "metadata_snapshot") || strings.Contains(lower, "snapshot_json") {
			t.Fatalf("SearchWhereForUser(%q) reads raw metadata snapshots: %s", query, where)
		}
	}
}

func TestCodeSearchUsesExactNormalizedAliases(t *testing.T) {
	where, args := SearchWhere("rj00000000")
	if !strings.Contains(where, "work_code_alias") || strings.Contains(where, " LIKE ") {
		t.Fatalf("code predicate = %s", where)
	}
	want := []any{"RJ00000000", "RJ00000000", "RJ00000000", "RJ00000000"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("code args = %#v, want %#v", args, want)
	}
}
