package workflow

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Recovery must clear current attention without changing historical failure,
// and a later provider failure must not reopen the old run's association.
func TestAttentionTracksMetadataRecoveryAndViewerReviews(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	statements := []string{
		`INSERT INTO user_account(id,username,role) VALUES(1,'example_admin_a','admin'),(2,'example_admin_b','admin')`,
		`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type) VALUES
   (11,'metadata_sync','Example metadata','failed','manual'),
   (12,'remote_work_fetch','Example fetch','failed','manual'),
   (13,'local_library_scan','Example review','partial','manual'),
   (14,'local_library_scan','Example active','running','manual'),
   (15,'local_library_scan','Example cancelled','cancelled','manual'),
   (16,'metadata_sync','Example unrecorded failure','failed','manual')`,
		`INSERT INTO workflow_candidate(workflow_run_id,candidate_type,status) VALUES(13,'example_review','pending')`,
		`INSERT INTO metadata_sync_attempt(id) VALUES(2),(3),(4)`,
		`INSERT INTO metadata_sync_attempt_run(attempt_id,workflow_run_id) VALUES(2,11)`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO work(id,primary_code,title) VALUES(1,?,'Example work')`, testfixture.WorkCode(testfixture.PrefixRJ, 0)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO metadata_sync_attempt_work(attempt_id,work_id,provider_id,component,status) SELECT 2,1,id,'metadata','failed' FROM metadata_provider WHERE code='dlsite'`,
		`INSERT INTO work_metadata_sync_state(work_id,provider_id,component,attempt_id,status) SELECT 1,id,'metadata',2,'failed' FROM metadata_provider WHERE code='dlsite'`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	store := NewStore(db)
	list := func(view string, viewer int64) RunsPage {
		t.Helper()
		result, err := store.ListRuns(ctx, ListRunsOptions{View: view, Page: 1, PageSize: 100, ViewerUserID: viewer, CanViewAll: true})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	first := list("attention", 1)
	if first.Total != 4 || first.ViewTotals.Attention != 4 || first.ViewTotals.History != 1 || first.ViewTotals.Running != 1 {
		t.Fatalf("initial counts: %#v", first)
	}
	if _, err := db.ExecContext(ctx, `UPDATE work_metadata_sync_state SET status='succeeded',attempt_id=3,last_success_attempt_id=3`); err != nil {
		t.Fatal(err)
	}
	history := list("history", 1)
	if history.Total != 2 || history.ViewTotals.Attention != 3 {
		t.Fatalf("resolved counts: %#v", history)
	}
	found := false
	for _, run := range history.Runs {
		if run.ID == 11 {
			found = true
			if run.Status != "failed" || run.PendingMetadata != 0 {
				t.Fatalf("history changed: %#v", run)
			}
		}
	}
	if !found {
		t.Fatal("resolved metadata run missing from history")
	}
	if _, err := db.ExecContext(ctx, `UPDATE work_metadata_sync_state SET status='failed',attempt_id=4`); err != nil {
		t.Fatal(err)
	}
	if got := list("attention", 1); got.Total != 3 {
		t.Fatalf("later failure reopened old run: %#v", got)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO workflow_run_review(workflow_run_id,user_id,status,reviewed_at) VALUES(12,1,'reviewed',CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	if got := list("attention", 1); got.Total != 2 {
		t.Fatalf("viewer acknowledgement missing: %#v", got)
	}
	if got := list("attention", 2); got.Total != 3 {
		t.Fatalf("another viewer's acknowledgement leaked: %#v", got)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO workflow_run_review(workflow_run_id,user_id,status,reviewed_at) VALUES(13,1,'reviewed',CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	if got := list("attention", 1); got.Total != 2 {
		t.Fatalf("review hid pending candidate: %#v", got)
	}
	page, err := store.ListRuns(ctx, ListRunsOptions{View: "attention", Page: 2, PageSize: 1, ViewerUserID: 1, CanViewAll: true})
	if err != nil || page.Total != 2 || len(page.Runs) != 1 || page.Runs[0].ID != 13 {
		t.Fatalf("attention pagination: %#v %v", page, err)
	}
}
