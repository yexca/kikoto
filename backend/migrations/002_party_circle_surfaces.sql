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
