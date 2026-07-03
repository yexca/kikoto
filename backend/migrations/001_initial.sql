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
  auth_type TEXT NOT NULL DEFAULT 'none',
  credential_ref TEXT NOT NULL DEFAULT '',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_checked_at TEXT
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

CREATE TABLE workflow_template (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_node (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES workflow_template(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(template_id, code)
);

CREATE TABLE workflow_run (
  id INTEGER PRIMARY KEY,
  template_code TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workflow_job (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  node_code TEXT NOT NULL,
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

INSERT INTO metadata_provider (code, display_name)
VALUES ('manual', 'Manual'), ('dlsite', 'DLsite');

INSERT INTO workflow_template (code, display_name)
VALUES ('local_scan', 'Scan local library');
