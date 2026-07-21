package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	_ "modernc.org/sqlite"
)

type fakeDLsiteClient struct {
	products map[string]dlsite.Product
	errors   map[string]error
	failures map[string][]error
	calls    map[string]int
}

func (f fakeDLsiteClient) FetchProduct(_ context.Context, workno string) (dlsite.Product, error) {
	if f.calls != nil {
		f.calls[workno]++
	}
	if len(f.failures[workno]) > 0 {
		err := f.failures[workno][0]
		f.failures[workno] = f.failures[workno][1:]
		return dlsite.Product{}, err
	}
	if err := f.errors[workno]; err != nil {
		return dlsite.Product{}, err
	}
	return f.products[workno], nil
}

func (f fakeDLsiteClient) DownloadCover(_ context.Context, _ dlsite.Product, _ string) (string, error) {
	return "", nil
}

func TestSyncAllUpdatesWorkAndStoresSnapshot(t *testing.T) {
	db := openTestDB(t)
	raw := json.RawMessage(`{"workno":"RJ0123456","product_name":"DLsite title"}`)
	rating := 4.75
	sales := int64(4321)
	regularPrice := int64(0)
	currentPrice := int64(0)
	isDiscount := false
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{
		products: map[string]dlsite.Product{
			"RJ0123456": {
				WorkNo:            "RJ0123456",
				SiteID:            "maniax",
				ProductName:       "DLsite title",
				WorkNameKana:      "ディーエルサイト",
				IntroShort:        "Short intro",
				RegistDate:        "2024-01-02",
				AgeCategoryString: "adult",
				RateAverage2DP:    &rating,
				SalesCount:        &sales,
				RegularPrice:      &regularPrice,
				CurrentPrice:      &currentPrice,
				IsDiscount:        &isDiscount,
				Genres: []dlsite.Genre{
					{Name: "耳かき", NameBase: "Ear cleaning"},
				},
				Raw: raw,
			},
		},
	})

	result, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.SyncedWorks != 1 {
		t.Fatalf("result = %+v", result)
	}

	var title string
	var snapshotCount int
	if err := db.QueryRow("SELECT title FROM work WHERE primary_code = 'RJ0123456'").Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "DLsite title" {
		t.Fatalf("title = %q", title)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&snapshotCount); err != nil {
		t.Fatal(err)
	}
	if snapshotCount != 1 {
		t.Fatalf("snapshotCount = %d", snapshotCount)
	}
	var storedRating float64
	var storedSales, storedRegularPrice, storedCurrentPrice int64
	var storedCurrency string
	var storedPermanentlyFree bool
	if err := db.QueryRow(`
		SELECT rating_average, sales_count, regular_price, current_price, price_currency, is_permanently_free
		FROM work WHERE primary_code = 'RJ0123456'
	`).Scan(&storedRating, &storedSales, &storedRegularPrice, &storedCurrentPrice, &storedCurrency, &storedPermanentlyFree); err != nil {
		t.Fatal(err)
	}
	if storedRating != rating || storedSales != sales || storedRegularPrice != 0 || storedCurrentPrice != 0 || storedCurrency != "JPY" || !storedPermanentlyFree {
		t.Fatalf("commercial projection = %v/%d/%d/%d/%q/%t", storedRating, storedSales, storedRegularPrice, storedCurrentPrice, storedCurrency, storedPermanentlyFree)
	}
	var tagName string
	if err := db.QueryRow(`
		SELECT tag.display_name
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		INNER JOIN work ON work.id = work_tag.work_id
		WHERE work.primary_code = 'RJ0123456' AND work_tag.source = 'dlsite'
	`).Scan(&tagName); err != nil {
		t.Fatal(err)
	}
	if tagName != "耳かき" {
		t.Fatalf("tagName = %q", tagName)
	}
}

