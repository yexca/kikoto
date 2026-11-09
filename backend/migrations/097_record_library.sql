CREATE TABLE record_root (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT 'Records',
  configured_path TEXT NOT NULL DEFAULT '',
  marker_id TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK(state IN ('unconfigured', 'online', 'offline', 'unreadable')),
  last_scan_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  last_scanned_at TEXT,
  scan_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO record_root (id) VALUES (1);

CREATE TABLE record_folder (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES record_root(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES record_folder(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'missing')),
  last_seen_generation INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_id, path_key)
);

CREATE INDEX idx_record_folder_parent
  ON record_folder(root_id, parent_id, state, name COLLATE NOCASE, id);

CREATE TABLE record_asset (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES record_root(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES record_folder(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('video', 'image', 'subtitle', 'metadata', 'other')),
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER,
  mtime_ns INTEGER,
  content_hash TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'available'
    CHECK(availability IN ('available', 'missing', 'unreadable')),
  probe_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(probe_state IN ('pending', 'ready', 'failed')),
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  video_codec TEXT NOT NULL DEFAULT '',
  audio_codec TEXT NOT NULL DEFAULT '',
  has_audio INTEGER,
  last_seen_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_id, path_key)
);

CREATE INDEX idx_record_asset_folder
  ON record_asset(folder_id, availability, kind, name COLLATE NOCASE, id);

CREATE INDEX idx_record_asset_root_kind
  ON record_asset(root_id, kind, availability, name COLLATE NOCASE, id);

CREATE TABLE record_asset_progress (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES record_asset(id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1)),
  last_played_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, asset_id)
);

CREATE TABLE record_asset_state (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES record_asset(id) ON DELETE CASCADE,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
  watched INTEGER NOT NULL DEFAULT 0 CHECK(watched IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, asset_id)
);
