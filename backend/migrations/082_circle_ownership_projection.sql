-- Circle ownership is read on every circle, library, and work page, but its
-- rules rank every work_party row of the library. Two trigger-maintained
-- projections keep the rules in one place while reads use indexes:
--
--   work_primary_circle_ranking   the ranking rules (view; used only to
--                                 recompute the projection).
--   work_primary_circle_projection the persisted winner per work.
--   work_primary_circle           the reader-facing view over the projection,
--                                 with the party's current display name and
--                                 preferred external id.
--   party_catalog_owner_resolution the catalog ownership rules (view): a manual
--                                 override of the canonical work, then the
--                                 maker of the origin edition, then the
--                                 canonical work's primary circle, then the
--                                 catalog row's own party.
--   party_catalog_item.owner_party_id the persisted owner per catalog row.
--
-- Triggers recompute only the works and catalog codes whose inputs changed.
-- SQLite trigger bodies cannot use common table expressions, so the affected
-- sets are expressed through the small dependency views below.

DROP VIEW IF EXISTS work_primary_circle;

-- The winning circle relation of each work: its own manual override first,
-- then its family's canonical work (manual override, the relation matching the
-- canonical edition's maker id, DLsite relations), then its own relations.
-- Ties fall to the lowest party id. The winner is chosen by a correlated
-- subquery so that a filter on work_id reads only that work's relations.
CREATE VIEW work_primary_circle_ranking AS
SELECT
  target_work.id AS work_id,
  relation.party_id,
  relation.role,
  relation.source
FROM work AS target_work
LEFT JOIN work_edition AS target_edition ON target_edition.work_id = target_work.id
LEFT JOIN logical_work AS target_logical ON target_logical.id = target_edition.logical_work_id
INNER JOIN work_party AS relation ON relation.rowid = (
  SELECT candidate.rowid
  FROM work_party AS candidate
  INNER JOIN party ON party.id = candidate.party_id
  LEFT JOIN work_edition AS edition ON edition.work_id = candidate.work_id
  LEFT JOIN metadata_provider AS candidate_provider ON candidate_provider.id = candidate.provider_id
  LEFT JOIN party_external_id AS external ON external.id = (
    SELECT preferred.id
    FROM party_external_id AS preferred
    LEFT JOIN metadata_provider AS preferred_provider ON preferred_provider.id = preferred.provider_id
    WHERE preferred.party_id = party.id
    ORDER BY
      CASE WHEN preferred_provider.code = 'dlsite' THEN 0 ELSE 1 END,
      preferred.is_primary DESC,
      preferred.id ASC
    LIMIT 1
  )
  WHERE candidate.role = 'circle'
    AND (
      candidate.work_id = target_work.id
      OR candidate.work_id = COALESCE(target_logical.canonical_work_id, target_work.id)
    )
  ORDER BY
    CASE
      WHEN candidate.work_id = target_work.id AND candidate.source = 'manual_override' THEN 0
      WHEN candidate.work_id = COALESCE(target_logical.canonical_work_id, target_work.id)
        AND candidate.source = 'manual_override' THEN 1
      WHEN candidate.work_id = COALESCE(target_logical.canonical_work_id, target_work.id)
        AND edition.maker_id <> ''
        AND UPPER(COALESCE(external.external_id, '')) = UPPER(edition.maker_id) THEN 2
      WHEN candidate.work_id = COALESCE(target_logical.canonical_work_id, target_work.id)
        AND candidate_provider.code = 'dlsite'
        AND candidate.source IN ('dlsite_snapshot', 'dlsite_product', 'dlsite_edition') THEN 3
      WHEN candidate.work_id = COALESCE(target_logical.canonical_work_id, target_work.id)
        AND candidate_provider.code = 'dlsite' THEN 4
      WHEN edition.maker_id <> ''
        AND UPPER(COALESCE(external.external_id, '')) = UPPER(edition.maker_id) THEN 5
      WHEN candidate_provider.code = 'dlsite'
        AND candidate.source IN ('dlsite_snapshot', 'dlsite_product', 'dlsite_edition') THEN 6
      WHEN candidate_provider.code = 'dlsite' THEN 7
      WHEN candidate.source = 'remote_source' THEN 9
      ELSE 8
    END,
    candidate.party_id ASC,
    candidate.work_id ASC
  LIMIT 1
);

