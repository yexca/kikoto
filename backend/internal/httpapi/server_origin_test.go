package httpapi

import "testing"

func TestParseDLsiteSnapshotUsesLanguageEditionOrigin(t *testing.T) {
	raw := `{"product":{"workno":"RJ362169","product_name":"Chinese title","language_editions":[{"workno":"RJ362056","display_order":1,"label":"日本語","lang":"JPN"},{"workno":"RJ362169","display_order":3,"label":"簡体中文（公式翻訳）","lang":"CHI_HANS"}]},"_kikoto":{"response_language":"ja-jp","edition_language":"CHI_HANS"}}`
	metadata := parseDLsiteSnapshot(raw)
	if metadata.BaseCode != "RJ362056" {
		t.Fatalf("base code = %q", metadata.BaseCode)
	}
	if metadata.MetadataLanguage != "CHI_HANS" {
		t.Fatalf("metadata language = %q", metadata.MetadataLanguage)
	}
	if len(metadata.LanguageEditions) != 2 {
		t.Fatalf("editions = %d", len(metadata.LanguageEditions))
	}
	if !metadata.LanguageEditions[0].Origin || metadata.LanguageEditions[0].Official {
		t.Fatalf("origin flags = %+v", metadata.LanguageEditions[0])
	}
	if metadata.LanguageEditions[1].Origin || metadata.LanguageEditions[1].Official || metadata.LanguageEditions[1].TranslationKind != "unknown" {
		t.Fatalf("translation flags = %+v", metadata.LanguageEditions[1])
	}
}
