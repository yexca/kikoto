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

INSERT INTO workflow_template (code, display_name)
VALUES ('local_scan', 'Scan local library');