func TestSyncAllRecordsNoProductProviderStateAndSkipsFutureRefreshes(t *testing.T) {
	db := openTestDB(t)
	calls := map[string]int{}
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{
		errors: map[string]error{
			"RJ0123456": dlsite.ErrNoProduct,
		},
		calls: calls,
	})

	result, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.SyncedWorks != 0 || result.FailedWorks != 0 || result.UnavailableWorks != 1 || len(result.ReviewCandidates) != 0 {
		t.Fatalf("result = %+v", result)
	}

	var status, message string
	if err := db.QueryRow(`
		SELECT state.status, state.message
		FROM work_metadata_provider_state AS state
		INNER JOIN metadata_provider AS provider ON provider.id = state.provider_id
		INNER JOIN work ON work.id = state.work_id
		WHERE provider.code = 'dlsite' AND work.primary_code = 'RJ0123456'
	`).Scan(&status, &message); err != nil {
		t.Fatal(err)
	}
	if status != "not_found" || !strings.Contains(message, "not found") {
		t.Fatalf("provider state = %q/%q", status, message)
	}
	var candidateCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_candidate").Scan(&candidateCount); err != nil {
		t.Fatal(err)
	}
	if candidateCount != 0 {
		t.Fatalf("candidate count = %d, want 0", candidateCount)
	}
	second, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.TargetWorks != 0 || calls["RJ0123456"] != 1 {
		t.Fatalf("second sync = %+v calls = %d, want skipped without another provider call", second, calls["RJ0123456"])
	}
}

func TestSyncAllRetriesRateLimitedProduct(t *testing.T) {
	db := openTestDB(t)
	calls := map[string]int{}
	raw := json.RawMessage(`{"workno":"RJ0123456","product_name":"DLsite title"}`)
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{
		calls: calls,
		failures: map[string][]error{
			"RJ0123456": {
				dlsite.HTTPStatusError{Operation: "dlsite maniax", Status: "429 Too Many Requests", StatusCode: 429},
			},
		},
		products: map[string]dlsite.Product{
			"RJ0123456": {
				WorkNo:      "RJ0123456",
				SiteID:      "maniax",
				ProductName: "DLsite title",
				Raw:         raw,
			},
		},
	}).WithRequestPacing(0, 0, 0)

	result, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.SyncedWorks != 1 {
		t.Fatalf("result = %+v", result)
	}
	if calls["RJ0123456"] != 2 {
		t.Fatalf("calls = %d, want 2", calls["RJ0123456"])
	}
}

func TestSyncAllResolvesOriginFromLanguageEditions(t *testing.T) {
	db := openTestDB(t)
	editions := []dlsite.LanguageEdition{
		{WorkNo: "RJ0123455", DisplayOrder: 1, Label: "日本語", Lang: "JPN"},
		{WorkNo: "RJ0123456", DisplayOrder: 2, Label: "簡体中文（公式翻訳）", Lang: "CHI_HANS"},
	}
	translatedRaw := json.RawMessage(`{"workno":"RJ0123456","product_name":"Translated title","language_editions":[{"workno":"RJ0123455","display_order":1,"label":"日本語","lang":"JPN"},{"workno":"RJ0123456","display_order":2,"label":"簡体中文（公式翻訳）","lang":"CHI_HANS"}]}`)
	originRaw := json.RawMessage(`{"workno":"RJ0123455","product_name":"Origin title","language_editions":[{"workno":"RJ0123455","display_order":1,"label":"日本語","lang":"JPN"},{"workno":"RJ0123456","display_order":2,"label":"簡体中文（公式翻訳）","lang":"CHI_HANS"}]}`)
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{products: map[string]dlsite.Product{
		"RJ0123456": {WorkNo: "RJ0123456", ProductName: "Translated title", LanguageEditions: editions, Raw: translatedRaw},
		"RJ0123455": {WorkNo: "RJ0123455", ProductName: "Origin title", LanguageEditions: editions, Raw: originRaw},
	}})

	result, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.SyncedWorks != 1 {
		t.Fatalf("result = %+v", result)
	}

	var title string
	if err := db.QueryRow("SELECT title FROM work WHERE primary_code = 'RJ0123455'").Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Origin title" {
		t.Fatalf("origin title = %q", title)
	}
	var canonicalCode, translatedBase, translatedLanguage string
	if err := db.QueryRow(`
		SELECT logical.canonical_code, edition.base_code, edition.metadata_language
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		INNER JOIN work ON work.id = edition.work_id
		WHERE work.primary_code = 'RJ0123456'
	`).Scan(&canonicalCode, &translatedBase, &translatedLanguage); err != nil {
		t.Fatal(err)
	}
	if canonicalCode != "RJ0123455" || translatedBase != "RJ0123455" || translatedLanguage != "CHI_HANS" {
		t.Fatalf("edition = canonical %q, base %q, language %q", canonicalCode, translatedBase, translatedLanguage)
	}

	second, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if second.TargetWorks != 0 {
		t.Fatalf("second sync targets = %d, want 0", second.TargetWorks)
	}
}

