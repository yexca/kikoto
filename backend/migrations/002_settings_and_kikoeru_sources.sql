ALTER TABLE file_source_endpoint ADD COLUMN api_url TEXT NOT NULL DEFAULT '';

ALTER TABLE file_source_endpoint ADD COLUMN fallback_url TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX idx_file_source_endpoint_source ON file_source_endpoint(file_source_id);

CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
