-- Availability Watch is an instance-level workflow. Preserve the union of all
-- existing targets, carry forward the most recently updated configuration, and
-- pause the migrated schedule when per-user configurations disagree.

INSERT INTO workflow_definition (
  code,
  display_name,
  description,
  definition_json,
  scope,
  editable
)
VALUES (
  'availability_watch',
  'Availability Watch',
  'Monitor a shared pool of work codes and dispatch configured actions when a remote source becomes available.',
  '{"nodes":[{"id":"targets","type":"select_works","displayName":"Monitoring pool"},{"id":"check","type":"check_source_availability","displayName":"Check source availability"},{"id":"ready","type":"filter_candidates","displayName":"Ready pool"},{"id":"dispatch","type":"dispatch_child_workflows","displayName":"Dispatch configured action"}]}',
  'system',
  0
)
ON CONFLICT(code) DO NOTHING;

INSERT INTO workflow_trigger (
  workflow_definition_id,
  trigger_type,
  display_name,
  enabled,
  schedule_json,
  config_json,
  next_run_at
)
SELECT
  definition.id,
  'schedule',
  'Availability check schedule',
  CASE
    WHEN latest.enabled = 1 AND (
      SELECT COUNT(*)
      FROM (
        SELECT action, COALESCE(source_id, -1), exclude_extensions_json
        FROM availability_watch
        GROUP BY action, COALESCE(source_id, -1), exclude_extensions_json
      ) AS configurations
    ) <= 1 THEN 1
    ELSE 0
  END,
  json_object('intervalMinutes', latest.interval_minutes),
  json_object('userId', latest.owner_user_id),
  CASE
    WHEN latest.enabled = 1 AND (
      SELECT COUNT(*)
      FROM (
        SELECT action, COALESCE(source_id, -1), exclude_extensions_json
        FROM availability_watch
        GROUP BY action, COALESCE(source_id, -1), exclude_extensions_json
      ) AS configurations
    ) <= 1 THEN datetime('now', '+' || latest.interval_minutes || ' minutes')
    ELSE NULL
  END
FROM availability_watch AS latest
INNER JOIN workflow_definition AS definition ON definition.code = 'availability_watch'
WHERE latest.id = (
  SELECT id
  FROM availability_watch
  ORDER BY datetime(updated_at) DESC, id DESC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1
  FROM workflow_trigger AS existing
  WHERE existing.workflow_definition_id = definition.id
    AND existing.trigger_type = 'schedule'
);

CREATE TABLE availability_watch_next (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  configured_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  action TEXT NOT NULL DEFAULT 'monitor' CHECK(action IN ('monitor', 'track', 'fetch', 'track_fetch')),
  source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  exclude_extensions_json TEXT NOT NULL DEFAULT '["wav"]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO availability_watch_next (
  id,
  configured_by_user_id,
  action,
  source_id,
  exclude_extensions_json,
  revision,
  created_at,
  updated_at
)
SELECT
  1,
  latest.owner_user_id,
  latest.action,
  latest.source_id,
  latest.exclude_extensions_json,
  (SELECT MAX(revision) FROM availability_watch),
  (SELECT MIN(created_at) FROM availability_watch),
  latest.updated_at
FROM availability_watch AS latest
WHERE latest.id = (
  SELECT id
  FROM availability_watch
  ORDER BY datetime(updated_at) DESC, id DESC
  LIMIT 1
);

CREATE TABLE availability_watch_target_next (
  id INTEGER PRIMARY KEY,
  watch_id INTEGER NOT NULL REFERENCES availability_watch_next(id) ON DELETE CASCADE,
  work_code TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'monitoring' CHECK(state IN ('monitoring', 'ready', 'action_queued', 'completed', 'error', 'disabled')),
  next_check_at TEXT,
  last_checked_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  available_source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  availability_epoch INTEGER NOT NULL DEFAULT 0,
  track_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  fetch_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(watch_id, work_code)
);

INSERT INTO availability_watch_target_next (
  watch_id,
  work_code,
  active,
  state,
  next_check_at,
  last_checked_at,
  last_status,
  last_error,
  available_source_id,
  availability_epoch,
  track_run_id,
  fetch_run_id,
  revision,
  created_at,
  updated_at
)
SELECT
  1,
  UPPER(TRIM(target.work_code)),
  target.active,
  CASE WHEN target.state = 'action_queued' THEN 'ready' ELSE target.state END,
  target.next_check_at,
  target.last_checked_at,
  target.last_status,
  target.last_error,
  target.available_source_id,
  target.availability_epoch,
  target.track_run_id,
  target.fetch_run_id,
  target.revision,
  target.created_at,
  target.updated_at
FROM availability_watch_target AS target
WHERE TRIM(target.work_code) <> ''
  AND target.id = (
    SELECT candidate.id
    FROM availability_watch_target AS candidate
    WHERE UPPER(TRIM(candidate.work_code)) = UPPER(TRIM(target.work_code))
    ORDER BY candidate.active DESC, datetime(candidate.updated_at) DESC, candidate.id DESC
    LIMIT 1
  );

DROP TABLE availability_watch_outbox;
DROP TABLE availability_watch_target;
DROP TABLE availability_watch;

ALTER TABLE availability_watch_next RENAME TO availability_watch;
ALTER TABLE availability_watch_target_next RENAME TO availability_watch_target;

CREATE INDEX idx_availability_watch_target_state
ON availability_watch_target(active, state, id);
