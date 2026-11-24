package storage

import (
	"path/filepath"
	"testing"
)

// Migration 103 rebuilds translation_item and llm_translation_task without
// their unused columns. Translate with AI items keep their review state and
// results, retired translation tasks keep their outcome, and an object still
// cannot be requested twice while an earlier request is active.
func TestMigrationDroppingUnusedSchemaKeepsTranslationHistory(t *testing.T) {
	db := openMigratedThrough(t, 102)
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'translator', 'Example Translator', 'admin');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work');
		INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES
			(1, 'ai_translation', 'Example Translation', 'succeeded', 'manual'),
			(2, 'llm_translation', 'Example Retired Translation', 'failed', 'manual');
		INSERT INTO translation_item (id, workflow_run_id, work_id, requested_by_user_id, language, category, dedup_key, state, result_text, reviewed_by_user_id, reviewed_at)
		VALUES
			(1, 1, 1, 1, 'en-us', 'title', 'en-us:title::1', 'accepted', 'Example Title', 1, '2026-01-02 00:00:00'),
			(2, 1, 1, 1, 'zh-cn', 'title', 'zh-cn:title::1', 'ready', 'Example Ready Title', NULL, NULL);
		INSERT INTO llm_translation_task (id, workflow_run_id, user_id, work_id, dedup_key, input_hash, policy_hash, config_hash, request_json, state, failure_code)
		VALUES (1, 2, 1, 1, 'example-task', 'hash', 'hash', 'hash', '{}', 'invalid', 'translation_replaced');
	`); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}

	var state, result, reviewedAt string
	var reviewer int64
	if err := db.QueryRow(`SELECT state, result_text, reviewed_by_user_id, reviewed_at FROM translation_item WHERE id = 1`).Scan(&state, &result, &reviewer, &reviewedAt); err != nil {
		t.Fatal(err)
	}
	if state != "accepted" || result != "Example Title" || reviewer != 1 || reviewedAt != "2026-01-02 00:00:00" {
		t.Fatalf("accepted item = %s/%q/%d/%s", state, result, reviewer, reviewedAt)
	}
	var taskState, taskFailure string
	if err := db.QueryRow(`SELECT state, failure_code FROM llm_translation_task WHERE dedup_key = 'example-task'`).Scan(&taskState, &taskFailure); err != nil {
		t.Fatal(err)
	}
	if taskState != "invalid" || taskFailure != "translation_replaced" {
		t.Fatalf("retired task = %s/%s", taskState, taskFailure)
	}
	if _, err := db.Exec(`INSERT INTO translation_item (workflow_run_id, work_id, language, category, dedup_key, state) VALUES (1, 1, 'zh-cn', 'title', 'zh-cn:title::1', 'queued')`); err == nil {
		t.Fatal("a second active request for an object waiting for review was accepted")
	}
	if _, err := db.Exec(`INSERT INTO translation_item (workflow_run_id, work_id, language, category, dedup_key, state) VALUES (1, 1, 'en-us', 'title', 'en-us:title::1', 'queued')`); err != nil {
		t.Fatalf("a new request for an accepted object: %v", err)
	}
}
