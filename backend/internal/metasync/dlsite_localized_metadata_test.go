package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func TestSyncFamilyStoresAllLanguageVariantsAndProjectsPriority(t *testing.T) {
	db := openTestDB(t)
	editions := []dlsite.LanguageEdition{
		{WorkNo: "RJ00000020", DisplayOrder: 1, Label: "Japanese", Lang: "JPN"},
		{WorkNo: "RJ00000021", DisplayOrder: 2, Label: "Simplified Chinese", Lang: "CHI_HANS"},
		{WorkNo: "RJ00000022", DisplayOrder: 3, Label: "Traditional Chinese", Lang: "CHI_HANT"},
		{WorkNo: "RJ00000023", DisplayOrder: 4, Label: "English", Lang: "ENG"},
		{WorkNo: "RJ00000024", DisplayOrder: 5, Label: "Korean", Lang: "KO_KR"},
		{WorkNo: "RJ00000025", DisplayOrder: 6, Label: "Indonesian", Lang: "IND"},
	}
	products := map[string]map[string]dlsite.Product{}
	add := func(code, locale, title, tag string) {
		if products[code] == nil {
			products[code] = map[string]dlsite.Product{}
		}
		products[code][locale] = dlsite.Product{
			WorkNo:           code,
			ProductName:      title,
			LanguageEditions: editions,
			Genres:           []dlsite.Genre{{Name: tag}},
			Raw:              json.RawMessage(`{"workno":"` + code + `","product_name":"` + title + `"}`),
		}
	}
	add("RJ00000020", "ja-jp", "Origin title", "origin-tag")
	add("RJ00000021", "zh-cn", "Simplified title", "简体标签")
	add("RJ00000022", "zh-tw", "Traditional title", "繁體標籤")
	add("RJ00000023", "en-us", "English title", "English tag")
	add("RJ00000024", "ko-kr", "Korean title", "Korean tag")
	// The provider exposes this language in the directory, but it is not one
	// of the configurable display languages.
	add("RJ00000025", "ja-jp", "Indonesian title", "Indonesian tag")
	// The first discovery request may use Japanese even for a translated code;
	// the syncer must then issue the edition-specific request.
	for _, code := range []string{"RJ00000021", "RJ00000022", "RJ00000023", "RJ00000024"} {
		products[code]["ja-jp"] = products[code][map[string]string{
			"RJ00000021": "zh-cn",
			"RJ00000022": "zh-tw",
			"RJ00000023": "en-us",
			"RJ00000024": "ko-kr",
		}[code]]
	}

	client := &localizedFakeDLsiteClient{products: products}
	syncer := NewDLsiteSyncer(db, client).
		WithLanguages([]string{"ja-jp"}).
		WithMetadataPriority([]string{"zh-cn", "zh-tw", "ja-jp"}).
		WithRequestPacing(0, 0, 0)
	result, err := syncer.SyncFamily(context.Background(), "RJ00000020")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.SyncedCodes) != len(editions) {
		t.Fatalf("synced codes = %v, want %d editions", result.SyncedCodes, len(editions))
	}

	var variantCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM dlsite_metadata_variant").Scan(&variantCount); err != nil {
		t.Fatal(err)
	}
	if variantCount != len(editions) {
		t.Fatalf("variant count = %d, want %d", variantCount, len(editions))
	}
	var unknownCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM dlsite_metadata_variant WHERE edition_language = 'IND'").Scan(&unknownCount); err != nil {
		t.Fatal(err)
	}
	if unknownCount != 1 {
		t.Fatalf("unknown language variants = %d, want 1", unknownCount)
	}

	var simplifiedRequest string
	if err := db.QueryRow(`
		SELECT request_locale
		FROM dlsite_metadata_variant
		WHERE work_id = (SELECT id FROM work WHERE primary_code = 'RJ00000021')
	`).Scan(&simplifiedRequest); err != nil {
		t.Fatal(err)
	}
	if simplifiedRequest != "zh-cn" {
		t.Fatalf("simplified request locale = %q, want zh-cn", simplifiedRequest)
	}

	var title string
	if err := db.QueryRow("SELECT title FROM work WHERE primary_code = 'RJ00000020'").Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Simplified title" {
		t.Fatalf("projected title = %q, want Simplified title", title)
	}
	selected, ok, err := SelectDLsiteMetadataVariant(context.Background(), db, workIDForTest(t, db, "RJ00000020"), []string{"origin"})
	if err != nil {
		t.Fatal(err)
	}
	if !ok || selected.Title != "Origin title" {
		t.Fatalf("origin selection = %+v/%t", selected, ok)
	}

	var snapshotCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot WHERE external_id = 'RJ00000021'").Scan(&snapshotCount); err != nil {
		t.Fatal(err)
	}
	if snapshotCount != 1 {
		t.Fatalf("initial simplified snapshots = %d, want 1", snapshotCount)
	}
	client.products["RJ00000021"]["zh-cn"] = dlsite.Product{
		WorkNo:           "RJ00000021",
		ProductName:      "Simplified title v2",
		LanguageEditions: editions,
		Genres:           []dlsite.Genre{{Name: "简体标签 v2"}},
		Raw:              json.RawMessage(`{"workno":"RJ00000021","product_name":"Simplified title v2"}`),
	}
	if _, err := syncer.SyncFamily(context.Background(), "RJ00000020"); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot WHERE external_id = 'RJ00000021'").Scan(&snapshotCount); err != nil {
		t.Fatal(err)
	}
	if snapshotCount != 2 {
		t.Fatalf("changed simplified snapshots = %d, want 2", snapshotCount)
	}
	var staleTagCount, currentTagCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE work_tag.work_id = (SELECT id FROM work WHERE primary_code = 'RJ00000021')
		  AND work_tag.source = 'dlsite' AND tag.display_name = '简体标签'
	`).Scan(&staleTagCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE work_tag.work_id = (SELECT id FROM work WHERE primary_code = 'RJ00000021')
		  AND work_tag.source = 'dlsite' AND tag.display_name = '简体标签 v2'
	`).Scan(&currentTagCount); err != nil {
		t.Fatal(err)
	}
	if staleTagCount != 0 || currentTagCount != 1 {
		t.Fatalf("localized tag projection = stale %d/current %d, want 0/1", staleTagCount, currentTagCount)
	}
	var maxSnapshots int
	if err := db.QueryRow(`
		SELECT MAX(snapshot_count)
		FROM (
			SELECT provider_id, work_id, external_id, COUNT(*) AS snapshot_count
			FROM metadata_snapshot
			GROUP BY provider_id, work_id, external_id
		)
	`).Scan(&maxSnapshots); err != nil {
		t.Fatal(err)
	}
	if maxSnapshots > 2 {
		t.Fatalf("maximum retained snapshots = %d, want at most 2", maxSnapshots)
	}
}

