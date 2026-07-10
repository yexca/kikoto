package library

import (
	"reflect"
	"testing"
)

func TestParseSearchClausesSupportsStructuredAndQuotedValues(t *testing.T) {
	want := []SearchClause{
		{Kind: "tag", Value: "耳かき ASMR"},
		{Kind: "voice_actor", Value: "Example Voice"},
		{Kind: "rating_min", Value: "4.5"},
		{Kind: "code", Value: "RJ01234567"},
	}
	got := ParseSearchClauses(`tag:"耳かき ASMR" va:'Example Voice' rating:4.5 RJ01234567`)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSearchClauses() = %#v, want %#v", got, want)
	}
}

func TestParseSearchClausesSupportsWrappedLegacySyntax(t *testing.T) {
	want := []SearchClause{{Kind: "exclude_tag", Value: "男性向け"}}
	if got := ParseSearchClauses(`$-tag:男性向け$`); !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSearchClauses() = %#v, want %#v", got, want)
	}
}

func TestNumericClauseValueIgnoresUnits(t *testing.T) {
	if got := NumericClauseValue("4.75 stars"); got != 4.75 {
		t.Fatalf("NumericClauseValue() = %v, want 4.75", got)
	}
}
