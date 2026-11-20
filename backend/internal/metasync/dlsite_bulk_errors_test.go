package metasync

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func bulkSyncProduct(code string) dlsite.Product {
	return dlsite.Product{
		WorkNo: code, SiteID: "maniax", ProductName: "DLsite title",
		Raw: json.RawMessage(`{"workno":"` + code + `","product_name":"DLsite title"}`),
	}
}

// A timeout of one work skips that work: the run continues with the others
// and finishes partial.
func TestSyncAllSkipsAWorkThatTimesOut(t *testing.T) {
	db := openTestDB(t)
	if _, err := db.Exec("INSERT INTO work(primary_code,title) VALUES ('RJ00000005','Local title')"); err != nil {
		t.Fatal(err)
	}
	calls := map[string]int{}
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{
		calls:    calls,
		errors:   map[string]error{"RJ00000004": context.DeadlineExceeded},
		products: map[string]dlsite.Product{"RJ00000005": bulkSyncProduct("RJ00000005")},
	}).WithRequestPacing(0, 0, 0)

	result, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatalf("a timeout of one work stopped the run: %v", err)
	}
	if result.Status != "partial" || result.SyncedWorks != 1 || result.FailedWorks != 1 {
		t.Fatalf("result = %+v, want partial with one synced and one failed work", result)
	}
	if calls["RJ00000005"] == 0 {
		t.Fatal("the run did not continue after the timed-out work")
	}
}

// Rate limiting that bounded retries do not clear stops the run, so it can be
// retried later instead of spending the remaining works on the same refusal.
func TestSyncAllStopsWhenRateLimitingPersists(t *testing.T) {
	db := openTestDB(t)
	if _, err := db.Exec("INSERT INTO work(primary_code,title) VALUES ('RJ00000005','Local title')"); err != nil {
		t.Fatal(err)
	}
	calls := map[string]int{}
	limited := dlsite.HTTPStatusError{Operation: "dlsite maniax", Status: "503 Service Unavailable", StatusCode: 503, RetryAfter: "1"}
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{
		calls:    calls,
		errors:   map[string]error{"RJ00000004": limited},
		products: map[string]dlsite.Product{"RJ00000005": bulkSyncProduct("RJ00000005")},
	}).WithRequestPacing(0, 0, 0)

	_, err := syncer.SyncAll(context.Background())
	if !dlsite.IsRateLimited(err) {
		t.Fatalf("error = %v, want the rate limit", err)
	}
	if calls["RJ00000004"] != 3 {
		t.Fatalf("rate-limited requests = %d, want 3 bounded attempts", calls["RJ00000004"])
	}
	if calls["RJ00000005"] != 0 {
		t.Fatal("the run went on after persistent rate limiting")
	}
}
