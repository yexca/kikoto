CREATE TABLE tag (
  id INTEGER PRIMARY KEY,
  namespace TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '',
  is_user_defined INTEGER NOT NULL DEFAULT 0 CHECK(is_user_defined IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(namespace, normalized_name, language)
);

CREATE INDEX idx_tag_namespace_display_name
  ON tag(namespace, display_name);

CREATE TABLE work_tag (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, tag_id, source)
);

CREATE INDEX idx_work_tag_tag_work
  ON work_tag(tag_id, work_id);

WITH latest_snapshot AS (
  SELECT snapshot.work_id, snapshot.snapshot_json
  FROM metadata_snapshot AS snapshot
  INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
  WHERE provider.code = 'dlsite'
    AND snapshot.work_id IS NOT NULL
    AND snapshot.id = (
      SELECT candidate.id
      FROM metadata_snapshot AS candidate
      WHERE candidate.work_id = snapshot.work_id
        AND candidate.provider_id = snapshot.provider_id
      ORDER BY candidate.fetched_at DESC, candidate.id DESC
      LIMIT 1
    )
), snapshot_genre AS (
  SELECT
    latest_snapshot.work_id,
    TRIM(COALESCE(
      json_extract(genre.value, '$.name'),
      json_extract(genre.value, '$.name_base'),
      ''
    )) AS display_name,
    TRIM(COALESCE(
      json_extract(latest_snapshot.snapshot_json, '$._kikoto.language'),
      json_extract(latest_snapshot.snapshot_json, '$.product._kikoto.language'),
      json_extract(latest_snapshot.snapshot_json, '$.product.language'),
      ''
    )) AS language
  FROM latest_snapshot
  INNER JOIN json_each(
    CASE
      WHEN json_type(latest_snapshot.snapshot_json, '$.product.genres') = 'array'
        THEN json_extract(latest_snapshot.snapshot_json, '$.product.genres')
      WHEN json_type(latest_snapshot.snapshot_json, '$.genres') = 'array'
        THEN json_extract(latest_snapshot.snapshot_json, '$.genres')
      ELSE '[]'
    END
  ) AS genre
)
INSERT INTO tag (namespace, normalized_name, display_name, language)
SELECT DISTINCT 'dlsite', LOWER(display_name), display_name, language
FROM snapshot_genre
WHERE display_name <> ''
ON CONFLICT(namespace, normalized_name, language) DO UPDATE SET
  display_name = excluded.display_name,
  updated_at = CURRENT_TIMESTAMP;

WITH latest_snapshot AS (
  SELECT snapshot.work_id, snapshot.snapshot_json
  FROM metadata_snapshot AS snapshot
  INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
  WHERE provider.code = 'dlsite'
    AND snapshot.work_id IS NOT NULL
    AND snapshot.id = (
      SELECT candidate.id
      FROM metadata_snapshot AS candidate
      WHERE candidate.work_id = snapshot.work_id
        AND candidate.provider_id = snapshot.provider_id
      ORDER BY candidate.fetched_at DESC, candidate.id DESC
      LIMIT 1
    )
), snapshot_genre AS (
  SELECT
    latest_snapshot.work_id,
    TRIM(COALESCE(
      json_extract(genre.value, '$.name'),
      json_extract(genre.value, '$.name_base'),
      ''
    )) AS display_name,
    TRIM(COALESCE(
      json_extract(latest_snapshot.snapshot_json, '$._kikoto.language'),
      json_extract(latest_snapshot.snapshot_json, '$.product._kikoto.language'),
      json_extract(latest_snapshot.snapshot_json, '$.product.language'),
      ''
    )) AS language
  FROM latest_snapshot
  INNER JOIN json_each(
    CASE
      WHEN json_type(latest_snapshot.snapshot_json, '$.product.genres') = 'array'
        THEN json_extract(latest_snapshot.snapshot_json, '$.product.genres')
      WHEN json_type(latest_snapshot.snapshot_json, '$.genres') = 'array'
        THEN json_extract(latest_snapshot.snapshot_json, '$.genres')
      ELSE '[]'
    END
  ) AS genre
)
INSERT INTO work_tag (work_id, tag_id, source)
SELECT DISTINCT snapshot_genre.work_id, tag.id, 'dlsite'
FROM snapshot_genre
INNER JOIN tag ON tag.namespace = 'dlsite'
  AND tag.normalized_name = LOWER(snapshot_genre.display_name)
  AND tag.language = snapshot_genre.language
WHERE snapshot_genre.display_name <> ''
ON CONFLICT(work_id, tag_id, source) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_metadata_snapshot_work_provider_latest
  ON metadata_snapshot(work_id, provider_id, fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_snapshot_provider_external_latest
  ON metadata_snapshot(provider_id, external_id, fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_party_metadata_snapshot_party_provider_latest
  ON party_metadata_snapshot(party_id, provider_id, fetched_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_work_primary_code_upper
  ON work(UPPER(primary_code));

CREATE INDEX IF NOT EXISTS idx_work_edition_primary_code_upper
  ON work_edition(UPPER(primary_code), logical_work_id);

CREATE INDEX IF NOT EXISTS idx_party_series_work_code_upper
  ON party_series_work(UPPER(primary_code), series_id);

CREATE INDEX IF NOT EXISTS idx_user_media_progress_user_latest
  ON user_media_progress(user_id, last_played_at DESC, updated_at DESC, media_item_id);

CREATE TABLE remote_fetch_request (
  request_id TEXT PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES file_source(id) ON DELETE CASCADE,
  work_code TEXT NOT NULL,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_remote_fetch_request_run
  ON remote_fetch_request(workflow_run_id);

CREATE INDEX idx_remote_fetch_request_created_at
  ON remote_fetch_request(created_at);

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
  remote_source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  source_path TEXT NOT NULL DEFAULT '',
  original_target_path TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT 'auto',
  UNIQUE(manifest_id, target_path)
);

CREATE INDEX idx_remote_fetch_manifest_item_state
  ON remote_fetch_manifest_item(manifest_id, state, id);

CREATE INDEX idx_remote_fetch_manifest_item_source
  ON remote_fetch_manifest_item(manifest_id, remote_source_id, state, id);

ALTER TABLE workflow_job ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_job ADD COLUMN recoverable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_job ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;
ALTER TABLE workflow_job ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_job ADD COLUMN available_at TEXT;

CREATE INDEX idx_workflow_job_recovery
  ON workflow_job(status, recoverable, available_at, heartbeat_at, id);

INSERT INTO work_source_presence (
  work_id, file_source_id, presence_type, remote_code,
  availability, raw_json, last_checked_at, updated_at
)
SELECT DISTINCT
  manifest.work_id,
  manifest.remote_source_id,
  'tracked',
  manifest.edition_code,
  'available',
  json_object('source', 'fetch_manifest_migration', 'edition_code', manifest.edition_code),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM remote_fetch_manifest AS manifest
WHERE manifest.state = 'completed'
ON CONFLICT(work_id, file_source_id, presence_type) DO UPDATE SET
  remote_code = CASE WHEN excluded.remote_code <> '' THEN excluded.remote_code ELSE work_source_presence.remote_code END,
  availability = 'available',
  updated_at = CURRENT_TIMESTAMP;

DELETE FROM media_file_location
WHERE location_type = 'remote_stream'
  AND EXISTS (
    SELECT 1
    FROM media_item AS item
    INNER JOIN remote_fetch_manifest AS manifest ON manifest.work_id = item.work_id
    WHERE item.id = media_file_location.media_item_id
      AND manifest.remote_source_id = media_file_location.file_source_id
      AND manifest.state = 'completed'
  );
