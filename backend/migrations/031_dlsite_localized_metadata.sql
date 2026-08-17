-- Keep the request/edition distinction explicit.  A request locale is only
-- a transport hint; edition_language is the language declared by DLsite.
ALTER TABLE metadata_snapshot ADD COLUMN variant_key TEXT NOT NULL DEFAULT '';
ALTER TABLE metadata_snapshot ADD COLUMN edition_language TEXT NOT NULL DEFAULT '';
ALTER TABLE metadata_snapshot ADD COLUMN request_locale TEXT NOT NULL DEFAULT '';
ALTER TABLE metadata_snapshot ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';

CREATE INDEX idx_metadata_snapshot_external_latest
  ON metadata_snapshot(provider_id, work_id, external_id, fetched_at DESC, id DESC);

-- The raw provider snapshot remains the traceability record.  This table is
-- the small, queryable projection used for title/tag language selection.
CREATE TABLE dlsite_metadata_variant (
  id INTEGER PRIMARY KEY,
  logical_work_id INTEGER NOT NULL REFERENCES logical_work(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  edition_language TEXT NOT NULL DEFAULT '',
  request_locale TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- One DLsite work code is one language edition.  The provider declaration
  -- and request locale may be corrected by a later fetch without creating a
  -- second display variant for the same edition.
  UNIQUE(provider_id, work_id)
);

CREATE INDEX idx_dlsite_metadata_variant_logical_language
  ON dlsite_metadata_variant(logical_work_id, edition_language, fetched_at DESC, id DESC);

CREATE INDEX idx_dlsite_metadata_variant_work
  ON dlsite_metadata_variant(work_id, provider_id, fetched_at DESC, id DESC);

-- Preserve useful data for installations upgraded before the localized
-- projection existed.  Rank old rows first so a database that accumulated
-- repeated snapshots cannot fail this migration on the variant unique key.
WITH ranked_snapshots AS (
  SELECT
    snapshot.id,
    snapshot.work_id,
    snapshot.provider_id,
    snapshot.external_id,
    snapshot.snapshot_json,
    snapshot.content_hash,
    snapshot.fetched_at,
    edition.logical_work_id,
    COALESCE(
      NULLIF(snapshot.edition_language, ''),
      NULLIF(edition.metadata_language, ''),
      ''
    ) AS resolved_edition_language,
    COALESCE(snapshot.request_locale, '') AS resolved_request_locale,
    ROW_NUMBER() OVER (
      PARTITION BY snapshot.provider_id, snapshot.work_id
      ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
    ) AS row_number
  FROM metadata_snapshot AS snapshot
  INNER JOIN metadata_provider AS provider
    ON provider.id = snapshot.provider_id
   AND provider.code = 'dlsite'
  INNER JOIN work_edition AS edition ON edition.work_id = snapshot.work_id
  WHERE snapshot.work_id IS NOT NULL
)
INSERT OR IGNORE INTO dlsite_metadata_variant (
  logical_work_id, work_id, provider_id, external_id,
  edition_language, request_locale, title, tags_json, content_hash, fetched_at
)
SELECT
  ranked.logical_work_id,
  ranked.work_id,
  ranked.provider_id,
  ranked.external_id,
  ranked.resolved_edition_language,
  ranked.resolved_request_locale,
  COALESCE(
    CASE WHEN json_valid(ranked.snapshot_json) THEN json_extract(ranked.snapshot_json, '$.product.product_name') END,
    CASE WHEN json_valid(ranked.snapshot_json) THEN json_extract(ranked.snapshot_json, '$.product_name') END,
    (SELECT work.title FROM work WHERE work.id = ranked.work_id),
    ''
  ),
  COALESCE((
    SELECT json_group_array(tag.display_name)
    FROM work_tag
    INNER JOIN tag ON tag.id = work_tag.tag_id
    WHERE work_tag.work_id = ranked.work_id AND work_tag.source = 'dlsite'
  ), '[]'),
  ranked.content_hash,
  ranked.fetched_at
FROM ranked_snapshots AS ranked
WHERE ranked.row_number = 1;

-- Older rows did not have a variant key.  Give them a bounded legacy key so
-- the retention pass below also covers upgrades that predate this migration.
UPDATE metadata_snapshot
SET variant_key = CASE
  WHEN TRIM(edition_language) <> ''
    THEN LOWER(REPLACE(TRIM(edition_language), '_', '-'))
  WHEN json_valid(snapshot_json)
       AND TRIM(COALESCE(json_extract(snapshot_json, '$._kikoto.edition_language'), '')) <> ''
    THEN LOWER(REPLACE(TRIM(json_extract(snapshot_json, '$._kikoto.edition_language')), '_', '-'))
  ELSE 'legacy'
END
WHERE TRIM(variant_key) = '';

-- Remote-source snapshots use one non-localized variant as well.  Migrate
-- their old empty keys so the same retention bound applies after upgrade.
UPDATE metadata_snapshot
SET variant_key = 'remote'
WHERE TRIM(variant_key) = 'legacy'
  AND provider_id IN (
    SELECT id
    FROM metadata_provider
    WHERE code GLOB 'kikoeru_source_*'
  );

-- Retain the newest record and one immediately preceding record for each
-- provider/work/external-id. This also bounds legacy rows whose variant key
-- differs from the normalized key written by current clients.
DELETE FROM metadata_snapshot AS older
WHERE (
  SELECT COUNT(*)
  FROM metadata_snapshot AS newer
  WHERE newer.provider_id = older.provider_id
    AND COALESCE(newer.work_id, 0) = COALESCE(older.work_id, 0)
    AND newer.external_id = older.external_id
    AND (
      newer.fetched_at > older.fetched_at
      OR (newer.fetched_at = older.fetched_at AND newer.id > older.id)
    )
) >= 2;
