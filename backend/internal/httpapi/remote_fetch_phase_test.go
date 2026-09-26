package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRemoteFetchPublicationFailureNodeFollowsTheStepInProgress(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	statements := []string{
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'running', 'manual')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status) VALUES
			(4, 1, 'cache', 'materialize_cache', 'Cache selected files', 4, 'succeeded'),
			(5, 1, 'stage', 'stage_files', 'Assemble staging directory', 5, 'running'),
			(6, 1, 'verify', 'verify_files', 'Verify staged files', 6, 'queued'),
			(7, 1, 'promote', 'publish_files', 'Publish staged result', 7, 'queued')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	if got := server.remoteFetchPublicationFailureNode(ctx, 1, 7); got != 5 {
		t.Fatalf("staging failure node = %d, want Assemble (5)", got)
	}
	if _, err := db.Exec(`UPDATE workflow_node_run SET status = 'succeeded' WHERE id = 5`); err != nil {
		t.Fatal(err)
	}
	if got := server.remoteFetchPublicationFailureNode(ctx, 1, 7); got != 6 {
		t.Fatalf("verification failure node = %d, want Verify (6)", got)
	}
	if _, err := db.Exec(`UPDATE workflow_node_run SET status = 'succeeded' WHERE id IN (6, 7)`); err != nil {
		t.Fatal(err)
	}
	if got := server.remoteFetchPublicationFailureNode(ctx, 1, 7); got != 7 {
		t.Fatalf("fallback node = %d, want Publish (7)", got)
	}
}