func TestFetchProductForEditionRequiresExactSupportedLocale(t *testing.T) {
	editions := []dlsite.LanguageEdition{
		{WorkNo: "RJ00000026", DisplayOrder: 1, Label: "Traditional Chinese", Lang: "CHI_HANT"},
	}
	client := &localizedFakeDLsiteClient{
		products: map[string]map[string]dlsite.Product{
			"RJ00000026": {
				"ja-jp": {
					WorkNo:           "RJ00000026",
					ProductName:      "Mismatched discovery title",
					LanguageEditions: editions,
				},
			},
		},
	}
	syncer := NewDLsiteSyncer(openTestDB(t), client).WithLanguages([]string{"ja-jp"})

	if _, err := syncer.fetchProductForEdition(context.Background(), "RJ00000026"); !errors.Is(err, dlsite.ErrNoProduct) {
		t.Fatalf("exact-locale error = %v, want ErrNoProduct", err)
	}
}

func TestMetadataSnapshotRetentionSpansVariantKeyChanges(t *testing.T) {
	db := openTestDB(t)
	workID := workIDForTest(t, db, "RJ00000004")
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	providerID, err := ensureMetadataProvider(context.Background(), tx, "dlsite", "DLsite")
	if err != nil {
		t.Fatal(err)
	}
	entries := []struct {
		variantKey string
		raw        json.RawMessage
	}{
		{variantKey: "legacy", raw: json.RawMessage(`{"revision":1}`)},
		{variantKey: "jpn", raw: json.RawMessage(`{"revision":2}`)},
		{variantKey: "ja-jp", raw: json.RawMessage(`{"revision":3}`)},
	}
	for _, entry := range entries {
		if err := upsertDLsiteMetadataSnapshot(
			context.Background(), tx, workID, providerID, "RJ00000004", entry.raw,
			entry.variantKey, "JPN", "ja-jp", hashSnapshot(entry.raw),
		); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	var count int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM metadata_snapshot
		WHERE work_id = ? AND provider_id = ? AND external_id = 'RJ00000004'
	`, workID, providerID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("retained snapshots = %d, want 2 across variant key changes", count)
	}
}

func workIDForTest(t *testing.T, db *sql.DB, code string) int64 {
	t.Helper()
	var id int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code = ?", code).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
