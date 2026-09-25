package workflow

import (
	"context"
	"testing"
)

// Activity names a Fetch run by the work it downloads and finds it by code.
func TestFetchRunsExposeAndMatchTheirWorkCode(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	definitionID, err := EnsureDefinition(ctx, tx, "remote_work_fetch", "Fetch remote work", "Synthetic", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	fetchRunID, err := InsertRun(ctx, tx, definitionID, "remote_work_fetch", "Fetch RJ00000050", "queued", "manual", "fetch_selected", map[string]any{"work_code": "rj00000050"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	exampleID, err := EnsureDefinition(ctx, tx, "example_workflow", "Example workflow", "Synthetic", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	// Another workflow's input that happens to carry a code is not a Fetch.
	if _, err := InsertRun(ctx, tx, exampleID, "example_workflow", "Example", "queued", "manual", "synthetic", map[string]any{"work_code": "RJ00000051"}, nil); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	page, err := store.ListRuns(ctx, ListRunsOptions{CanViewAll: true, Query: "rj00000050"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 || page.Runs[0].ID != fetchRunID || page.Runs[0].WorkCode != "RJ00000050" {
		t.Fatalf("fetch search = %+v", page.Runs)
	}
	page, err = store.ListRuns(ctx, ListRunsOptions{CanViewAll: true, Query: "RJ00000051"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 {
		t.Fatalf("a non-Fetch input code must not match: %+v", page.Runs)
	}
}
