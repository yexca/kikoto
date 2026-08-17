package httpapi

import (
	"testing"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestRemoteWorkMetadataPresentationUsesRequestDefaultAndActualI18nVariants(t *testing.T) {
	work := kikoeru.Work{
		SourceID: "RJ00000040",
		Title:    "Source title",
		Tags: []kikoeru.Tag{{
			Name: "Base tag",
			I18n: map[string]kikoeru.LocalizedTag{
				"ja-jp": {Name: "Japanese tag"},
				"en-us": {Name: "English tag"},
			},
		}},
	}
	presentation := remoteWorkMetadataPresentation(work, []string{"zh-TW"})
	if presentation.DefaultVariantKey != "zh-tw" || len(presentation.Variants) != 3 {
		t.Fatalf("presentation = %+v", presentation)
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
