CREATE TABLE IF NOT EXISTS logical_work (
  id INTEGER PRIMARY KEY,
  canonical_work_id INTEGER REFERENCES work(id) ON DELETE SET NULL,
  canonical_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS work_edition (
  work_id INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
  logical_work_id INTEGER NOT NULL REFERENCES logical_work(id) ON DELETE CASCADE,
  provider_id INTEGER REFERENCES metadata_provider(id),
  primary_code TEXT NOT NULL,
  base_code TEXT NOT NULL DEFAULT '',
  metadata_language TEXT NOT NULL DEFAULT '',
  edition_label TEXT NOT NULL DEFAULT '',
  is_canonical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_work_edition_provider_code
  ON work_edition(provider_id, primary_code);

CREATE INDEX IF NOT EXISTS idx_work_edition_logical_work
  ON work_edition(logical_work_id, is_canonical DESC, primary_code);
