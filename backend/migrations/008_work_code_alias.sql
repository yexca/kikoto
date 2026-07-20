CREATE TABLE work_code_alias (
  id INTEGER PRIMARY KEY,
  logical_work_id INTEGER NOT NULL REFERENCES logical_work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  primary_code TEXT NOT NULL,
  metadata_language TEXT NOT NULL DEFAULT '',
  edition_label TEXT NOT NULL DEFAULT '',
  source_work_id INTEGER REFERENCES work(id) ON DELETE SET NULL,
  relationship_kind TEXT NOT NULL DEFAULT 'provider_declared',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, primary_code)
);

CREATE INDEX idx_work_code_alias_logical
  ON work_code_alias(logical_work_id, provider_id, primary_code);

CREATE INDEX idx_work_code_alias_code_upper
  ON work_code_alias(UPPER(primary_code), provider_id, logical_work_id);

INSERT INTO work_code_alias (
  logical_work_id,
  provider_id,
  primary_code,
  metadata_language,
  edition_label,
  source_work_id,
  relationship_kind
)
SELECT
  edition.logical_work_id,
  edition.provider_id,
  UPPER(TRIM(edition.primary_code)),
  edition.metadata_language,
  edition.edition_label,
  edition.work_id,
  'persisted_edition'
FROM work_edition AS edition
WHERE edition.provider_id IS NOT NULL
  AND TRIM(edition.primary_code) <> ''
ON CONFLICT(provider_id, primary_code) DO UPDATE SET
  logical_work_id = excluded.logical_work_id,
  metadata_language = CASE
    WHEN excluded.metadata_language <> '' THEN excluded.metadata_language
    ELSE work_code_alias.metadata_language
  END,
  edition_label = CASE
    WHEN excluded.edition_label <> '' THEN excluded.edition_label
    ELSE work_code_alias.edition_label
  END,
  source_work_id = excluded.source_work_id,
  relationship_kind = 'persisted_edition',
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO work_code_alias (
  logical_work_id,
  provider_id,
  primary_code,
  relationship_kind
)
SELECT DISTINCT
  logical.id,
  edition.provider_id,
  UPPER(TRIM(logical.canonical_code)),
  'provider_declared'
FROM logical_work AS logical
INNER JOIN work_edition AS edition ON edition.logical_work_id = logical.id
WHERE edition.provider_id IS NOT NULL
  AND TRIM(logical.canonical_code) <> ''
ON CONFLICT(provider_id, primary_code) DO UPDATE SET
  logical_work_id = excluded.logical_work_id,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO work_code_alias (
  logical_work_id,
  provider_id,
  primary_code,
  metadata_language,
  edition_label,
  relationship_kind
)
SELECT DISTINCT
  current_edition.logical_work_id,
  snapshot.provider_id,
  UPPER(TRIM(CAST(json_extract(language_edition.value, '$.workno') AS TEXT))),
  TRIM(COALESCE(
    CAST(json_extract(language_edition.value, '$.lang') AS TEXT),
    CAST(json_extract(language_edition.value, '$.label') AS TEXT),
    ''
  )),
  TRIM(COALESCE(CAST(json_extract(language_edition.value, '$.label') AS TEXT), '')),
  'provider_declared'
FROM metadata_snapshot AS snapshot
INNER JOIN work_edition AS current_edition ON current_edition.work_id = snapshot.work_id
INNER JOIN json_each(
  CASE
    WHEN json_valid(snapshot.snapshot_json) = 0 THEN '[]'
    WHEN json_type(snapshot.snapshot_json, '$.product.language_editions') = 'array'
      THEN json_extract(snapshot.snapshot_json, '$.product.language_editions')
    WHEN json_type(snapshot.snapshot_json, '$.language_editions') = 'array'
      THEN json_extract(snapshot.snapshot_json, '$.language_editions')
    ELSE '[]'
  END
) AS language_edition
WHERE snapshot.id = (
    SELECT candidate.id
    FROM metadata_snapshot AS candidate
    WHERE candidate.work_id = snapshot.work_id
      AND candidate.provider_id = snapshot.provider_id
    ORDER BY candidate.fetched_at DESC, candidate.id DESC
    LIMIT 1
  )
  AND TRIM(COALESCE(CAST(json_extract(language_edition.value, '$.workno') AS TEXT), '')) <> ''
ON CONFLICT(provider_id, primary_code) DO UPDATE SET
  logical_work_id = excluded.logical_work_id,
  metadata_language = CASE
    WHEN excluded.metadata_language <> '' THEN excluded.metadata_language
    ELSE work_code_alias.metadata_language
  END,
  edition_label = CASE
    WHEN excluded.edition_label <> '' THEN excluded.edition_label
    ELSE work_code_alias.edition_label
  END,
  updated_at = CURRENT_TIMESTAMP;
