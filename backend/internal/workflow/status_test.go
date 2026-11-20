package workflow

import (
	"context"
	"fmt"
	"testing"
)

// A workflow's status must hold however many runs are queued: a running run
// older than a long queue still states it, and the count covers every run.
func TestDefinitionStatusesHoldBeyondTheFirstFiftyActiveRuns(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, statement, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type,created_at) VALUES(99,'local_library_scan','Example running','running','manual','2026-07-01 00:00:00')`)
	for index := 0; index < 60; index++ {
		exec(`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type,created_at) VALUES(?,'local_library_scan','Example queued','queued','manual',?)`,
			100+index, fmt.Sprintf("2026-07-02 00:%02d:00", index))
	}
	// Ended with a candidate still waiting for a decision, then a newer run starts.
	exec(`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type,created_at) VALUES(300,'metadata_sync','Example review','partial','manual','2026-07-01 00:00:00')`)
	exec(`INSERT INTO workflow_candidate(workflow_run_id,candidate_type,status) VALUES(300,'example_review','pending')`)
	exec(`UPDATE workflow_definition SET definition_json = '{"nodes":[{"id":"a","type":"x"},{"id":"b","type":"y"},{"type":"z"},"bad"]}' WHERE code = 'metadata_sync'`)
	for _, nextRunAt := range []struct {
		enabled int
		at      string
	}{{1, "2026-07-05 00:00:00"}, {1, "2026-07-04 00:00:00"}, {0, "2026-07-03 00:00:00"}} {
		exec(`INSERT INTO workflow_trigger(workflow_definition_id,trigger_type,display_name,enabled,next_run_at)
			SELECT id,'schedule','Example schedule',?,? FROM workflow_definition WHERE code = 'local_library_scan'`, nextRunAt.enabled, nextRunAt.at)
	}

	store := NewStore(db)
	statuses := func() map[string]DefinitionStatus {
		t.Helper()
		list, err := store.ListDefinitionStatuses(ctx, StatusOptions{
			Codes:        []string{"local_library_scan", "metadata_sync", "remote_source_sync"},
			ViewerUserID: 1, CanViewAll: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		byCode := map[string]DefinitionStatus{}
		for _, status := range list {
			byCode[status.Code] = status
		}
		return byCode
	}

	got := statuses()
	if len(got) != 3 {
		t.Fatalf("statuses = %#v", got)
	}
	scan := got["local_library_scan"]
	if scan.ActiveRuns != 61 || scan.CurrentRun == nil || scan.CurrentRun.ID != 99 || scan.LatestRun == nil || scan.LatestRun.ID != 159 {
		t.Fatalf("scan status = %#v", scan)
	}
	if scan.NextRunAt == nil || *scan.NextRunAt != "2026-07-04 00:00:00" {
		t.Fatalf("next run = %v, want the soonest enabled schedule", scan.NextRunAt)
	}
	metadata := got["metadata_sync"]
	if metadata.StageCount != 2 || !metadata.NeedsReview || metadata.CurrentRun == nil || metadata.CurrentRun.ID != 300 || metadata.ActiveRuns != 0 {
		t.Fatalf("metadata status = %#v", metadata)
	}
	if never := got["remote_source_sync"]; never.LatestRun != nil || never.CurrentRun != nil || never.NeedsReview || never.NextRunAt != nil {
		t.Fatalf("never-run status = %#v", never)
	}

	// A newer running run states the status, and a run in progress asks for no review.
	exec(`INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type,created_at) VALUES(301,'metadata_sync','Example running','running','manual','2026-07-03 00:00:00')`)
	metadata = statuses()["metadata_sync"]
	if metadata.CurrentRun == nil || metadata.CurrentRun.ID != 301 || metadata.NeedsReview || metadata.ActiveRuns != 1 {
		t.Fatalf("metadata status with a running run = %#v", metadata)
	}
}
