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