CREATE TABLE work_primary_circle_projection (
  work_id INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
  party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  source TEXT NOT NULL
);

CREATE INDEX idx_work_primary_circle_projection_party
  ON work_primary_circle_projection(party_id, work_id);

INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
SELECT work_id, party_id, role, source FROM work_primary_circle_ranking;

CREATE VIEW work_primary_circle AS
SELECT
  projection.work_id,
  projection.party_id,
  party.display_name,
  COALESCE(external.external_id, '') AS external_id,
  projection.role,
  projection.source
FROM work_primary_circle_projection AS projection
INNER JOIN party ON party.id = projection.party_id
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
);

-- A work's primary circle depends on its own relations and edition and on
-- those of its family's canonical work.
CREATE VIEW work_primary_circle_dependency AS
SELECT work.id AS source_work_id, work.id AS work_id
FROM work
UNION ALL
SELECT logical.canonical_work_id AS source_work_id, edition.work_id
FROM logical_work AS logical
INNER JOIN work_edition AS edition ON edition.logical_work_id = logical.id
WHERE logical.canonical_work_id IS NOT NULL
  AND edition.work_id <> logical.canonical_work_id;

-- Upper-case codes of every edition in a logical work.
CREATE VIEW logical_work_member_code AS
SELECT edition.logical_work_id, UPPER(work.primary_code) AS code
FROM work_edition AS edition
INNER JOIN work ON work.id = edition.work_id;

CREATE VIEW party_catalog_owner_resolution AS
SELECT
  catalog.id AS catalog_item_id,
  COALESCE(
    CASE WHEN canonical_circle.source = 'manual_override' THEN canonical_circle.party_id END,
    origin_external.party_id,
    canonical_circle.party_id,
    catalog.party_id
  ) AS owner_party_id
FROM party_catalog_item AS catalog
LEFT JOIN work AS catalog_work
  ON UPPER(catalog_work.primary_code) = UPPER(catalog.primary_code)
LEFT JOIN work_edition AS catalog_edition
  ON catalog_edition.work_id = catalog_work.id
LEFT JOIN logical_work AS logical
  ON logical.id = catalog_edition.logical_work_id
LEFT JOIN work_edition AS origin_edition
  ON origin_edition.logical_work_id = logical.id
  AND origin_edition.is_canonical = 1
LEFT JOIN metadata_provider AS dlsite_provider
  ON dlsite_provider.code = 'dlsite'
LEFT JOIN party_external_id AS origin_external
  ON origin_external.provider_id = dlsite_provider.id
  AND origin_external.id_type = 'maker_id'
  AND UPPER(origin_external.external_id) = UPPER(origin_edition.maker_id)
LEFT JOIN work_primary_circle_projection AS canonical_circle
  ON canonical_circle.work_id = COALESCE(logical.canonical_work_id, catalog_work.id);

ALTER TABLE party_catalog_item ADD COLUMN owner_party_id INTEGER;

UPDATE party_catalog_item
SET owner_party_id = (
  SELECT resolution.owner_party_id
  FROM party_catalog_owner_resolution AS resolution
  WHERE resolution.catalog_item_id = party_catalog_item.id
);

CREATE INDEX idx_party_catalog_item_owner
  ON party_catalog_item(owner_party_id, UPPER(primary_code), provider_id);

CREATE INDEX idx_work_edition_origin_maker_upper
  ON work_edition(UPPER(maker_id))
  WHERE is_canonical = 1;

-- Primary circle maintenance. Each trigger upserts the recomputed winners of
-- the affected works and removes works that no longer have a circle; rows
-- whose winner is unchanged are not rewritten.

