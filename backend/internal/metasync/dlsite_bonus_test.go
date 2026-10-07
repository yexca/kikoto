package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

type bonusCatalogClient struct {
	fakeDLsiteClient
	catalog      []string
	catalogCalls *int
}

func (c bonusCatalogClient) FetchMakerCatalog(_ context.Context, makerID string, options dlsite.MakerCatalogOptions) (dlsite.MakerProfile, error) {
	*c.catalogCalls++
	if makerID != "RG00000" || options.StopBelowCode == "" || !options.SkipSeries {
		return dlsite.MakerProfile{}, dlsite.ErrNoProduct
	}
	return dlsite.MakerProfile{MakerID: makerID, WorkCodes: c.catalog}, nil
}

func bonusTestPrice(value int64) *int64 { return &value }

func bonusTestProduct(code string, name string, kana string, price int64, productJSON string) dlsite.Product {
	product := dlsite.Product{
		WorkNo: code, ProductName: name, WorkName: name, WorkNameKana: kana, MakerID: "RG00000",
		RegistDate: "2024-01-02 00:00:00", RegularPrice: bonusTestPrice(price), CurrentPrice: bonusTestPrice(price),
		ProductRaw: json.RawMessage(productJSON),
		Raw:        json.RawMessage(`{"product":` + productJSON + `,"dynamic":{"rate_count":2}}`),
	}
	var decoded dlsite.Product
	if err := json.Unmarshal(product.ProductRaw, &decoded); err == nil {
		product.Genres = decoded.Genres
		product.Creators = decoded.Creators
	}
	return product
}

// RJ00000052 is a free early purchase bonus whose parent RJ00000051 shares
// its title reading; RJ00000053 is an unrelated newer work from the same maker.
func purchaseBonusFixture() (bonusCatalogClient, *int) {
	bonus := bonusTestProduct("RJ00000052", "【早期購入特典】Example Voice 1", "エグザンプルワーク", 0,
		`{"workno":"RJ00000052","maker_id":"RG00000","work_name":"【早期購入特典】Example Voice 1","work_name_kana":"エグザンプルワーク",`+
			`"official_price":0,"price":0,"genres":[],"creaters":[],"series_name":null}`)
	parent := bonusTestProduct("RJ00000051", "Example Work 1", "エグザンプルワーク", 1100,
		`{"workno":"RJ00000051","maker_id":"RG00000","work_name":"Example Work 1",`+
			`"genres":[{"id":497,"name":"ASMR","name_base":"ASMR"}],`+
			`"creaters":{"voice_by":[{"id":"1","name":"Example Voice"}]},"series_name":"Example Series"}`)
	other := bonusTestProduct("RJ00000053", "Example Work 2", "エグザンプルワークツー", 1100,
		`{"workno":"RJ00000053","maker_id":"RG00000","work_name":"Example Work 2"}`)
	calls := 0
	return bonusCatalogClient{
		fakeDLsiteClient: fakeDLsiteClient{
			products: map[string]dlsite.Product{"RJ00000051": parent, "RJ00000052": bonus, "RJ00000053": other},
			calls:    map[string]int{},
		},
		catalog:      []string{"RJ00000053", "RJ00000051"},
		catalogCalls: &calls,
	}, &calls
}

