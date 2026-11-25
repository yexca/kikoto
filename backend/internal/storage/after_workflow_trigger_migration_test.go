package storage

import (
	"path/filepath"
	"testing"
)

// Migration 104 moves the automation that started downstream operations onto
// After triggers: a local scan's followUpRun becomes the metadata sync's After
// trigger and leaves the scan's triggers, and the file index's and media
// details' Startup triggers become After triggers that keep whether they are on.
func TestMigrationMovesFollowUpAndDownstreamStartupOntoAfterTriggers(t *testing.T) {
	sourceDir := filepath.Join("..", "..", "migrations")
	db := openMigratedThrough(t, 103)
	for _, statement := range []string{
		`INSERT INTO workflow_definition (id, code, display_name, scope, editable)
			VALUES (901, 'local_media_index', 'Refresh local work files', 'system', 0),
				(902, 'record_media_probe', 'Read record media details', 'system', 0)`,
		`UPDATE workflow_trigger SET enabled = 0, config_json = '{"followUpRun":true}'
			WHERE trigger_type = 'startup' AND workflow_definition_id = (SELECT id FROM workflow_definition WHERE code = 'local_library_scan')`,
		`UPDATE workflow_trigger SET config_json = '{"followUpRun":false,"scanMode":"full"}'
			WHERE trigger_type = 'filesystem_event'`,
		`INSERT INTO workflow_trigger (id, workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
			VALUES (911, (SELECT id FROM workflow_definition WHERE code = 'local_library_scan'), 'schedule', 'Nightly scan', 1, '{"intervalMinutes":1440}', '{"followUpRun":true,"scanMode":"full"}'),
				(912, 901, 'startup', 'Index at startup', 1, '{"type":"startup"}', '{"mode":"full"}'),
				(913, 901, 'schedule', 'Index weekly', 1, '{"intervalMinutes":10080}', '{"mode":"full"}'),
				(914, 902, 'startup', 'Media details at startup', 0, '{"type":"startup"}', '{}')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}
	if err := Migrate(db, copyNumberedMigrationsThrough(t, sourceDir, 104)); err != nil {
		t.Fatal(err)
	}

	var enabled int
	var schedule, config string
	if err := db.QueryRow(`SELECT trigger.enabled, trigger.schedule_json, trigger.config_json
		FROM workflow_trigger AS trigger INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'metadata_sync' AND trigger.trigger_type = 'after_workflow'`).Scan(&enabled, &schedule, &config); err != nil {
		t.Fatalf("metadata after trigger: %v", err)
	}
	// One of the two scan triggers that asked for a follow-up was on.
	if enabled != 1 || schedule != `{"after":"local_library_scan"}` || config != `{}` {
		t.Fatalf("metadata after trigger = enabled %d, schedule %s, config %s", enabled, schedule, config)
	}

	var leftover int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_trigger
		WHERE json_type(config_json, '$.followUpRun') IS NOT NULL`).Scan(&leftover); err != nil {
		t.Fatal(err)
	}
	if leftover != 0 {
		t.Fatalf("%d triggers still store followUpRun", leftover)
	}
	if err := db.QueryRow(`SELECT config_json FROM workflow_trigger WHERE id = 911`).Scan(&config); err != nil || config != `{"scanMode":"full"}` {
		t.Fatalf("scan trigger config = %q, %v", config, err)
	}

	for _, want := range []struct {
		id             int64
		triggerType    string
		enabled        int
		schedule, conf string
	}{
		{912, "after_workflow", 1, `{"after":"local_library_scan"}`, `{"mode":"incremental"}`},
		{913, "schedule", 1, `{"intervalMinutes":10080}`, `{"mode":"full"}`},
		{914, "after_workflow", 0, `{"after":"record_library_scan"}`, `{}`},
	} {
		var triggerType string
		if err := db.QueryRow(`SELECT trigger_type, enabled, schedule_json, config_json FROM workflow_trigger WHERE id = ?`, want.id).
			Scan(&triggerType, &enabled, &schedule, &config); err != nil {
			t.Fatal(err)
		}
		if triggerType != want.triggerType || enabled != want.enabled || schedule != want.schedule || config != want.conf {
			t.Fatalf("trigger %d = %s enabled %d %s %s, want %+v", want.id, triggerType, enabled, schedule, config, want)
		}
	}

	if _, err := db.Exec(`INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, schedule_json)
		VALUES (901, 'after_workflow', 'Accepted type', '{"after":"local_library_scan"}')`); err != nil {
		t.Fatalf("after_workflow rejected: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name)
		VALUES (901, 'after_everything', 'Unknown type')`); err == nil {
		t.Fatal("an unknown trigger type was accepted")
	}
}
