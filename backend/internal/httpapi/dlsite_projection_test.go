package httpapi

import (
	"context"
	"net/http"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLoadWorkMetadataPresentationReturnsPriorityDefaultAndAllVariants(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (primary_code, title) VALUES
			('RJ00000030', 'Origin title'),
			('RJ00000031', 'Simplified title')
	`); err != nil {
		t.Fatal(err)
	}
	var originID, simplifiedID, providerID int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code = 'RJ00000030'").Scan(&originID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code = 'RJ00000031'").Scan(&simplifiedID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	logical, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ00000030')", originID)
	if err != nil {
		t.Fatal(err)
	}
	logicalID, err := logical.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (
			work_id, logical_work_id, provider_id, primary_code, metadata_language,
			edition_label, is_canonical, translation_kind
		) VALUES
			(?, ?, ?, 'RJ00000030', 'JPN', 'Japanese', 1, 'origin'),
			(?, ?, ?, 'RJ00000031', 'CHI_HANS', 'Simplified Chinese', 0, 'official')
	`, originID, logicalID, providerID, simplifiedID, logicalID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO dlsite_metadata_variant (
			logical_work_id, work_id, provider_id, external_id,
			edition_language, request_locale, title, tags_json
		) VALUES
			(?, ?, ?, 'RJ00000030', 'JPN', 'ja-jp', 'Origin title', '["Origin tag"]'),
			(?, ?, ?, 'RJ00000031', 'CHI_HANS', 'zh-cn', 'Simplified title', '["Simplified tag"]')
	`, logicalID, originID, providerID, logicalID, simplifiedID, providerID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	// Without a preference the original edition is the default; a viewer's
	// own priority selects its edition.
	anonymous, err := server.loadWorkMetadataPresentation(context.Background(), originID)
	if err != nil {
		t.Fatal(err)
	}
	if anonymous.DefaultVariantKey != "RJ00000030" || len(anonymous.Variants) != 2 {
		t.Fatalf("anonymous presentation = %+v", anonymous)
	}
	viewer, viewerCtx := metadataLanguageUser(t, db, "synthetic-language-zh")
	if response := patchMetadataLanguages(t, server, viewer, `{"metadataLanguages":["zh-cn"]}`); response.Code != http.StatusOK {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}
	presentation, err := server.loadWorkMetadataPresentation(viewerCtx, originID)
	if err != nil {
		t.Fatal(err)
	}
	if presentation.DefaultVariantKey != "RJ00000031" || len(presentation.Variants) != 2 {
		t.Fatalf("presentation = %+v", presentation)
	}
	if got := []string{presentation.Variants[0].Key, presentation.Variants[1].Key}; got[0] != "RJ00000030" || got[1] != "RJ00000031" {
		t.Fatalf("variant order = %v, want Origin first", got)
	}
	var simplified workMetadataVariant
	for _, variant := range presentation.Variants {
		if variant.Key == "RJ00000031" {
			simplified = variant
		}
	}
	// Every language version presents the family's fixed tag set, the
	// original edition's tags; switching language never swaps the set.
	if simplified.Language != "zh-cn" || simplified.Origin || simplified.Title != "Simplified title" || len(simplified.Tags) != 1 || simplified.Tags[0] != "Origin tag" {
		t.Fatalf("simplified variant = %+v", simplified)
	}
}