CREATE TRIGGER work_primary_circle_projection_work_party_insert
AFTER INSERT ON work_party
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = NEW.work_id)
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = NEW.work_id));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = NEW.work_id)
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_work_party_delete
AFTER DELETE ON work_party
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = OLD.work_id)
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = OLD.work_id));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = OLD.work_id)
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_work_party_update
AFTER UPDATE OF work_id, party_id, role, provider_id, source ON work_party
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (OLD.work_id, NEW.work_id))
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (OLD.work_id, NEW.work_id)));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (OLD.work_id, NEW.work_id))
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_edition_insert
AFTER INSERT ON work_edition
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = NEW.work_id)
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = NEW.work_id));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = NEW.work_id)
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_edition_delete
AFTER DELETE ON work_edition
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = OLD.work_id)
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = OLD.work_id));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id = OLD.work_id)
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_edition_update
AFTER UPDATE OF work_id, logical_work_id, maker_id ON work_edition
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (OLD.work_id, NEW.work_id))
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (OLD.work_id, NEW.work_id)));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (OLD.work_id, NEW.work_id))
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_logical_update
AFTER UPDATE OF canonical_work_id ON logical_work
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_edition WHERE logical_work_id = NEW.id)
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_edition WHERE logical_work_id = NEW.id));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_edition WHERE logical_work_id = NEW.id)
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

-- The ranking compares a party's preferred external id with edition maker
-- ids, so external id changes recompute the works related to that party.
CREATE TRIGGER work_primary_circle_projection_external_insert
AFTER INSERT ON party_external_id
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id = NEW.party_id AND role = 'circle'))
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id = NEW.party_id AND role = 'circle')));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id = NEW.party_id AND role = 'circle'))
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_external_delete
AFTER DELETE ON party_external_id
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id = OLD.party_id AND role = 'circle'))
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id = OLD.party_id AND role = 'circle')));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id = OLD.party_id AND role = 'circle'))
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

CREATE TRIGGER work_primary_circle_projection_external_update
AFTER UPDATE OF party_id, provider_id, id_type, external_id, is_primary ON party_external_id
BEGIN
  DELETE FROM work_primary_circle_projection
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id IN (OLD.party_id, NEW.party_id) AND role = 'circle'))
    AND work_id NOT IN (SELECT work_id FROM work_primary_circle_ranking WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id IN (OLD.party_id, NEW.party_id) AND role = 'circle')));
  INSERT INTO work_primary_circle_projection (work_id, party_id, role, source)
  SELECT work_id, party_id, role, source FROM work_primary_circle_ranking
  WHERE work_id IN (SELECT work_id FROM work_primary_circle_dependency WHERE source_work_id IN (SELECT work_id FROM work_party WHERE party_id IN (OLD.party_id, NEW.party_id) AND role = 'circle'))
  ON CONFLICT(work_id) DO UPDATE SET party_id = excluded.party_id, role = excluded.role, source = excluded.source
  WHERE party_id IS NOT excluded.party_id OR role IS NOT excluded.role OR source IS NOT excluded.source;
END;

-- Catalog owner maintenance. Each trigger re-resolves the catalog rows whose
-- code may depend on the changed input; unchanged owners are not rewritten.

CREATE TRIGGER party_catalog_owner_catalog_insert
AFTER INSERT ON party_catalog_item
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT owner_party_id FROM party_catalog_owner_resolution WHERE catalog_item_id = NEW.id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER party_catalog_owner_catalog_update
AFTER UPDATE OF party_id, primary_code ON party_catalog_item
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT owner_party_id FROM party_catalog_owner_resolution WHERE catalog_item_id = NEW.id)
  WHERE id = NEW.id;
END;