func TestSyncFamilyClassifiesMakerRelationships(t *testing.T) {
	db := openTestDB(t)
	editions := []dlsite.LanguageEdition{
		{WorkNo: "RJ0123401", DisplayOrder: 1, Label: "日本語", Lang: "JPN"},
		{WorkNo: "RJ0123402", DisplayOrder: 2, Label: "簡体中文", Lang: "CHI_HANS"},
		{WorkNo: "RJ0123403", DisplayOrder: 3, Label: "English", Lang: "ENG"},
	}
	products := map[string]dlsite.Product{
		"RJ0123401": {WorkNo: "RJ0123401", ProductName: "Origin", MakerID: "RG12345", LanguageEditions: editions, Raw: json.RawMessage(`{"workno":"RJ0123401"}`)},
		"RJ0123402": {WorkNo: "RJ0123402", ProductName: "Official", MakerID: "RG12345", LanguageEditions: editions, Raw: json.RawMessage(`{"workno":"RJ0123402"}`)},
		"RJ0123403": {WorkNo: "RJ0123403", ProductName: "Community", MakerID: "RG60289", LanguageEditions: editions, Raw: json.RawMessage(`{"workno":"RJ0123403"}`)},
	}
	result, err := NewDLsiteSyncer(db, fakeDLsiteClient{products: products}).SyncFamily(context.Background(), "RJ0123402")
	if err != nil {
		t.Fatal(err)
	}
	if result.CanonicalCode != "RJ0123401" || len(result.SyncedCodes) != 3 {
		t.Fatalf("result = %+v", result)
	}
	want := map[string]string{"RJ0123401": "origin", "RJ0123402": "official", "RJ0123403": "community"}
	rows, err := db.Query("SELECT primary_code, translation_kind FROM work_edition")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var code, kind string
		if err := rows.Scan(&code, &kind); err != nil {
			t.Fatal(err)
		}
		if want[code] != kind {
			t.Fatalf("%s kind = %q, want %q", code, kind, want[code])
		}
		delete(want, code)
	}
	if len(want) != 0 {
		t.Fatalf("missing classifications: %+v", want)
	}
}

