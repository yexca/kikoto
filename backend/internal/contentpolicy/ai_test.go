package contentpolicy

import (
	"strings"
	"testing"
)

func TestAIContentRulesUseTheHighestRestriction(t *testing.T) {
	for _, tc := range []struct {
		name, age, want string
		policy          Policy
	}{
		{"adult baseline", "adult", "sensitive", Policy{}},
		{"restricted all ages", "general", "restricted", Policy{Keywords: []KeywordRule{{ID: "high", Term: "synthetic marker", Fields: []string{"description"}, Action: "restricted"}}}},
		{"restricted tag", "general", "restricted", Policy{TagRules: []TagRule{{TagID: 1, Action: "restricted"}}}},
		{"blocked tag", "general", "blocked", Policy{TagRules: []TagRule{{TagID: 1, Action: "blocked"}}}},
		{"block beats high", "adult", "blocked", Policy{TagRules: []TagRule{{TagID: 1, Action: "restricted"}}, Keywords: []KeywordRule{{ID: "deny", Term: "synthetic marker", Fields: []string{"description"}, Action: "blocked"}}}},
		{"unknown is not promoted", "", "unknown", Policy{TagRules: []TagRule{{TagID: 1, Action: "restricted"}}}},
		{"unknown blocked", "", "blocked", Policy{TagRules: []TagRule{{TagID: 1, Action: "blocked"}}}},
		{"ordinary all ages shortcut", "general", "safe", Policy{Keywords: []KeywordRule{{ID: "sensitive", Term: "synthetic marker", Fields: []string{"description"}, Action: "sensitive"}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := tc.policy.Assess(tc.age, map[string]string{"description": "Synthetic marker"}, []int64{1})
			if result.Class != tc.want {
				t.Fatalf("assessment=%+v want=%s", result, tc.want)
			}
			if tc.want == "restricted" && (len(result.Matches) == 0 || result.Matches[0].Action != "restricted") {
				t.Fatalf("missing evidence: %+v", result)
			}
		})
	}
}

func TestAIContentMaximumDefaultsToSafe(t *testing.T) {
	for _, tc := range []struct {
		maximum, want string
	}{
		{"", "safe"}, {"safe", "safe"}, {"sensitive", "sensitive"}, {"restricted", "restricted"},
	} {
		got, err := NormalizeMaxClass(tc.maximum)
		if err != nil || got != tc.want {
			t.Fatalf("%+v: %q %v", tc, got, err)
		}
	}
	for _, maximum := range []string{"blocked", "unknown", "invalid", " Sensitive "} {
		if _, err := NormalizeMaxClass(maximum); err == nil {
			t.Fatalf("invalid maximum %q accepted", maximum)
		}
	}
	for _, class := range []string{"safe", "sensitive", "restricted", "unknown", "blocked", "invalid"} {
		for _, maximum := range []string{"safe", "sensitive", "restricted", "unknown", "blocked", "invalid", ""} {
			rank := map[string]int{"safe": 1, "sensitive": 2, "restricted": 3}
			want := rank[class] > 0 && rank[maximum] > 0 && rank[class] <= rank[maximum]
			if Allows(class, maximum) != want {
				t.Fatalf("Allows(%q,%q)", class, maximum)
			}
		}
	}
}

func TestAIContentTagRulesNormalizeAndRejectAmbiguity(t *testing.T) {
	normalized, err := (Policy{TagRules: []TagRule{{TagID: 1, Action: "sensitive"}, {TagID: 1, Action: "sensitive"}}}).Validate()
	if err != nil || len(normalized.TagRules) != 1 || normalized.TagRules[0] != (TagRule{TagID: 1, Action: "sensitive"}) {
		t.Fatalf("normalized=%+v err=%v", normalized, err)
	}
	for _, p := range []Policy{
		{TagRules: []TagRule{{TagID: 0, Action: "restricted"}}},
		{TagRules: []TagRule{{TagID: 1, Action: "safe"}}},
		{TagRules: []TagRule{{TagID: 1, Action: "restricted"}, {TagID: 1, Action: "sensitive"}}},
		{TagRules: make([]TagRule, 513)},
	} {
		if _, err := p.Validate(); err == nil {
			t.Fatalf("invalid policy accepted: %+v", p)
		}
	}
	p := Policy{Keywords: []KeywordRule{{ID: "lyrics-high", Term: "synthetic marker", Fields: []string{"lyrics"}, Action: "restricted"}}}
	result := p.Assess("general", map[string]string{"lyrics": strings.Repeat("line\n", 39) + "synthetic\nmarker"}, nil)
	if result.Class != "restricted" || len(result.Matches) != 1 || result.Matches[0].Field != "lyrics" {
		t.Fatalf("lyrics assessment=%+v", result)
	}
}
