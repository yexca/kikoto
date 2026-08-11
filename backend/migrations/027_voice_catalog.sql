CREATE TABLE voice_catalog_item (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  primary_code TEXT NOT NULL,
  work_id INTEGER REFERENCES work(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  release_date TEXT,
  cover_url TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  circle TEXT NOT NULL DEFAULT '',
  age_rating TEXT NOT NULL DEFAULT '',
  rating_average REAL,
  rating_count INTEGER,
  sales_count INTEGER,
  current_price INTEGER,
  tags_json TEXT NOT NULL DEFAULT '[]',
  voice_actors_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL DEFAULT '{}',
  catalog_status TEXT NOT NULL DEFAULT 'catalog',
  snapshot_generation INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(person_id, primary_code)
);

CREATE TABLE voice_catalog_source (
  id INTEGER PRIMARY KEY,
  catalog_item_id INTEGER NOT NULL REFERENCES voice_catalog_item(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  remote_id TEXT NOT NULL DEFAULT '',
  remote_code TEXT NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'unknown',
  raw_json TEXT NOT NULL DEFAULT '{}',
  snapshot_generation INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(catalog_item_id, provider_id, remote_code)
);

CREATE TABLE voice_catalog_refresh_state (
  person_id INTEGER PRIMARY KEY REFERENCES person(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0,
  query_json TEXT NOT NULL DEFAULT '[]',
  source_status_json TEXT NOT NULL DEFAULT '[]',
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_status TEXT NOT NULL DEFAULT '',
  last_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  last_error TEXT NOT NULL DEFAULT '',
  complete INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  catalog_works INTEGER NOT NULL DEFAULT 0,
  metadata_queued INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_voice_catalog_person_seen
  ON voice_catalog_item(person_id, last_seen_at DESC, primary_code);

CREATE INDEX idx_voice_catalog_source_refresh
  ON voice_catalog_source(provider_id, snapshot_generation, availability);

CREATE INDEX idx_voice_catalog_source_item
  ON voice_catalog_source(catalog_item_id, availability, last_seen_at DESC);
