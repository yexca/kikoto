-- Keep the original, account-owned workflow configuration from releases that
-- predate migration 035. The upgrade hook creates this same table and copies
-- those rows before 035 removes the old definitions and triggers.
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
);

CREATE TABLE legacy_workflow_trigger_migration (
  original_trigger_id INTEGER PRIMARY KEY,
  original_definition_id INTEGER NOT NULL REFERENCES legacy_workflow_snapshot(original_id) ON DELETE CASCADE,
  new_trigger_id INTEGER NOT NULL REFERENCES workflow_trigger(id) ON DELETE CASCADE
);

CREATE TABLE library_layout_migration (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  status TEXT NOT NULL CHECK(status IN ('running', 'failed', 'completed')),
  phase TEXT NOT NULL,
  requested_json TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_bytes_current INTEGER NOT NULL DEFAULT 0,
  progress_bytes_total INTEGER NOT NULL DEFAULT 0,
  scan_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
