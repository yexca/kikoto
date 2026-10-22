package workflow

import (
	"context"
	"testing"
)

// Activity names a run by the one work, circle, or voice actor it acts on and
// finds the run by that subject, so runs of one workflow can be told apart.
func TestRunsExposeAndMatchTheirSubject(t *testing.T) {
	db := openWorkflowTestDB(t)
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, "INSERT INTO person(id, display_name) VALUES (7, 'Example Voice')"); err != nil {
		t.Fatal(err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	insert := func(code string, input map[string]any) int64 {
		t.Helper()
		definitionID, err := EnsureDefinition(ctx, tx, code, code, "Synthetic", map[string]any{})
		if err != nil {
			t.Fatal(err)
		}
		runID, err := InsertRun(ctx, tx, definitionID, code, code, "queued", "manual", "synthetic", input, nil)
		if err != nil {
			t.Fatal(err)
		}
		return runID
	}
	fetchRunID := insert("remote_work_fetch", map[string]any{"work_code": "rj00000050"})
	circleRunID := insert("circle_catalog_sync", map[string]any{"inputs": map[string]any{"circleId": "rg00000000"}})
	voiceRunID := insert("voice_catalog_sync", map[string]any{"inputs": map[string]any{"personId": 7}})
	scopedRunID := insert("metadata_sync", map[string]any{"scope": "circle", "circleId": "RG00000001"})
	allRunID := insert("metadata_sync", map[string]any{"scope": "all"})
	// Another workflow's input that happens to carry a code has no subject.
	insert("example_workflow", map[string]any{"work_code": "RJ00000051"})
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	for query, want := range map[string]struct {
		runID   int64
		subject string
	}{
		"rj00000050":    {fetchRunID, "RJ00000050"},
		"RG00000000":    {circleRunID, "RG00000000"},
		"example voice": {voiceRunID, "Example Voice"},
		"rg00000001":    {scopedRunID, "RG00000001"},
	} {
		page, err := store.ListRuns(ctx, ListRunsOptions{CanViewAll: true, Query: query})
		if err != nil {
			t.Fatal(err)
		}
		if page.Total != 1 || page.Runs[0].ID != want.runID || page.Runs[0].Subject != want.subject {
			t.Fatalf("search %q = %+v", query, page.Runs)
		}
	}
	run, err := store.LoadRun(ctx, allRunID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Subject != "" {
		t.Fatalf("a library-wide sync has no subject: %q", run.Subject)
	}
	page, err := store.ListRuns(ctx, ListRunsOptions{CanViewAll: true, Query: "RJ00000051"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 {
		t.Fatalf("an input code outside a subject must not match: %+v", page.Runs)
	}
}
