package httpapi

import (
	"context"
	"fmt"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

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

func TestWorkSummariesKeepAllProviderTags(t *testing.T) {
	genres := ""
	remoteTags := make([]kikoeru.Tag, 0, 12)
	for index := 1; index <= 12; index++ {
		if index > 1 {
			genres += ","
		}
		name := fmt.Sprintf("Tag %02d", index)
		genres += fmt.Sprintf(`{"name":%q}`, name)
		remoteTags = append(remoteTags, kikoeru.Tag{Name: name})
	}
	metadata := parseDLsiteSnapshot(`{"genres":[` + genres + `]}`)
	if len(metadata.Tags) != 12 {
		t.Fatalf("DLsite tags = %d, want 12", len(metadata.Tags))
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	works, err := server.remoteWorkSummaries(context.Background(), 0, 7, []kikoeru.Work{{ID: 1, SourceID: "RJ09999999", Tags: remoteTags}}, "ja-jp")
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 1 || len(works[0].Tags) != 12 {
		t.Fatalf("remote summaries = %+v", works)
	}
}
