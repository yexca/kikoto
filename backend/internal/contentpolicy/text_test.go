package contentpolicy

import "testing"

func TestTranslationTextChecksEveryApplicableKeywordLevel(t *testing.T) {
	for _, action := range []string{"sensitive", "restricted", "blocked"} {
		t.Run(action, func(t *testing.T) {
			policy := Policy{
				Keywords: []KeywordRule{
					{ID: "text-rule", Term: "Example phrase", Fields: []string{"lyrics"}, Action: action},
					{ID: "other-field", Term: "example", Fields: []string{"description"}, Action: "blocked"},
				},
			}
			got := policy.AssessText(map[string]string{"lyrics": "ＥＸＡＭＰＬＥ\nphrase"})
			if got.Class != action || got.Mode != "translation_text" || len(got.Matches) != 1 || got.Matches[0].Rule != "text-rule" || got.KeywordRuleCount != 1 {
				t.Fatalf("assessment = %+v", got)
			}
			if len(got.CheckedFields) != 1 || got.CheckedFields[0] != "lyrics" {
				t.Fatalf("checked fields = %v", got.CheckedFields)
			}
		})
	}
}

func TestTranslationTextDoesNotChangeMetadataAssessment(t *testing.T) {
	policy := Policy{
		LLMTranslationTextOnly: true,
		TagRules:               []TagRule{{TagID: 1, Action: "blocked"}},
		Keywords:               []KeywordRule{{ID: "other-language", Term: "例の句", Fields: []string{"lyrics"}, Action: "restricted"}},
	}
	if got := policy.AssessText(map[string]string{"lyrics": "Example line"}); got.Class != "safe" || got.KeywordRuleCount != 1 || len(got.Matches) != 0 {
		t.Fatalf("unmatched text = %+v", got)
	}
	if got := policy.AssessText(map[string]string{"title": "Example title"}); got.Class != "safe" || got.KeywordRuleCount != 0 {
		t.Fatalf("inapplicable rules = %+v", got)
	}
	if got := policy.AssessText(map[string]string{"lyrics": "Example line 例の句"}); got.Class != "restricted" {
		t.Fatalf("mixed-language text = %+v", got)
	}
	for age, want := range map[string]string{"general": "safe", "r15": "sensitive", "adult": "sensitive", "": "unknown"} {
		if got := policy.Assess(age, nil, nil); got.Class != want || got.Mode != "" {
			t.Fatalf("metadata %q = %+v, want %s", age, got, want)
		}
	}
	if got := policy.Assess("general", nil, []int64{1}); got.Class != "blocked" {
		t.Fatalf("metadata tag rule = %+v", got)
	}
	policy.Keywords[0].Action = "invalid"
	if got := policy.AssessText(map[string]string{"lyrics": "Example line"}); got.Class != "unknown" {
		t.Fatalf("invalid text policy = %+v", got)
	}
}
