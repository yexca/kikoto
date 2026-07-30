CREATE UNIQUE INDEX idx_workflow_trigger_filesystem_definition
  ON workflow_trigger(workflow_definition_id)
  WHERE trigger_type = 'filesystem_event';

CREATE TABLE filesystem_trigger_state (
  trigger_id INTEGER PRIMARY KEY REFERENCES workflow_trigger(id) ON DELETE CASCADE,
  baseline_hash TEXT NOT NULL DEFAULT '',
  candidate_hash TEXT NOT NULL DEFAULT '',
  candidate_since TEXT,
  directory_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO workflow_trigger (
  workflow_definition_id,
  trigger_type,
  display_name,
  enabled,
  schedule_json,
  config_json
)
SELECT
  definition.id,
  'filesystem_event',
  'Watch data folders',
  1,
  '{"type":"filesystem_event"}',
  '{}'
FROM workflow_definition AS definition
WHERE definition.code = 'local_library_scan'
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_trigger AS trigger
    WHERE trigger.workflow_definition_id = definition.id
      AND trigger.trigger_type = 'filesystem_event'
  );
