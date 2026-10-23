package metadatatitles

import (
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"testing"
)

func TestLanguageTitlePriorityAndDescription(t *testing.T) {
	variants := []Variant{
		{Code: testfixture.WorkCode(testfixture.PrefixRJ, 1), Language: "zh-cn", Title: "【简体中文版】Example translation", Description: "Translated introduction"},
		{Code: testfixture.WorkCode(testfixture.PrefixRJ, 0), Language: "ja-jp", Title: "【ASMR】Example original", Description: "Original introduction", Origin: true},
	}
	for _, tc := range []struct {
		name                                 string
		manual                               map[string]string
		priority                             []string
		title, description, language, source string
	}{
		{"provider translation", nil, []string{"zh-cn"}, "Example translation", "Translated introduction", "zh-cn", "dlsite"},
		{"specific manual", map[string]string{"zh-cn": "【简体中文版】Authored title", "": "Global"}, []string{"zh-cn"}, "【简体中文版】Authored title", "Translated introduction", "zh-cn", "manual"},
		{"global beats matching provider", map[string]string{"": "Global", "ja-jp": "Japanese manual"}, []string{"zh-cn"}, "Global", "Translated introduction", "zh-cn", "manual"},
		{"global does not invent preferred edition", map[string]string{"": "Global"}, []string{"ko-kr"}, "Global", "Original introduction", "ja-jp", "manual"},
		{"next language", nil, []string{"ko-kr", "zh-cn"}, "Example translation", "Translated introduction", "zh-cn", "dlsite"},
		{"global keeps the next language edition", map[string]string{"": "Global"}, []string{"ko-kr", "zh-cn"}, "Global", "Translated introduction", "zh-cn", "manual"},
		{"manual without edition", map[string]string{"ko-kr": "Korean manual"}, []string{"ko-kr", "zh-cn"}, "Korean manual", "Original introduction", "ko-kr", "manual"},
		{"origin uses declared language", map[string]string{"ja-jp": "Japanese manual"}, []string{"origin"}, "Japanese manual", "Original introduction", "ja-jp", "manual"},
		{"fallback", nil, []string{"en-us"}, "【ASMR】Example original", "Original introduction", "ja-jp", "original"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Select(variants, tc.manual, tc.priority, Variant{})
			if got.Title != tc.title || got.Description != tc.description || got.Language != tc.language || got.Source != tc.source {
				t.Fatalf("selection = %+v", got)
			}
		})
	}
	unknown := Select(nil, map[string]string{"ja-jp": "Must not guess Japanese"}, []string{"origin"}, Variant{Title: "Unknown original", Description: "Unknown description"})
	if unknown.Title != "Unknown original" || unknown.Language != "" {
		t.Fatalf("unknown origin: %+v", unknown)
	}
}

func TestTranslationPrefixIsDisplayOnlyAndBounded(t *testing.T) {
	for _, tc := range []struct {
		title       string
		translation bool
		want        string
	}{
		{"【简体中文版】Example", true, "Example"},
		{"【繁體中文版】Example", true, "Example"},
		{"【한국어 자막판】Example", true, "Example"},
		{"【ドイツ語版】Example German", true, "Example German"},
		{"【スペイン語版】Example Spanish", true, "Example Spanish"},
		{"【English Version】Example English", true, "Example English"},
		{"【ドイツ語版】【スペイン語版】Example", true, "【スペイン語版】Example"},
		{"【简体中文版】【ASMR】Example", true, "【ASMR】Example"},
		{"【ASMR】Example", true, "【ASMR】Example"},
		{"【特典版】Example", true, "【特典版】Example"},
		{"Example【简体中文版】", true, "Example【简体中文版】"},
		{"【简体中文版】Example", false, "【简体中文版】Example"},
		{"【简体中文版】", true, "【简体中文版】"},
	} {
		if got := Display(tc.title, tc.translation); got != tc.want {
			t.Errorf("Display(%q,%v)=%q", tc.title, tc.translation, got)
		}
	}
}

