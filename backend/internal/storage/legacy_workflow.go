package storage

import (
	"context"
	"database/sql"
	"fmt"
)

// PreserveLegacyWorkflows runs before numbered migration 035 can remove user
// definitions. It is safe to repeat after an interrupted upgrade. Snapshot
// rows belong to the protected database and are never logged.
func PreserveLegacyWorkflows(ctx context.Context, db *sql.DB, fromVersion int) error {
	if fromVersion >= 35 {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS legacy_workflow_snapshot (
		  original_id INTEGER PRIMARY KEY,
		  code TEXT NOT NULL,
		  display_name TEXT NOT NULL,
		  description TEXT NOT NULL DEFAULT '',
		  definition_json TEXT NOT NULL,
		  owner_user_id INTEGER,
		  created_by_user_id INTEGER,
		  triggers_json TEXT NOT NULL DEFAULT '[]',
		  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending', 'converted', 'skipped')),
		  converted_preset_code TEXT NOT NULL DEFAULT '',
		  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`); err != nil {
		return fmt.Errorf("prepare legacy workflow preservation: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO legacy_workflow_snapshot
		  (original_id, code, display_name, description, definition_json, owner_user_id,
		   created_by_user_id, triggers_json)
		SELECT definition.id, definition.code, definition.display_name, definition.description,
		       definition.definition_json, definition.owner_user_id, definition.created_by_user_id,
		       COALESCE((
		         SELECT json_group_array(json_object(
		           'id', trigger.id, 'type', trigger.trigger_type,
		           'name', trigger.display_name, 'enabled', trigger.enabled,
		           'schedule', json(trigger.schedule_json), 'config', json(trigger.config_json)))
		         FROM workflow_trigger AS trigger
		         WHERE trigger.workflow_definition_id = definition.id
		       ), '[]')
		FROM workflow_definition AS definition
		WHERE definition.scope = 'user'
	`)
	if err != nil {
		return fmt.Errorf("preserve legacy workflows: %w", err)
	}
	return tx.Commit()
}
