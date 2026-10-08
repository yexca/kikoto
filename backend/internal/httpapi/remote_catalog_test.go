package httpapi

import (
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRemoteDefaultMetadataKeepsCardTagLanguageFallback(t *testing.T) {
	work := kikoeru.Work{SourceID: testfixture.WorkCode(testfixture.PrefixRJ, 0), Title: "Example Work", Tags: []kikoeru.Tag{
		{Name: "Example base A", I18n: map[string]kikoeru.LocalizedTag{"zh-cn": {Name: "Example simplified A"}}},
		{Name: "Example base B", I18n: map[string]kikoeru.LocalizedTag{"ENG": {Name: "Example English B"}}},
	}}
	languages := []string{"zh-cn", "en-us", "ja-jp"}
	card := newRemoteCatalogProjectorWithLanguages(languages).project(1, work)
	if !reflect.DeepEqual(card.Tags, []string{"Example simplified A", "Example English B"}) {
		t.Fatalf("card tags=%v, want normalized language aliases and per-tag fallback", card.Tags)
	}
	view := remoteWorkMetadataPresentation(work, languages)
	for _, variant := range view.Variants {
		if variant.Key == view.DefaultVariantKey && !reflect.DeepEqual(variant.Tags, card.Tags) {
			t.Fatalf("default detail tags=%v card tags=%v", variant.Tags, card.Tags)
		}
	}
}

func TestRemoteWorkMetadataPresentationUsesRequestDefaultAndActualI18nVariants(t *testing.T) {
	work := kikoeru.Work{
		SourceID: "RJ00000040",
		Title:    "Source title",
		LanguageEditions: kikoeru.LanguageEditionList{
			{WorkNo: "RJ00000040", Language: "JPN", DisplayOrder: 1},
		},
		Tags: []kikoeru.Tag{{
			Name: "Base tag",
			I18n: map[string]kikoeru.LocalizedTag{
				"JPN": {Name: "Japanese tag"},
				"ENG": {Name: "English tag"},
			},
		}},
	}
	presentation := remoteWorkMetadataPresentation(work, []string{"zh-TW"})
	if presentation.DefaultVariantKey != "zh-tw" || len(presentation.Variants) != 3 {
		t.Fatalf("presentation = %+v", presentation)
	}
	if !presentation.Variants[0].Origin || presentation.Variants[0].Language != "ja-jp" {
		t.Fatalf("variant order = %+v, want Origin first", presentation.Variants)
	}
	variants := map[string]workMetadataVariant{}
	for _, variant := range presentation.Variants {
		variants[variant.Key] = variant
	}
	if got := variants["zh-tw"].Tags; len(got) != 1 || got[0] != "Base tag" {
		t.Fatalf("request fallback tags = %v", got)
	}
	if got := variants["ja-jp"].Tags; len(got) != 1 || got[0] != "Japanese tag" {
		t.Fatalf("Japanese tags = %v", got)
	}
}

func TestRemoteCatalogProjectorPreservesCustomRequestLanguage(t *testing.T) {
	work := kikoeru.Work{
		SourceID: "RJ00000041",
		Tags: []kikoeru.Tag{{
			Name: "Base tag",
			I18n: map[string]kikoeru.LocalizedTag{
				"zh_Hant": {Name: "Traditional tag"},
			},
		}},
	}
	projected := newRemoteCatalogProjectorWithLanguages([]string{"zh-Hant"}).project(1, work)
	if len(projected.Tags) != 1 || projected.Tags[0] != "Traditional tag" {
		t.Fatalf("projected tags = %v", projected.Tags)
	}
}
