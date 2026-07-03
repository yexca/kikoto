DROP TABLE IF EXISTS workflow_job;
DROP TABLE IF EXISTS workflow_node;
DROP TABLE IF EXISTS workflow_template;
DROP TABLE IF EXISTS workflow_run;

CREATE TABLE workflow_definition (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_trigger (
  id INTEGER PRIMARY KEY,
  workflow_definition_id INTEGER NOT NULL REFERENCES workflow_definition(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_workflow_trigger_enabled_type
  ON workflow_trigger(enabled, trigger_type);

CREATE TABLE workflow_run (
  id INTEGER PRIMARY KEY,
  workflow_definition_id INTEGER REFERENCES workflow_definition(id) ON DELETE SET NULL,
  trigger_id INTEGER REFERENCES workflow_trigger(id) ON DELETE SET NULL,
  workflow_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_reason TEXT NOT NULL DEFAULT '',
  input_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_workflow_run_created_at
  ON workflow_run(created_at);

CREATE INDEX idx_workflow_run_status
  ON workflow_run(status);

CREATE TABLE workflow_node_run (
  id INTEGER PRIMARY KEY,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_workflow_node_run_run
  ON workflow_node_run(workflow_run_id, position);

CREATE INDEX idx_workflow_node_run_status
  ON workflow_node_run(status);

CREATE TABLE workflow_job (
  id INTEGER PRIMARY KEY,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL,
  worker_type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_workflow_job_run
  ON workflow_job(workflow_run_id);

CREATE INDEX idx_workflow_job_node_run
  ON workflow_job(workflow_node_run_id);

CREATE TABLE workflow_candidate (
  id INTEGER PRIMARY KEY,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL,
  candidate_type TEXT NOT NULL,
  external_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  decision_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_workflow_candidate_run
  ON workflow_candidate(workflow_run_id);

CREATE INDEX idx_workflow_candidate_status
  ON workflow_candidate(status);

INSERT INTO workflow_definition (code, display_name, description, definition_json)
VALUES
  (
    'local_library_scan',
    'Scan local library',
    'Discover local files, match works, and sync local file locations.',
    '{"nodes":[{"id":"select","type":"select_local_source"},{"id":"discover","type":"discover_local_files"},{"id":"match","type":"match_works"},{"id":"sync","type":"sync_file_locations"}]}'
  ),
  (
    'metadata_sync',
    'Sync work metadata',
    'Select works and sync normalized metadata snapshots.',
    '{"nodes":[{"id":"select","type":"select_works"},{"id":"sync","type":"sync_metadata"}]}'
  ),
  (
    'remote_source_sync',
    'Sync remote source',
    'Discover remote works, filter candidates, match works, and sync remote locations.',
    '{"nodes":[{"id":"select","type":"select_remote_source"},{"id":"discover","type":"discover_remote_works"},{"id":"filter","type":"filter_candidates"},{"id":"match","type":"match_works"},{"id":"sync","type":"sync_file_locations"}]}'
  ),
  (
    'media_cache',
    'Cache media',
    'Select media items, filter cache misses, sync source state, and materialize cache files.',
    '{"nodes":[{"id":"select","type":"select_media_items"},{"id":"filter","type":"filter_candidates"},{"id":"sync","type":"sync_file_locations"},{"id":"cache","type":"materialize_cache"}]}'
  ),
  (
    'media_save',
    'Save media to local library',
    'Select media items or folders, sync source state, cache when needed, and save to a local source.',
    '{"nodes":[{"id":"select","type":"select_media_items"},{"id":"filter","type":"filter_candidates"},{"id":"sync","type":"sync_file_locations"},{"id":"cache","type":"materialize_cache"},{"id":"save","type":"materialize_save"}]}'
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
  id,
  'startup',
  'Startup local library scan',
  0,
  '{"type":"startup"}',
  '{"reason":"system_startup"}'
FROM workflow_definition
WHERE code = 'local_library_scan';