func TestSyncFamilySkipsExplicitlyUnavailableLanguageEditions(t *testing.T) {
	db := openTestDB(t)
	zero := 0
	one := 1
	editions := []dlsite.LanguageEdition{
		{WorkNo: "RJ0123501", DisplayOrder: 1, Label: "Japanese", Lang: "JPN"},
		{WorkNo: "RJ0123502", DisplayOrder: 2, Label: "Traditional Chinese", Lang: "CHI_HANT"},
		{WorkNo: "RJ0123503", DisplayOrder: 3, Label: "English", Lang: "ENG"},
		{WorkNo: "RJ0123504", DisplayOrder: 4, Label: "Korean", Lang: "KO_KR"},
		{WorkNo: "RJ0123505", DisplayOrder: 5, Label: "Indonesian", Lang: "IND"},
	}
	translationInfo := dlsite.TranslationInfo{StatusForTranslatorByLang: map[string]dlsite.TranslationStatus{
		"CHI_HANT": {AppliedCount: 1, OnSaleCount: &zero},
		"ENG":      {AppliedCount: 1, OnSaleCount: &one},
	}}
	calls := map[string]int{}
	products := map[string]dlsite.Product{
		"RJ0123501": {WorkNo: "RJ0123501", ProductName: "Origin", LanguageEditions: editions, TranslationInfo: translationInfo, Raw: json.RawMessage(`{"workno":"RJ0123501"}`)},
		"RJ0123503": {WorkNo: "RJ0123503", ProductName: "English", LanguageEditions: editions, TranslationInfo: translationInfo, Raw: json.RawMessage(`{"workno":"RJ0123503"}`)},
		"RJ0123504": {WorkNo: "RJ0123504", ProductName: "Korean", LanguageEditions: editions, TranslationInfo: translationInfo, Raw: json.RawMessage(`{"workno":"RJ0123504"}`)},
	}
	result, err := NewDLsiteSyncer(db, fakeDLsiteClient{
		products: products,
		errors: map[string]error{
			"RJ0123502": dlsite.ErrNoProduct,
			"RJ0123505": dlsite.ErrNoProduct,
		},
		calls: calls,
	}).SyncFamily(context.Background(), "RJ0123501")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.SyncedCodes) != 3 || len(result.SkippedCodes) != 2 || result.SkippedCodes[0] != "RJ0123502" || result.SkippedCodes[1] != "RJ0123505" || len(result.Failures) != 0 {
		t.Fatalf("result = %+v", result)
	}
	if calls["RJ0123502"] != 0 {
		t.Fatalf("unavailable edition calls = %d, want 0", calls["RJ0123502"])
	}
	if calls["RJ0123503"] != 1 || calls["RJ0123504"] != 1 {
		t.Fatalf("available and unknown-status calls = %+v", calls)
	}
	if calls["RJ0123505"] != 1 {
		t.Fatalf("unknown-status unavailable edition calls = %d, want 1", calls["RJ0123505"])
	}
	var aliasCount, workCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_code_alias WHERE primary_code IN ('RJ0123502', 'RJ0123505') AND source_work_id IS NULL").Scan(&aliasCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code IN ('RJ0123502', 'RJ0123505')").Scan(&workCount); err != nil {
		t.Fatal(err)
	}
	if aliasCount != 2 || workCount != 0 {
		t.Fatalf("unavailable editions = aliases %d, works %d, want 2 aliases and no works", aliasCount, workCount)
	}
}

