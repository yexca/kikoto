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
