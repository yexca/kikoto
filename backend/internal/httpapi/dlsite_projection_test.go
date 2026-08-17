package httpapi

import (
	"context"
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
	if _, err := db.Exec(`
		INSERT INTO app_setting (key, value_json) VALUES ('dlsite_metadata_languages', '["zh-cn","origin"]')
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	presentation, err := server.loadWorkMetadataPresentation(context.Background(), originID)
	if err != nil {
		t.Fatal(err)
	}
	if presentation.DefaultVariantKey != "RJ00000031" || len(presentation.Variants) != 2 {
		t.Fatalf("presentation = %+v", presentation)
	}
	var simplified workMetadataVariant
	for _, variant := range presentation.Variants {
		if variant.Key == "RJ00000031" {
			simplified = variant
		}
	}
	if simplified.Language != "zh-cn" || simplified.Origin || simplified.Title != "Simplified title" || len(simplified.Tags) != 1 || simplified.Tags[0] != "Simplified tag" {
		t.Fatalf("simplified variant = %+v", simplified)
	}
}