func TestSyncFamilyMarksRequestedProductUnavailable(t *testing.T) {
	db := openTestDB(t)
	result, err := NewDLsiteSyncer(db, fakeDLsiteClient{
		errors: map[string]error{"RJ0123599": dlsite.ErrNoProduct},
	}).SyncFamily(context.Background(), "RJ0123599")
	if err == nil {
		t.Fatal("SyncFamily() succeeded for an unavailable requested product")
	}
	if !result.RequestedUnavailable || len(result.SyncedCodes) != 0 || len(result.Failures) != 1 {
		t.Fatalf("result = %+v, want requested unavailable failure", result)
	}
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	schema := []string{
		`CREATE TABLE metadata_provider (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE work (id INTEGER PRIMARY KEY, primary_code TEXT NOT NULL UNIQUE, work_type TEXT NOT NULL DEFAULT 'audio', title TEXT NOT NULL, title_kana TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', release_date TEXT, age_rating TEXT NOT NULL DEFAULT '', cover_asset_id INTEGER, duration_seconds INTEGER, rating_average REAL, sales_count INTEGER, regular_price INTEGER, current_price INTEGER, price_currency TEXT NOT NULL DEFAULT '', is_permanently_free INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE work_metadata_provider_state (work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE, provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('available', 'not_found')), message TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(work_id, provider_id))`,
		`CREATE TABLE logical_work (id INTEGER PRIMARY KEY, canonical_work_id INTEGER REFERENCES work(id) ON DELETE SET NULL, canonical_code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE work_edition (work_id INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE, logical_work_id INTEGER NOT NULL REFERENCES logical_work(id) ON DELETE CASCADE, provider_id INTEGER REFERENCES metadata_provider(id), primary_code TEXT NOT NULL, base_code TEXT NOT NULL DEFAULT '', metadata_language TEXT NOT NULL DEFAULT '', edition_label TEXT NOT NULL DEFAULT '', is_canonical INTEGER NOT NULL DEFAULT 0, translation_kind TEXT NOT NULL DEFAULT 'unknown', classification_source TEXT NOT NULL DEFAULT '', maker_id TEXT NOT NULL DEFAULT '', origin_maker_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE UNIQUE INDEX idx_work_edition_provider_code ON work_edition(provider_id, primary_code)`,
		`CREATE INDEX idx_work_edition_logical_work ON work_edition(logical_work_id, is_canonical DESC, primary_code)`,
		`CREATE TABLE work_code_alias (id INTEGER PRIMARY KEY, logical_work_id INTEGER NOT NULL REFERENCES logical_work(id) ON DELETE CASCADE, provider_id INTEGER NOT NULL REFERENCES metadata_provider(id), primary_code TEXT NOT NULL, metadata_language TEXT NOT NULL DEFAULT '', edition_label TEXT NOT NULL DEFAULT '', source_work_id INTEGER REFERENCES work(id) ON DELETE SET NULL, relationship_kind TEXT NOT NULL DEFAULT 'provider_declared', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(provider_id, primary_code))`,
		`CREATE TABLE work_external_id (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE, provider_id INTEGER NOT NULL REFERENCES metadata_provider(id), id_type TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', is_primary INTEGER NOT NULL DEFAULT 0, UNIQUE(provider_id, id_type, external_id))`,
		`CREATE TABLE metadata_snapshot (id INTEGER PRIMARY KEY, work_id INTEGER REFERENCES work(id) ON DELETE SET NULL, provider_id INTEGER NOT NULL REFERENCES metadata_provider(id), external_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE tag (id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, normalized_name TEXT NOT NULL, display_name TEXT NOT NULL, language TEXT NOT NULL DEFAULT '', is_user_defined INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(namespace, normalized_name, language))`,
		`CREATE TABLE work_tag (work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE, source TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(work_id, tag_id, source))`,
		`CREATE TABLE workflow_definition (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', definition_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_trigger (id INTEGER PRIMARY KEY, workflow_definition_id INTEGER NOT NULL REFERENCES workflow_definition(id) ON DELETE CASCADE, trigger_type TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, schedule_json TEXT NOT NULL DEFAULT '{}', config_json TEXT NOT NULL DEFAULT '{}', next_run_at TEXT, last_run_at TEXT, last_success_at TEXT, last_error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_run (id INTEGER PRIMARY KEY, workflow_definition_id INTEGER REFERENCES workflow_definition(id) ON DELETE SET NULL, trigger_id INTEGER REFERENCES workflow_trigger(id) ON DELETE SET NULL, workflow_code TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL, trigger_type TEXT NOT NULL, trigger_reason TEXT NOT NULL DEFAULT '', input_json TEXT NOT NULL DEFAULT '{}', summary_json TEXT NOT NULL DEFAULT '{}', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_node_run (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, node_id TEXT NOT NULL, node_type TEXT NOT NULL, display_name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, input_json TEXT NOT NULL DEFAULT '{}', output_json TEXT NOT NULL DEFAULT '{}', error_message TEXT NOT NULL DEFAULT '', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_job (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL, worker_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', checkpoint_json TEXT NOT NULL DEFAULT '{}', recoverable INTEGER NOT NULL DEFAULT 0, max_retries INTEGER NOT NULL DEFAULT 3, resume_count INTEGER NOT NULL DEFAULT 0, available_at TEXT, retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT '', progress_current INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 0, locked_by TEXT NOT NULL DEFAULT '', locked_at TEXT, heartbeat_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_candidate (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL, candidate_type TEXT NOT NULL, external_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', decision_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_event (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL, workflow_job_id INTEGER REFERENCES workflow_job(id) ON DELETE SET NULL, level TEXT NOT NULL DEFAULT 'info', event_type TEXT NOT NULL, message TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`INSERT INTO work (primary_code, title) VALUES ('RJ0123456', 'Local title')`,
	}
	for _, statement := range schema {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return db
}
