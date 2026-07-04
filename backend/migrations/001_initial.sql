CREATE TABLE metadata_provider (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE work (
  id INTEGER PRIMARY KEY,
  primary_code TEXT NOT NULL UNIQUE,
  work_type TEXT NOT NULL DEFAULT 'audio',
  title TEXT NOT NULL,
  title_kana TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  release_date TEXT,
  age_rating TEXT NOT NULL DEFAULT '',
  cover_asset_id INTEGER,
  duration_seconds INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE work_external_id (
  id INTEGER PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  id_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider_id, id_type, external_id)
);

CREATE TABLE metadata_snapshot (
  id INTEGER PRIMARY KEY,
  work_id INTEGER REFERENCES work(id) ON DELETE SET NULL,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  external_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE party (
  id INTEGER PRIMARY KEY,
  party_type TEXT NOT NULL DEFAULT 'circle',
  display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE party_external_id (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  id_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider_id, id_type, external_id)
);

CREATE TABLE party_metadata_snapshot (
  id INTEGER PRIMARY KEY,
  party_id INTEGER REFERENCES party(id) ON DELETE SET NULL,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  external_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE party_catalog_item (
  id INTEGER PRIMARY KEY,
  party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  primary_code TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  release_date TEXT,
  url TEXT NOT NULL DEFAULT '',
  catalog_status TEXT NOT NULL DEFAULT 'imported',
  dlsite_available INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(party_id, provider_id, primary_code)
);

CREATE TABLE user_party_state (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  rating INTEGER,
  note TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, party_id)
);

CREATE INDEX idx_party_external_id_lookup
  ON party_external_id(provider_id, id_type, external_id);

CREATE INDEX idx_party_catalog_party
  ON party_catalog_item(party_id, last_seen_at DESC);

CREATE TABLE file_source (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE file_source_endpoint (
  id INTEGER PRIMARY KEY,
  file_source_id INTEGER NOT NULL REFERENCES file_source(id) ON DELETE CASCADE,
  base_url TEXT NOT NULL DEFAULT '',
  api_url TEXT NOT NULL DEFAULT '',
  fallback_url TEXT NOT NULL DEFAULT '',
  auth_type TEXT NOT NULL DEFAULT 'none',
  credential_ref TEXT NOT NULL DEFAULT '',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT
);

CREATE UNIQUE INDEX idx_file_source_endpoint_source
  ON file_source_endpoint(file_source_id);

CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE media_item (
  id INTEGER PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES media_item(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  disc_no INTEGER,
  track_no INTEGER,
  duration_seconds INTEGER,
  size_bytes INTEGER,
  fingerprint TEXT NOT NULL DEFAULT ''
);

CREATE TABLE media_file_location (
  id INTEGER PRIMARY KEY,
  media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  file_source_id INTEGER NOT NULL REFERENCES file_source(id) ON DELETE CASCADE,
  location_type TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  stream_url TEXT NOT NULL DEFAULT '',
  download_url TEXT NOT NULL DEFAULT '',
  remote_hash TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER,
  duration_seconds INTEGER,
  availability TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT
);

CREATE TABLE user_account (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin', 'user')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_password_credential (
  user_id INTEGER PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_session (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_work_state (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  listening_status TEXT NOT NULL DEFAULT 'none' CHECK(listening_status IN ('none', 'want_to_listen', 'listening', 'finished', 'relisten', 'paused')),
  favorite INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  note TEXT NOT NULL DEFAULT '',
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, work_id)
);

CREATE TABLE user_media_progress (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, media_item_id)
);

CREATE TABLE favorite_list (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

CREATE TABLE favorite_list_item (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES favorite_list(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(list_id, work_id)
);

CREATE TABLE user_tag (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

CREATE TABLE user_work_tag (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  user_tag_id INTEGER NOT NULL REFERENCES user_tag(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, work_id, user_tag_id)
);

CREATE TABLE workflow_definition (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  definition_json TEXT NOT NULL DEFAULT '{}',
  scope TEXT NOT NULL DEFAULT 'system' CHECK(scope IN ('system', 'user')),
  editable INTEGER NOT NULL DEFAULT 0 CHECK(editable IN (0, 1)),
  owner_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  created_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_workflow_definition_scope
  ON workflow_definition(scope, editable);

CREATE INDEX idx_workflow_definition_owner
  ON workflow_definition(owner_user_id);

CREATE TRIGGER validate_workflow_definition_insert
BEFORE INSERT ON workflow_definition
BEGIN
  SELECT CASE
    WHEN NEW.scope = 'system' AND NEW.editable != 0
      THEN RAISE(ABORT, 'system workflow definitions are not editable')
    WHEN NEW.scope = 'system' AND NEW.owner_user_id IS NOT NULL
      THEN RAISE(ABORT, 'system workflow definitions cannot have an owner')
    WHEN NEW.scope = 'user' AND NEW.editable != 1
      THEN RAISE(ABORT, 'user workflow definitions must be editable')
  END;
END;

CREATE TRIGGER validate_workflow_definition_update
BEFORE UPDATE ON workflow_definition
BEGIN
  SELECT CASE
    WHEN NEW.scope = 'system' AND NEW.editable != 0
      THEN RAISE(ABORT, 'system workflow definitions are not editable')
    WHEN NEW.scope = 'system' AND NEW.owner_user_id IS NOT NULL
      THEN RAISE(ABORT, 'system workflow definitions cannot have an owner')
    WHEN NEW.scope = 'user' AND NEW.editable != 1
      THEN RAISE(ABORT, 'user workflow definitions must be editable')
  END;
END;

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

CREATE TRIGGER validate_workflow_trigger_insert
BEFORE INSERT ON workflow_trigger
BEGIN
  SELECT CASE
    WHEN NEW.trigger_type NOT IN ('startup', 'schedule', 'filesystem_event', 'source_poll')
      THEN RAISE(ABORT, 'invalid workflow trigger type')
  END;
END;

CREATE TRIGGER validate_workflow_trigger_update
BEFORE UPDATE ON workflow_trigger
BEGIN
  SELECT CASE
    WHEN NEW.trigger_type NOT IN ('startup', 'schedule', 'filesystem_event', 'source_poll')
      THEN RAISE(ABORT, 'invalid workflow trigger type')
  END;
END;

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

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO metadata_provider (code, display_name)
VALUES ('manual', 'Manual'), ('dlsite', 'DLsite');

INSERT INTO workflow_definition (code, display_name, description, definition_json, scope, editable)
VALUES
  (
    'local_library_scan',
    'Scan local library',
    'Discover local files, match works, and sync local file locations.',
    '{"nodes":[{"id":"select","type":"select_local_source"},{"id":"discover","type":"discover_local_files"},{"id":"match","type":"match_works"},{"id":"sync","type":"sync_file_locations"}]}',
    'system',
    0
  ),
  (
    'metadata_sync',
    'Sync work metadata',
    'Select works and sync normalized metadata snapshots.',
    '{"nodes":[{"id":"select","type":"select_works"},{"id":"sync","type":"sync_metadata"}]}',
    'system',
    0
  ),
  (
    'remote_source_sync',
    'Sync remote source',
    'Discover remote works, filter candidates, match works, and sync remote locations.',
    '{"nodes":[{"id":"select","type":"select_remote_source"},{"id":"discover","type":"discover_remote_works"},{"id":"filter","type":"filter_candidates"},{"id":"match","type":"match_works"},{"id":"sync","type":"sync_file_locations"}]}',
    'system',
    0
  ),
  (
    'media_cache',
    'Cache media',
    'Select media items, filter cache misses, sync source state, and materialize cache files.',
    '{"nodes":[{"id":"select","type":"select_media_items"},{"id":"filter","type":"filter_candidates"},{"id":"sync","type":"sync_file_locations"},{"id":"cache","type":"materialize_cache"}]}',
    'system',
    0
  ),
  (
    'media_save',
    'Save media to local library',
    'Select media items or folders, sync source state, cache when needed, and save to a local source.',
    '{"nodes":[{"id":"select","type":"select_media_items"},{"id":"filter","type":"filter_candidates"},{"id":"sync","type":"sync_file_locations"},{"id":"cache","type":"materialize_cache"},{"id":"save","type":"materialize_save"}]}',
    'system',
    0
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
