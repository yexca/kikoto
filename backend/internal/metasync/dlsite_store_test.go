package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// A refresh whose dynamic request failed knows nothing about rating, sales, or
// prices, so it keeps the values and the snapshot counts stored before.
func TestApplyProductKeepsStoredDynamicFieldsWhenTheDynamicRequestFailed(t *testing.T) {
	db := openTestDB(t)
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{})
	ctx := context.Background()
	rating, sales, regular, current := 4.5, int64(120), int64(1100), int64(550)
	if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{
		WorkNo: "RJ00000004", ProductName: "Example Work",
		RateAverage2DP: &rating, SalesCount: &sales, RegularPrice: &regular, CurrentPrice: &current,
		Raw: json.RawMessage(`{"product":{"workno":"RJ00000004","product_name":"Example Work"},"dynamic":{"rate_count":7}}`),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{
		WorkNo: "RJ00000004", ProductName: "Example Work Renamed", DynamicUnavailable: true,
		Raw: json.RawMessage(`{"workno":"RJ00000004","product_name":"Example Work Renamed"}`),
	}); err != nil {
		t.Fatal(err)
	}

	var title, currency string
	var gotRating sql.NullFloat64
	var gotSales, gotRegular, gotCurrent sql.NullInt64
	var free sql.NullBool
	if err := db.QueryRow(`SELECT title, rating_average, sales_count, regular_price, current_price, price_currency, is_permanently_free
		FROM work WHERE primary_code = 'RJ00000004'`).Scan(&title, &gotRating, &gotSales, &gotRegular, &gotCurrent, &currency, &free); err != nil {
		t.Fatal(err)
	}
	if title != "Example Work Renamed" {
		t.Fatalf("title = %q, want the refreshed product title", title)
	}
	if gotRating.Float64 != rating || gotSales.Int64 != sales || gotRegular.Int64 != regular || gotCurrent.Int64 != current ||
		currency != "JPY" || !free.Valid || free.Bool {
		t.Fatalf("dynamic fields = rating %v, sales %v, prices %v/%v %q, free %v; want the stored values",
			gotRating, gotSales, gotRegular, gotCurrent, currency, free)
	}

	var snapshot string
	if err := db.QueryRow(`SELECT snapshot.snapshot_json FROM metadata_snapshot AS snapshot
		JOIN work ON work.id = snapshot.work_id WHERE work.primary_code = 'RJ00000004'
		ORDER BY snapshot.fetched_at DESC, snapshot.id DESC LIMIT 1`).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Product map[string]json.RawMessage `json:"product"`
		Dynamic map[string]json.RawMessage `json:"dynamic"`
	}
	if err := json.Unmarshal([]byte(snapshot), &envelope); err != nil {
		t.Fatal(err)
	}
	if string(envelope.Product["product_name"]) != `"Example Work Renamed"` || string(envelope.Dynamic["rate_count"]) != "7" {
		t.Fatalf("snapshot = %s, want the refreshed product with the stored dynamic section", snapshot)
	}
}

// Sync results are ordered by attempt: an older result applied after a newer
// one leaves every descriptive column as the newer result stored it.
func TestOlderProductResultLeavesNewerDescriptiveFields(t *testing.T) {
	db := openTestDB(t)
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{})
	attempt := func() context.Context {
		ctx, err := syncer.beginAttempt(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return ctx
	}
	older, newer := attempt(), attempt()
	if _, err := syncer.SyncProductOnly(newer, dlsite.Product{
		WorkNo: "RJ00000004", ProductName: "Example Work", WorkNameKana: "エグザンプル",
		IntroShort: "Newer description", AgeCategoryString: "general",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := syncer.SyncProductOnly(older, dlsite.Product{
		WorkNo: "RJ00000004", ProductName: "Stale Example Work", WorkNameKana: "ステイル",
		IntroShort: "Stale description", AgeCategoryString: "adult",
	}); err != nil {
		t.Fatal(err)
	}
	var title, kana, description, age string
	if err := db.QueryRow(`SELECT title, title_kana, description, age_rating FROM work WHERE primary_code = 'RJ00000004'`).
		Scan(&title, &kana, &description, &age); err != nil {
		t.Fatal(err)
	}
	if title != "Example Work" || kana != "エグザンプル" || description != "Newer description" || age != "general" {
		t.Fatalf("work = %q, %q, %q, %q; want the newer result", title, kana, description, age)
	}
}
