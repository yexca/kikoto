package metasync

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestMetadataRecoveryOrdersResultsAndPreservesContent(t *testing.T) {
	db := openTestDB(t)
	s := NewDLsiteSyncer(db, fakeDLsiteClient{})
	code := testfixture.WorkCode(testfixture.PrefixRJ, 4)
	var workID int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil {
		t.Fatal(err)
	}
	product := func(title string) dlsite.Product {
		raw, _ := json.Marshal(map[string]string{"workno": code, "product_name": title})
		return dlsite.Product{WorkNo: code, ProductName: title, Raw: raw}
	}
	attempt := func() context.Context {
		ctx, err := s.beginAttempt(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return ctx
	}
	outcome := func(ctx context.Context, component string, err error) {
		if stateErr := s.recordCodeOutcome(ctx, code, component, err); stateErr != nil {
			t.Fatal(stateErr)
		}
	}
	apply := func(ctx context.Context, title string) {
		if err := s.applyProduct(ctx, workID, product(title)); err != nil {
			t.Fatal(err)
		}
	}
	assertState := func(status, title string, failures int) {
		t.Helper()
		var gotStatus, gotTitle string
		var gotCount int
		if err := db.QueryRow(`SELECT state.status, work.title, state.failure_count FROM work_metadata_sync_state AS state JOIN work ON work.id = state.work_id WHERE work.id = ? AND state.component = 'metadata'`, workID).Scan(&gotStatus, &gotTitle, &gotCount); err != nil {
			t.Fatal(err)
		}
		if gotStatus != status || gotTitle != title || gotCount != failures {
			t.Fatalf("state = %s, %q, %d; want %s, %q, %d", gotStatus, gotTitle, gotCount, status, title, failures)
		}
	}
	first := attempt()
	outcome(first, "metadata", errors.New("temporary upstream failure"))
	outcome(first, "metadata", errors.New("same attempt reported twice"))
	assertState("failed", "Local title", 1)
	second := attempt()
	outcome(second, "metadata", dlsite.ErrNoProduct)
	assertState("unavailable", "Local title", 2)
	oldSuccess := attempt()
	fresh := attempt()
	apply(fresh, "Updated provider title")
	outcome(second, "metadata", dlsite.ErrNoProduct)
	apply(oldSuccess, "Stale provider title")
	assertState("succeeded", "Updated provider title", 0)
	var availability string
	if err := db.QueryRow(`SELECT status FROM work_metadata_provider_state WHERE work_id = ?`, workID).Scan(&availability); err != nil || availability != "available" {
		t.Fatalf("availability=%q, err=%v", availability, err)
	}
	latest := attempt()
	outcome(latest, "metadata", errors.New("new refresh failed"))
	assertState("failed", "Updated provider title", 1)
	outcome(latest, "cover", errors.New("cover failed"))
	store := NewIssueStore(db)
	page, err := store.List(context.Background(), IssueQuery{Page: 1, PageSize: 25})
	if err != nil || page.Total != 1 || len(page.Items) != 1 || len(page.Items[0].Issues) != 2 {
		t.Fatalf("grouped issues=%+v, err=%v", page, err)
	}
	recovered := attempt()
	apply(recovered, "Newest provider title")
	page, err = store.List(context.Background(), IssueQuery{Page: 1, PageSize: 25})
	if err != nil || page.Total != 1 || len(page.Items[0].Issues) != 1 || page.Items[0].Issues[0].Component != "cover" {
		t.Fatalf("cover must remain pending: %+v, %v", page, err)
	}
	outcome(recovered, "cover", nil)
	page, err = store.List(context.Background(), IssueQuery{Page: 1, PageSize: 25})
	if err != nil || page.Total != 0 {
		t.Fatalf("resolved issues=%+v, %v", page, err)
	}
}

func TestMetadataIssuesTrackRunsWithoutChangingTheirHistory(t *testing.T) {
	db := openTestDB(t)
	s := NewDLsiteSyncer(db, fakeDLsiteClient{})
	for _, id := range []int{1, 2} {
		if _, err := db.Exec(`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type) VALUES (?,'metadata_sync','Metadata sync','failed','manual')`, id); err != nil {
			t.Fatal(err)
		}
	}
	code := testfixture.WorkCode(testfixture.PrefixRJ, 4)
	for _, runID := range []int64{1, 2} {
		ctx, err := s.beginAttempt(WithWorkflowRun(context.Background(), runID))
		if err != nil {
			t.Fatal(err)
		}
		// A family attempt can store a product before a later required metadata
		// step fails. Its final failure must still be reachable from Activity.
		if runID == 1 {
			if err := s.recordCodeOutcome(ctx, code, "metadata", nil); err != nil {
				t.Fatal(err)
			}
		}
		if err := s.recordCodeOutcome(ctx, code, "metadata", errors.New("failure")); err != nil {
			t.Fatal(err)
		}
	}
	store := NewIssueStore(db)
	for _, runID := range []int64{1, 2} {
		summary, err := store.ForRun(context.Background(), runID)
		if err != nil || summary.Encountered != 1 || summary.Pending != 1 {
			t.Fatalf("run %d summary=%+v, %v", runID, summary, err)
		}
		page, err := store.List(context.Background(), IssueQuery{Page: 1, PageSize: 25, RunID: runID, Search: code})
		if err != nil || page.Total != 1 {
			t.Fatalf("run filter=%+v, %v", page, err)
		}
	}
	if err := s.recordCodeOutcome(context.Background(), code, "metadata", nil); err != nil {
		t.Fatal(err)
	}
	for _, runID := range []int64{1, 2} {
		summary, err := store.ForRun(context.Background(), runID)
		if err != nil || summary.Encountered != 1 || summary.Pending != 0 {
			t.Fatalf("resolved run %d=%+v, %v", runID, summary, err)
		}
		var status string
		if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&status); err != nil || status != "failed" {
			t.Fatalf("history changed: %q, %v", status, err)
		}
	}
	// An old run stays resolved if the same work fails again in a later attempt.
	if err := s.recordCodeOutcome(context.Background(), code, "metadata", errors.New("later refresh")); err != nil {
		t.Fatal(err)
	}
	summary, err := store.ForRun(context.Background(), 1)
	if err != nil || summary.Pending != 0 {
		t.Fatalf("resolved old run reopened: %+v, %v", summary, err)
	}
	page, err := store.List(context.Background(), IssueQuery{Page: 1, PageSize: 25, RunID: 1})
	if err != nil || page.Total != 0 {
		t.Fatalf("old run includes new failures: %+v, %v", page, err)
	}
}

func TestMetadataFailuresDoNotMaterializeUnknownWorksOrRecordCancellation(t *testing.T) {
	db := openTestDB(t)
	s := NewDLsiteSyncer(db, fakeDLsiteClient{})
	if err := s.recordCodeOutcome(context.Background(), testfixture.WorkCode(testfixture.PrefixRJ, 90), "metadata", dlsite.ErrNoProduct); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := s.recordCodeOutcome(ctx, testfixture.WorkCode(testfixture.PrefixRJ, 4), "metadata", context.Canceled); err != nil {
		t.Fatal(err)
	}
	var works, issues int
	if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_metadata_sync_state").Scan(&issues); err != nil {
		t.Fatal(err)
	}
	if works != 1 || issues != 0 {
		t.Fatalf("works=%d issues=%d", works, issues)
	}
}
