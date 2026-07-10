ALTER TABLE work_edition ADD COLUMN translation_kind TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE work_edition ADD COLUMN classification_source TEXT NOT NULL DEFAULT '';
ALTER TABLE work_edition ADD COLUMN maker_id TEXT NOT NULL DEFAULT '';
ALTER TABLE work_edition ADD COLUMN origin_maker_id TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_work_edition_translation_kind
  ON work_edition(logical_work_id, translation_kind, primary_code);

UPDATE work_edition
SET maker_id = COALESCE((
  SELECT UPPER(COALESCE(
    json_extract(snapshot.snapshot_json, '$.maker_id'),
    json_extract(snapshot.snapshot_json, '$.product.maker_id'),
    ''
  ))
  FROM metadata_snapshot AS snapshot
  INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
  WHERE snapshot.work_id = work_edition.work_id AND provider.code = 'dlsite'
  ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
  LIMIT 1
), '');

UPDATE work_edition
SET origin_maker_id = COALESCE((
  SELECT origin.maker_id
  FROM work_edition AS origin
  WHERE origin.logical_work_id = work_edition.logical_work_id AND origin.is_canonical = 1
  LIMIT 1
), '');

UPDATE work_edition
SET translation_kind = CASE
      WHEN is_canonical = 1 THEN 'origin'
      WHEN UPPER(maker_id) = 'RG60289' THEN 'community'
      WHEN origin_maker_id <> '' AND UPPER(maker_id) = UPPER(origin_maker_id) THEN 'official'
      WHEN maker_id <> '' THEN 'third_party'
      ELSE 'unknown'
    END,
    classification_source = CASE
      WHEN is_canonical = 1 THEN 'canonical'
      WHEN UPPER(maker_id) = 'RG60289' THEN 'translation_umbrella'
      WHEN origin_maker_id <> '' AND UPPER(maker_id) = UPPER(origin_maker_id) THEN 'maker_match'
      WHEN maker_id <> '' THEN 'maker_mismatch'
      ELSE 'incomplete_metadata'
    END;

CREATE TABLE work_folder_location (
  id INTEGER PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  file_source_id INTEGER NOT NULL REFERENCES file_source(id) ON DELETE CASCADE,
  root_path TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'external',
  origin_source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  origin_remote_code TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active',
  is_primary INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_source_id, root_path)
);

CREATE INDEX idx_work_folder_location_work_state
  ON work_folder_location(work_id, state, is_primary DESC, updated_at DESC);

CREATE TABLE remote_fetch_manifest (
  id INTEGER PRIMARY KEY,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  workflow_job_id INTEGER REFERENCES workflow_job(id) ON DELETE SET NULL,
  request_id TEXT NOT NULL DEFAULT '',
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  remote_source_id INTEGER NOT NULL REFERENCES file_source(id) ON DELETE CASCADE,
  local_source_id INTEGER NOT NULL REFERENCES file_source(id) ON DELETE CASCADE,
  edition_code TEXT NOT NULL,
  target_root TEXT NOT NULL,
  staging_root TEXT NOT NULL,
  backup_root TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'planned',
  plan_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  registered_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workflow_run_id)
);

CREATE INDEX idx_remote_fetch_manifest_state
  ON remote_fetch_manifest(state, updated_at);

CREATE TABLE remote_fetch_manifest_item (
  id INTEGER PRIMARY KEY,
  manifest_id INTEGER NOT NULL REFERENCES remote_fetch_manifest(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  action TEXT NOT NULL,
  expected_size_bytes INTEGER,
  content_hash TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'planned',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(manifest_id, target_path)
);

CREATE INDEX idx_remote_fetch_manifest_item_state
  ON remote_fetch_manifest_item(manifest_id, state, id);