// A viewer's title sort reads the first stored language title in its
// priority; that must always be the title Select presents.
func TestLanguageTitlesMatchSelectForEveryPriority(t *testing.T) {
	variants := []Variant{
		{Code: testfixture.WorkCode(testfixture.PrefixRJ, 1), Language: "zh-cn", Title: "【简体中文版】Example translation"},
		{Code: testfixture.WorkCode(testfixture.PrefixRJ, 0), Language: "ja-jp", Title: "Example original", Origin: true},
	}
	for _, manual := range []map[string]string{nil, {"": "Global"}, {"ko-kr": "Korean manual"}, {"ja-jp": "Japanese manual", "": "Global"}} {
		input := Inputs{Variants: variants, Manual: manual}
		titles := LanguageTitles(input)
		for _, priority := range [][]string{{"origin"}, {"zh-cn"}, {"ko-kr"}, {"en-us"}, {"ja-jp"}, {"ko-kr", "zh-cn"}, {"en-us", "origin"}} {
			want := Select(variants, manual, priority, Variant{}).Title
			got := ""
			for _, language := range append(append([]string{}, priority...), "origin") {
				if title, ok := titles[language]; ok {
					got = title
					break
				}
			}
			if got != want {
				t.Fatalf("manual %v priority %v: sort title %q, displayed %q", manual, priority, got, want)
			}
		}
	}
}

func TestMachineFieldsFillIndependentGapsBelowOfficialAndManual(t *testing.T) {
	origin := Variant{Code: testfixture.WorkCode(testfixture.PrefixRJ, 0), Language: "ja-jp", Title: "Original title", Description: "Original description", Origin: true}
	machine := Variant{Code: origin.Code, Language: "en-us", Title: "Machine title", Description: "Machine description", LLM: true}
	official := Variant{Code: testfixture.WorkCode(testfixture.PrefixRJ, 1), Language: "en-us", Title: "Official title", Description: "Official description"}
	for _, tc := range []struct {
		name                       string
		variants                   []Variant
		manual                     map[string]string
		title, description, source string
	}{
		{"machine", []Variant{machine, origin}, nil, "Machine title", "Machine description", "llm"},
		{"official wins regardless of order", []Variant{machine, official, origin}, nil, "Official title", "Official description", "dlsite"},
		{"scoped manual wins", []Variant{machine, origin}, map[string]string{"en-us": "Manual title"}, "Manual title", "Machine description", "manual"},
		{"universal manual wins", []Variant{machine, origin}, map[string]string{"": "Universal title"}, "Universal title", "Machine description", "manual"},
		{"title only retains original description", []Variant{{Code: origin.Code, Language: "en-us", Title: "Machine title", LLM: true}, origin}, nil, "Machine title", "Original description", "llm"},
		{"description only retains original title", []Variant{{Code: origin.Code, Language: "en-us", Description: "Machine description", LLM: true}, origin}, nil, "Original title", "Machine description", "original"},
		{"official description gap", []Variant{machine, {Code: official.Code, Language: "en-us", Title: "Official title"}, origin}, nil, "Official title", "Machine description", "dlsite"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := Select(tc.variants, tc.manual, []string{"en-us"}, origin)
			if got.Title != tc.title || got.Description != tc.description || got.Source != tc.source {
				t.Fatalf("selection=%+v", got)
			}
		})
	}
	if got := Select([]Variant{machine, origin}, nil, []string{"origin"}, origin); got.Title != origin.Title || got.Description != origin.Description {
		t.Fatal("machine translation replaced origin")
	}
}

func TestLanguageManualDescriptionReplacesItsLanguageAndAddsAChoice(t *testing.T) {
	variants := []Variant{
		{Code: testfixture.WorkCode(testfixture.PrefixRJ, 1), Language: "zh-cn", Title: "Example translation", Description: "Translated introduction"},
		{Code: testfixture.WorkCode(testfixture.PrefixRJ, 0), Language: "ja-jp", Title: "Example original", Description: "Original introduction", Origin: true},
		{Language: "zh-cn", Description: "Authored Chinese introduction", ManualDescription: true},
		{Language: "ko-kr", Description: "Authored Korean introduction", ManualDescription: true},
	}
	chinese := Select(variants, nil, []string{"zh-cn"}, Variant{})
	if chinese.Title != "Example translation" || chinese.Description != "Authored Chinese introduction" || chinese.DescriptionSource != "manual" {
		t.Fatalf("edition language: %+v", chinese)
	}
	// A description alone gives a language without an edition its own choice; the title stays the original.
	korean := Select(variants, nil, []string{"ko-kr", "zh-cn"}, Variant{})
	if korean.Language != "ko-kr" || korean.Title != "Example original" || korean.Description != "Authored Korean introduction" {
		t.Fatalf("description-only language: %+v", korean)
	}
	english := Select(variants, nil, []string{"en-us", "origin"}, Variant{})
	if english.Language != "ja-jp" || english.Description != "Original introduction" {
		t.Fatalf("other languages keep their introduction: %+v", english)
	}
	if _, ok := LanguageTitles(Inputs{Variants: variants})["ko-kr"]; !ok {
		t.Fatal("title sort projection misses the description-only language")
	}
}
