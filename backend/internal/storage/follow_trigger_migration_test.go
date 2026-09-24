package storage

import (
	"path/filepath"
	"testing"
)

// Migration 039 disables follow triggers saved with the retired follow inputs
// and asks for reconfiguration; other workflow triggers keep running.
func TestMigrationDisablesFollowTriggersForReconfiguration(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigrationManagerDB(t)
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 38)); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`INSERT INTO workflow_definition (id, code, display_name, description, definition_json, scope, editable)
			VALUES (101, 'circle_follow', 'Follow a circle', '', '{}', 'system', 0),
				(102, 'metadata_sync_example', 'Sync work metadata', '', '{}', 'system', 0)`,
		`INSERT INTO workflow_trigger (id, workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json, next_run_at)
			VALUES (201, 101, 'schedule', 'Weekly follow', 1, '{"intervalMinutes":10080}', '{"userId":1,"inputs":{"circleId":"RG00001","newWorks":true,"action":"track","sourceId":1}}', '2026-01-01 00:00:00'),
				(202, 102, 'schedule', 'Daily metadata', 1, '{"intervalMinutes":1440}', '{}', '2026-01-01 00:00:00')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, sourceDir); err != nil {
		t.Fatal(err)
	}
	var enabled int
	var nextRunAt *string
	var message, config string
	if err := db.QueryRow("SELECT enabled, next_run_at, last_error_message, config_json FROM workflow_trigger WHERE id = 201").Scan(&enabled, &nextRunAt, &message, &config); err != nil {
		t.Fatal(err)
	}
	if enabled != 0 || nextRunAt != nil || message == "" || config == "{}" {
		t.Fatalf("follow trigger = enabled %d, next %v, message %q, config %s", enabled, nextRunAt, message, config)
	}
	if err := db.QueryRow("SELECT enabled, last_error_message FROM workflow_trigger WHERE id = 202").Scan(&enabled, &message); err != nil {
		t.Fatal(err)
	}
	if enabled != 1 || message != "" {
		t.Fatalf("unrelated trigger = enabled %d, message %q", enabled, message)
	}
}
