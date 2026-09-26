package storage

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreserveLegacyWorkflowsBeforeRemovalMigration(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 34)); err != nil {
		t.Fatal(err)
	}
	_, err := db.Exec(`INSERT INTO workflow_definition
		(id, code, display_name, description, definition_json, scope, editable)
		VALUES (9001, 'example_custom', 'Example Workflow', 'Synthetic', '{"schemaVersion":2,"nodes":[],"edges":[]}', 'user', 1)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO workflow_trigger
		(id, workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
		VALUES (9002, 9001, 'schedule', 'Example Trigger', 1, '{"intervalMinutes":60}', '{}')`)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := PreserveLegacyWorkflows(ctx, db, 34); err != nil {
		t.Fatal(err)
	}
	if err := PreserveLegacyWorkflows(ctx, db, 34); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}
	var original, triggers, status string
	if err := db.QueryRow(`SELECT definition_json, triggers_json, review_status
		FROM legacy_workflow_snapshot WHERE original_id = 9001`).Scan(&original, &triggers, &status); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(original, `"schemaVersion":2`) || !strings.Contains(triggers, `"id":9002`) || status != "pending" {
		t.Fatalf("preserved workflow = %q %q %q", original, triggers, status)
	}
	var remaining int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_definition WHERE id = 9001`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("legacy definition still active: %d", remaining)
	}
}
