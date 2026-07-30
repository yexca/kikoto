DROP TABLE filesystem_trigger_state;

CREATE TABLE filesystem_trigger_state (
  trigger_id INTEGER PRIMARY KEY REFERENCES workflow_trigger(id) ON DELETE CASCADE,
  watched_directory_count INTEGER NOT NULL DEFAULT 0,
  last_event_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO filesystem_trigger_state (trigger_id)
SELECT trigger.id
FROM workflow_trigger AS trigger
INNER JOIN workflow_definition AS definition
  ON definition.id = trigger.workflow_definition_id
WHERE trigger.trigger_type = 'filesystem_event'
  AND definition.code = 'local_library_scan';