func insertBonusTestWork(t *testing.T, db *sql.DB, code string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('dlsite', 'DLsite') ON CONFLICT(code) DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES (?, 'Local folder')`, code); err != nil {
		t.Fatal(err)
	}
}

func purchaseBonusRow(t *testing.T, db *sql.DB, code string) (string, string, string, string) {
	t.Helper()
	var status, parent, origin, evidence string
	err := db.QueryRow(`SELECT bonus.status, bonus.parent_code, bonus.origin, bonus.evidence FROM work_purchase_bonus AS bonus
		JOIN work ON work.id = bonus.work_id WHERE work.primary_code = ?`, code).Scan(&status, &parent, &origin, &evidence)
	if err == sql.ErrNoRows {
		return "", "", "", ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return status, parent, origin, evidence
}

func TestSyncFamilyLinksDetectedPurchaseBonusAndInheritsParentMetadata(t *testing.T) {
	db := openTestDB(t)
	insertBonusTestWork(t, db, "RJ00000052")
	client, catalogCalls := purchaseBonusFixture()
	syncer := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(true, false)

	result, err := syncer.SyncFamily(context.Background(), "RJ00000052")
	if err != nil {
		t.Fatalf("SyncFamily() error = %v", err)
	}
	if result.PurchaseBonusParent != "RJ00000051" || *catalogCalls != 1 {
		t.Fatalf("result = %+v, catalog calls = %d; want RJ00000051 detected from one catalog read", result, *catalogCalls)
	}
	if status, parent, origin, evidence := purchaseBonusRow(t, db, "RJ00000052"); status != PurchaseBonusLinked ||
		parent != "RJ00000051" || origin != "detected" || evidence != "title_kana" {
		t.Fatalf("bonus row = %s %s %s %s", status, parent, origin, evidence)
	}

	// The bonus keeps its own title; its empty tags, credits and series come
	// from the parent, which is requested but never becomes a work.
	var title string
	if err := db.QueryRow(`SELECT title FROM work WHERE primary_code = 'RJ00000052'`).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "【早期購入特典】Example Voice 1" {
		t.Fatalf("bonus title = %q", title)
	}
	var parentWorks int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work WHERE primary_code IN ('RJ00000051', 'RJ00000053')`).Scan(&parentWorks); err != nil {
		t.Fatal(err)
	}
	if parentWorks != 0 {
		t.Fatalf("catalog products created %d works", parentWorks)
	}
	var snapshot string
	if err := db.QueryRow(`SELECT snapshot_json FROM metadata_snapshot JOIN work ON work.id = metadata_snapshot.work_id
		WHERE work.primary_code = 'RJ00000052'`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Product struct {
			WorkNo   string          `json:"workno"`
			Genres   []dlsite.Genre  `json:"genres"`
			Creators dlsite.Creators `json:"creaters"`
			Series   string          `json:"series_name"`
		} `json:"product"`
		Kikoto struct {
			ParentCode string   `json:"purchase_bonus_parent_code"`
			Inherited  []string `json:"purchase_bonus_inherited"`
		} `json:"_kikoto"`
	}
	if err := json.Unmarshal([]byte(snapshot), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Product.WorkNo != "RJ00000052" || len(envelope.Product.Genres) != 1 ||
		len(envelope.Product.Creators["voice_by"]) != 1 || envelope.Product.Series != "Example Series" {
		t.Fatalf("snapshot product = %+v", envelope.Product)
	}
	if envelope.Kikoto.ParentCode != "RJ00000051" || len(envelope.Kikoto.Inherited) != 3 {
		t.Fatalf("snapshot provenance = %+v", envelope.Kikoto)
	}
	var genres int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_dlsite_genre JOIN work ON work.id = work_dlsite_genre.work_id
		WHERE work.primary_code = 'RJ00000052'`).Scan(&genres); err != nil {
		t.Fatal(err)
	}
	if genres != 1 {
		t.Fatalf("bonus genres = %d, want the parent's genre", genres)
	}

	// A linked bonus reuses the link instead of reading the catalog again.
	if _, err := syncer.SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	if *catalogCalls != 1 {
		t.Fatalf("catalog calls = %d after a linked resync", *catalogCalls)
	}
}

func TestSyncFamilyRespectsPurchaseBonusDecisions(t *testing.T) {
	db := openTestDB(t)
	insertBonusTestWork(t, db, "RJ00000052")
	client, catalogCalls := purchaseBonusFixture()

	// Auto-link off: nothing is detected or recorded.
	if _, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(false, true).SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	if status, _, _, _ := purchaseBonusRow(t, db, "RJ00000052"); status != "" || *catalogCalls != 0 {
		t.Fatalf("auto-link off recorded %q after %d catalog reads", status, *catalogCalls)
	}

	// A user's dismissal stops detection even with auto-link on.
	if _, err := db.Exec(`INSERT INTO work_purchase_bonus (work_id, provider_id, status, origin)
		SELECT work.id, provider.id, 'dismissed', 'user' FROM work, metadata_provider AS provider
		WHERE work.primary_code = 'RJ00000052' AND provider.code = 'dlsite'`); err != nil {
		t.Fatal(err)
	}
	if _, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(true, true).SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	if status, _, origin, _ := purchaseBonusRow(t, db, "RJ00000052"); status != PurchaseBonusDismissed || origin != "user" || *catalogCalls != 0 {
		t.Fatalf("dismissed bonus became %q/%q after %d catalog reads", status, origin, *catalogCalls)
	}

	// A user's link is followed even with auto-link off.
	if _, err := db.Exec(`UPDATE work_purchase_bonus SET status = 'linked', parent_code = 'RJ00000051'`); err != nil {
		t.Fatal(err)
	}
	result, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(false, false).SyncFamily(context.Background(), "RJ00000052")
	if err != nil {
		t.Fatal(err)
	}
	var voices int
	if err := db.QueryRow(`SELECT json_array_length(snapshot_json, '$.product.creaters.voice_by') FROM metadata_snapshot
		JOIN work ON work.id = metadata_snapshot.work_id WHERE work.primary_code = 'RJ00000052'
		ORDER BY metadata_snapshot.id DESC LIMIT 1`).Scan(&voices); err != nil {
		t.Fatal(err)
	}
	if voices != 1 || result.PurchaseBonusParent != "" || *catalogCalls != 0 {
		t.Fatalf("user link inherited %d voices, result %+v, catalog reads %d", voices, result, *catalogCalls)
	}
}

func TestSyncFamilyRetriesUnmatchedPurchaseBonusOnlyOnRecheck(t *testing.T) {
	db := openTestDB(t)
	insertBonusTestWork(t, db, "RJ00000052")
	client, catalogCalls := purchaseBonusFixture()
	client.catalog = []string{"RJ00000053"}

	if _, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(true, false).SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	if status, parent, origin, evidence := purchaseBonusRow(t, db, "RJ00000052"); status != PurchaseBonusUnmatched ||
		parent != "" || origin != "detected" || evidence != "none" {
		t.Fatalf("unmatched row = %s %s %s %s", status, parent, origin, evidence)
	}
	if _, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(true, false).SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	if *catalogCalls != 1 {
		t.Fatalf("catalog calls = %d, want no retry without recheck", *catalogCalls)
	}
	client.catalog = []string{"RJ00000053", "RJ00000051"}
	if _, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(true, true).SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	if status, parent, _, _ := purchaseBonusRow(t, db, "RJ00000052"); status != PurchaseBonusLinked || parent != "RJ00000051" || *catalogCalls != 2 {
		t.Fatalf("recheck row = %s %s after %d catalog reads", status, parent, *catalogCalls)
	}
}

func TestSyncFamilyMatchesPurchaseBonusParentInLibraryWithoutCatalog(t *testing.T) {
	db := openTestDB(t)
	client, catalogCalls := purchaseBonusFixture()
	syncer := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(true, false)
	insertBonusTestWork(t, db, "RJ00000051")
	if _, err := syncer.SyncFamily(context.Background(), "RJ00000051"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES ('RJ00000052', 'Local folder')`); err != nil {
		t.Fatal(err)
	}
	if _, err := syncer.SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	if status, parent, _, _ := purchaseBonusRow(t, db, "RJ00000052"); status != PurchaseBonusLinked || parent != "RJ00000051" || *catalogCalls != 0 {
		t.Fatalf("library match = %s %s after %d catalog reads", status, parent, *catalogCalls)
	}
}

func TestLoadTargetsRevisitsStoredPurchaseBonusWithoutDecision(t *testing.T) {
	db := openTestDB(t)
	insertBonusTestWork(t, db, "RJ00000052")
	client, _ := purchaseBonusFixture()
	if _, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(false, false).SyncFamily(context.Background(), "RJ00000052"); err != nil {
		t.Fatal(err)
	}
	targets, _, err := NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(true, false).loadTargets(context.Background(), DLsiteSyncScope{})
	if err != nil {
		t.Fatal(err)
	}
	// RJ00000004 is the shared fixture's work without metadata.
	if len(targets) != 2 || targets[1].PrimaryCode != "RJ00000052" {
		t.Fatalf("targets = %+v, want the stored bonus", targets)
	}
	targets, _, err = NewDLsiteSyncer(db, client).WithPurchaseBonusLinking(false, false).loadTargets(context.Background(), DLsiteSyncScope{})
	if err != nil {
		t.Fatal(err)
	}
	if len(targets) != 1 || targets[0].PrimaryCode != "RJ00000004" {
		t.Fatalf("targets with auto-link off = %+v", targets)
	}
}