CREATE TRIGGER party_catalog_owner_work_delete
AFTER DELETE ON work
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE UPPER(primary_code) = UPPER(OLD.primary_code)
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_work_update
AFTER UPDATE OF primary_code ON work
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE UPPER(primary_code) IN (UPPER(OLD.primary_code), UPPER(NEW.primary_code))
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_edition_insert
AFTER INSERT ON work_edition
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE UPPER(primary_code) IN (SELECT code FROM logical_work_member_code WHERE logical_work_id = NEW.logical_work_id)
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_edition_delete
AFTER DELETE ON work_edition
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE (
      UPPER(primary_code) IN (SELECT code FROM logical_work_member_code WHERE logical_work_id = OLD.logical_work_id)
      OR UPPER(primary_code) IN (SELECT UPPER(primary_code) FROM work WHERE id = OLD.work_id)
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_edition_update
AFTER UPDATE OF work_id, logical_work_id, is_canonical, maker_id ON work_edition
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE (
      UPPER(primary_code) IN (SELECT code FROM logical_work_member_code WHERE logical_work_id IN (OLD.logical_work_id, NEW.logical_work_id))
      OR UPPER(primary_code) IN (SELECT UPPER(primary_code) FROM work WHERE id IN (OLD.work_id, NEW.work_id))
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_logical_update
AFTER UPDATE OF canonical_work_id ON logical_work
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE UPPER(primary_code) IN (SELECT code FROM logical_work_member_code WHERE logical_work_id = NEW.id)
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

-- The origin edition's maker id resolves to a party through its DLsite
-- maker id.
CREATE TRIGGER party_catalog_owner_external_insert
AFTER INSERT ON party_external_id
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE UPPER(primary_code) IN (
      SELECT member.code
      FROM work_edition AS origin
      INNER JOIN logical_work_member_code AS member ON member.logical_work_id = origin.logical_work_id
      WHERE origin.is_canonical = 1 AND UPPER(origin.maker_id) = UPPER(NEW.external_id)
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_external_delete
AFTER DELETE ON party_external_id
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE UPPER(primary_code) IN (
      SELECT member.code
      FROM work_edition AS origin
      INNER JOIN logical_work_member_code AS member ON member.logical_work_id = origin.logical_work_id
      WHERE origin.is_canonical = 1 AND UPPER(origin.maker_id) = UPPER(OLD.external_id)
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_external_update
AFTER UPDATE OF party_id, provider_id, id_type, external_id ON party_external_id
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE UPPER(primary_code) IN (
      SELECT member.code
      FROM work_edition AS origin
      INNER JOIN logical_work_member_code AS member ON member.logical_work_id = origin.logical_work_id
      WHERE origin.is_canonical = 1 AND UPPER(origin.maker_id) IN (UPPER(OLD.external_id), UPPER(NEW.external_id))
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

-- A work's primary circle decides the owner of its own catalog code and of
-- every edition code in the families it is canonical for.
CREATE TRIGGER party_catalog_owner_primary_circle_insert
AFTER INSERT ON work_primary_circle_projection
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE (
      UPPER(primary_code) IN (SELECT UPPER(primary_code) FROM work WHERE id = NEW.work_id)
      OR UPPER(primary_code) IN (
        SELECT member.code
        FROM logical_work AS logical
        INNER JOIN logical_work_member_code AS member ON member.logical_work_id = logical.id
        WHERE logical.canonical_work_id = NEW.work_id
      )
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_primary_circle_delete
AFTER DELETE ON work_primary_circle_projection
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE (
      UPPER(primary_code) IN (SELECT UPPER(primary_code) FROM work WHERE id = OLD.work_id)
      OR UPPER(primary_code) IN (
        SELECT member.code
        FROM logical_work AS logical
        INNER JOIN logical_work_member_code AS member ON member.logical_work_id = logical.id
        WHERE logical.canonical_work_id = OLD.work_id
      )
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;

CREATE TRIGGER party_catalog_owner_primary_circle_update
AFTER UPDATE ON work_primary_circle_projection
BEGIN
  UPDATE party_catalog_item
  SET owner_party_id = (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id)
  WHERE (
      UPPER(primary_code) IN (SELECT UPPER(primary_code) FROM work WHERE id IN (OLD.work_id, NEW.work_id))
      OR UPPER(primary_code) IN (
        SELECT member.code
        FROM logical_work AS logical
        INNER JOIN logical_work_member_code AS member ON member.logical_work_id = logical.id
        WHERE logical.canonical_work_id IN (OLD.work_id, NEW.work_id)
      )
    )
    AND owner_party_id IS NOT (SELECT resolution.owner_party_id FROM party_catalog_owner_resolution AS resolution WHERE resolution.catalog_item_id = party_catalog_item.id);
END;
