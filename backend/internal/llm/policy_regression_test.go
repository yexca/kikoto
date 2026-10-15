package llm

import (
	"strings"
	"testing"
)

func TestBlockingRuleHasIdentityAndWinsOverTag(t *testing.T) {
	p := Policy{TagRules: []TagRule{{TagID: 1, Action: "sensitive"}}, Keywords: []KeywordRule{
		{ID: "title-sensitive", Term: "example", Fields: []string{"title"}, Action: "sensitive"},
		{ID: "description-blocked", Term: "example", Fields: []string{"description"}, Action: "blocked"},
	}}
	got := p.Assess("general", map[string]string{"title": "example", "description": "example"}, []int64{1})
	if got.Class != "blocked" || len(got.Matches) != 2 || got.Matches[1].Rule != "description-blocked" {
		t.Fatalf("assessment=%+v", got)
	}
	got = p.Assess("general", map[string]string{"title": "example"}, nil)
	if got.Class != "safe" {
		t.Fatalf("different scope borrowed blocked action: %+v", got)
	}
}
func TestPolicyInvalidConfigurationIsRejected(t *testing.T) {
	for _, rule := range []KeywordRule{
		{ID: "long", Term: strings.Repeat("x", 257), Fields: []string{"all"}, Action: "sensitive"},
		{ID: "field", Term: "example", Fields: []string{"unknown"}, Action: "sensitive"},
		{ID: "action", Term: "example", Fields: []string{"all"}, Action: "invalid"},
		{ID: "empty-fields", Term: "example", Fields: nil, Action: "sensitive"},
		{Term: "example", Fields: []string{"all"}, Action: "sensitive"},
	} {
		if _, err := (Policy{Keywords: []KeywordRule{rule}}).Validate(); err == nil {
			t.Fatalf("invalid rule accepted: %+v", rule)
		}
	}
	rules := make([]KeywordRule, 513)
	if _, err := (Policy{Keywords: rules}).Validate(); err == nil {
		t.Fatal("rule limit ignored")
	}
	for _, age := range []string{"not-adult", "unknown-r18", "R18 extra", ""} {
		if got := (Policy{}).Assess(age, nil, nil); got.Class != "unknown" {
			t.Fatalf("age %q classified %q", age, got.Class)
		}
	}
}
