-- Catalog membership is discovery provenance, not work ownership. Older
-- refresh paths projected the catalog owner into work_party and could make the
-- newest refresh win over the product maker. Rebuild generated organization
-- attribution from edition/product metadata while preserving catalog rows.

CREATE TEMP TABLE migration_021_authoritative_work_party AS
WITH latest_dlsite_snapshot AS (
  SELECT
    work.id AS work_id,
    snapshot.snapshot_json,
    CASE
      WHEN snapshot.id IS NOT NULL AND json_valid(snapshot.snapshot_json) THEN UPPER(TRIM(COALESCE(
        NULLIF(json_extract(snapshot.snapshot_json, '$.product.maker_id'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.product.circle_id'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.product.brand_id'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.product.label_id'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.maker_id'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.circle_id'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.brand_id'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.label_id'), ''),
        ''
      )))
      ELSE ''
    END AS maker_id,
    CASE
      WHEN snapshot.id IS NOT NULL AND json_valid(snapshot.snapshot_json) THEN TRIM(COALESCE(
        NULLIF(json_extract(snapshot.snapshot_json, '$.product.maker_name'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.product.label_name'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.maker_name'), ''),
        NULLIF(json_extract(snapshot.snapshot_json, '$.label_name'), ''),
        ''
      ))
      ELSE ''
    END AS maker_name
  FROM work
  INNER JOIN metadata_provider AS provider ON provider.code = 'dlsite'
  LEFT JOIN metadata_snapshot AS snapshot ON snapshot.id = (
    SELECT candidate.id
    FROM metadata_snapshot AS candidate
    WHERE candidate.work_id = work.id
      AND candidate.provider_id = provider.id
    ORDER BY candidate.fetched_at DESC, candidate.id DESC
    LIMIT 1
  )
), authority AS (
  SELECT
    work.id AS work_id,
    provider.id AS provider_id,
    UPPER(TRIM(COALESCE(NULLIF(snapshot.maker_id, ''), NULLIF(edition.maker_id, ''), ''))) AS maker_id,
    CASE
      WHEN snapshot.maker_name <> ''
        AND UPPER(snapshot.maker_id) = UPPER(COALESCE(NULLIF(snapshot.maker_id, ''), edition.maker_id))
        THEN snapshot.maker_name
      ELSE UPPER(TRIM(COALESCE(NULLIF(snapshot.maker_id, ''), NULLIF(edition.maker_id, ''), '')))
    END AS maker_name,
    CASE
      WHEN edition.work_id IS NULL OR edition.is_canonical = 1 THEN 'circle'
      WHEN edition.translation_kind = 'official'
        OR (
          COALESCE(NULLIF(edition.origin_maker_id, ''), NULLIF(origin.maker_id, '')) <> ''
          AND UPPER(COALESCE(NULLIF(edition.origin_maker_id, ''), origin.maker_id)) =
            UPPER(COALESCE(NULLIF(snapshot.maker_id, ''), edition.maker_id))
        ) THEN 'official_translation_brand'
      ELSE 'translator_circle'
    END AS role,
    CASE WHEN snapshot.maker_id <> '' THEN 'dlsite_snapshot' ELSE 'dlsite_edition' END AS source
  FROM work
  INNER JOIN metadata_provider AS provider ON provider.code = 'dlsite'
  LEFT JOIN work_edition AS edition ON edition.work_id = work.id
  LEFT JOIN work_edition AS origin
    ON origin.logical_work_id = edition.logical_work_id
    AND origin.is_canonical = 1
  LEFT JOIN latest_dlsite_snapshot AS snapshot ON snapshot.work_id = work.id
)
SELECT work_id, provider_id, maker_id, COALESCE(NULLIF(maker_name, ''), maker_id) AS maker_name, role, source
FROM authority
WHERE maker_id <> '';

-- Edition maker data is provider identity and should agree with the latest
-- authoritative product snapshot; the existing edition value is the fallback
-- when no valid snapshot is available.
UPDATE work_edition
SET maker_id = (
  SELECT authority.maker_id
  FROM migration_021_authoritative_work_party AS authority
  WHERE authority.work_id = work_edition.work_id
)
WHERE EXISTS (
  SELECT 1
  FROM migration_021_authoritative_work_party AS authority
  WHERE authority.work_id = work_edition.work_id
);

UPDATE work_edition
SET origin_maker_id = COALESCE(NULLIF((
  SELECT origin.maker_id
  FROM work_edition AS origin
  WHERE origin.logical_work_id = work_edition.logical_work_id
    AND origin.is_canonical = 1
  ORDER BY origin.work_id ASC
  LIMIT 1
), ''), origin_maker_id);

-- A snapshot can exist before the party projection has ever run. Allocate
-- deterministic ids for missing provider identities instead of guessing by
-- display name.
CREATE TEMP TABLE migration_021_missing_party AS
WITH missing AS (
  SELECT
    authority.maker_id,
    COALESCE(
      NULLIF(MAX(CASE WHEN authority.maker_name <> authority.maker_id THEN authority.maker_name ELSE '' END), ''),
      authority.maker_id
    ) AS maker_name
  FROM migration_021_authoritative_work_party AS authority
  WHERE NOT EXISTS (
    SELECT 1
    FROM party_external_id AS external
    WHERE external.provider_id = authority.provider_id
      AND external.id_type = 'maker_id'
      AND UPPER(external.external_id) = authority.maker_id
  )
  GROUP BY authority.maker_id
), numbered AS (
  SELECT
    maker_id,
    maker_name,
    ROW_NUMBER() OVER (ORDER BY maker_id) AS position
  FROM missing
)
SELECT
  maker_id,
  maker_name,
  (SELECT COALESCE(MAX(id), 0) FROM party) + position AS party_id
FROM numbered;

INSERT INTO party (id, party_type, display_name, sort_name)
SELECT party_id, 'circle', maker_name, LOWER(maker_name)
FROM migration_021_missing_party;

INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, url, is_primary)
SELECT missing.party_id, provider.id, 'maker_id', missing.maker_id, '', 1
FROM migration_021_missing_party AS missing
INNER JOIN metadata_provider AS provider ON provider.code = 'dlsite'
ON CONFLICT(provider_id, id_type, external_id) DO NOTHING;

-- These sources were written from catalog ownership and are invalid regardless
-- of whether they happened to match the real product maker.
DELETE FROM work_party
WHERE source IN ('circle_refresh', 'remote_source_catalog');

-- Generated fallback attribution must yield to the current product maker. The
-- manual relation is intentionally outside this cleanup and remains highest
-- priority in the projection below.
DELETE FROM work_party
WHERE role IN ('circle', 'translator_circle', 'official_translation_brand')
  AND source IN ('dlsite_snapshot', 'dlsite_product', 'dlsite_edition', 'remote_source')
  AND EXISTS (
    SELECT 1
    FROM migration_021_authoritative_work_party AS authority
    WHERE authority.work_id = work_party.work_id
      AND (
        authority.role <> work_party.role
        OR NOT EXISTS (
          SELECT 1
          FROM party_external_id AS external
          WHERE external.party_id = work_party.party_id
            AND external.provider_id = authority.provider_id
            AND external.id_type = 'maker_id'
            AND UPPER(external.external_id) = authority.maker_id
        )
      )
  );

INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
SELECT
  authority.work_id,
  external.party_id,
  authority.role,
  authority.provider_id,
  authority.source,
  CURRENT_TIMESTAMP
FROM migration_021_authoritative_work_party AS authority
INNER JOIN party_external_id AS external
  ON external.provider_id = authority.provider_id
  AND external.id_type = 'maker_id'
  AND UPPER(external.external_id) = authority.maker_id
ON CONFLICT(work_id, party_id, role) DO UPDATE SET
  provider_id = excluded.provider_id,
  source = excluded.source,
  updated_at = CURRENT_TIMESTAMP
WHERE work_party.source <> 'manual_override';

DROP VIEW IF EXISTS work_primary_circle;
CREATE VIEW work_primary_circle AS
WITH family_target AS (
  SELECT
    work.id AS work_id,
    COALESCE(logical.canonical_work_id, work.id) AS canonical_work_id
  FROM work
  LEFT JOIN work_edition AS edition ON edition.work_id = work.id
  LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
), ranked AS (
  SELECT
    target.work_id,
    relation.party_id,
    party.display_name,
    COALESCE(external.external_id, '') AS external_id,
    relation.role,
    relation.source,
    ROW_NUMBER() OVER (
      PARTITION BY target.work_id
      ORDER BY
        CASE
          WHEN relation.work_id = target.work_id AND relation.source = 'manual_override' THEN 0
          WHEN relation.work_id = target.canonical_work_id AND relation.source = 'manual_override' THEN 1
          WHEN relation.work_id = target.canonical_work_id
            AND edition.maker_id <> ''
            AND UPPER(COALESCE(external.external_id, '')) = UPPER(edition.maker_id) THEN 2
          WHEN relation.work_id = target.canonical_work_id
            AND relation_provider.code = 'dlsite'
            AND relation.source IN ('dlsite_snapshot', 'dlsite_product', 'dlsite_edition') THEN 3
          WHEN relation.work_id = target.canonical_work_id
            AND relation_provider.code = 'dlsite' THEN 4
          WHEN edition.maker_id <> ''
            AND UPPER(COALESCE(external.external_id, '')) = UPPER(edition.maker_id) THEN 5
          WHEN relation_provider.code = 'dlsite'
            AND relation.source IN ('dlsite_snapshot', 'dlsite_product', 'dlsite_edition') THEN 6
          WHEN relation_provider.code = 'dlsite' THEN 7
          WHEN relation.source = 'remote_source' THEN 9
          ELSE 8
        END,
        relation.party_id ASC
    ) AS position
  FROM family_target AS target
  INNER JOIN work_party AS relation
    ON relation.work_id = target.work_id
    OR relation.work_id = target.canonical_work_id
  INNER JOIN party ON party.id = relation.party_id
  LEFT JOIN work_edition AS edition ON edition.work_id = relation.work_id
  LEFT JOIN metadata_provider AS relation_provider ON relation_provider.id = relation.provider_id
  LEFT JOIN party_external_id AS external ON external.id = (
    SELECT candidate.id
    FROM party_external_id AS candidate
    LEFT JOIN metadata_provider AS candidate_provider ON candidate_provider.id = candidate.provider_id
    WHERE candidate.party_id = party.id
    ORDER BY
      CASE WHEN candidate_provider.code = 'dlsite' THEN 0 ELSE 1 END,
      candidate.is_primary DESC,
      candidate.id ASC
    LIMIT 1
  )
  WHERE relation.role = 'circle'
)
SELECT work_id, party_id, display_name, external_id, role, source
FROM ranked
WHERE position = 1;

DROP TABLE migration_021_missing_party;
DROP TABLE migration_021_authoritative_work_party;
