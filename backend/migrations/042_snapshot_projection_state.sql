-- Metadata refreshes rewrite provenance and timestamps on credit, circle, and
-- tag rows whose values did not change. The recommendation revision triggers
-- fired on every such UPDATE, so one refresh advanced the global revision
-- once per row and rebuilt every user's recommendations. They now fire only
-- when a value the recommendation scorer reads changes.

DROP TRIGGER recommendation_revision_work_tag_update;
CREATE TRIGGER recommendation_revision_work_tag_update
AFTER UPDATE ON work_tag
WHEN OLD.work_id IS NOT NEW.work_id OR OLD.tag_id IS NOT NEW.tag_id
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

DROP TRIGGER recommendation_revision_tag_namespace_update;
CREATE TRIGGER recommendation_revision_tag_namespace_update
AFTER UPDATE OF namespace ON tag
WHEN OLD.namespace IS NOT NEW.namespace
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

DROP TRIGGER recommendation_revision_work_credit_update;
CREATE TRIGGER recommendation_revision_work_credit_update
AFTER UPDATE ON work_credit
WHEN OLD.work_id IS NOT NEW.work_id OR OLD.person_id IS NOT NEW.person_id OR OLD.role IS NOT NEW.role
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

DROP TRIGGER recommendation_revision_work_party_update;
CREATE TRIGGER recommendation_revision_work_party_update
AFTER UPDATE ON work_party
WHEN OLD.work_id IS NOT NEW.work_id OR OLD.party_id IS NOT NEW.party_id OR OLD.role IS NOT NEW.role
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

DROP TRIGGER recommendation_revision_user_state_update;
CREATE TRIGGER recommendation_revision_user_state_update
AFTER UPDATE OF listening_status, favorite ON user_work_state
WHEN OLD.listening_status IS NOT NEW.listening_status OR OLD.favorite IS NOT NEW.favorite
BEGIN
  INSERT INTO recommendation_user_revision (user_id, revision, updated_at)
  VALUES (NEW.user_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = recommendation_user_revision.revision + 1,
    updated_at = CURRENT_TIMESTAMP;
END;

-- Voice credits and DLsite circle relations are projected from each work's
-- latest metadata snapshot. This table records which snapshot and projection
-- input each work last produced, so startup and metadata sync project only
-- works whose latest snapshot changed instead of the whole library. An empty
-- table projects every work once.
CREATE TABLE work_snapshot_projection (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('voice_credit', 'dlsite_party')),
  snapshot_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  PRIMARY KEY(work_id, kind)
) WITHOUT ROWID;

-- Removing or reassigning a projected row, such as clearing a manual
-- override or deleting a placeholder circle, lets the next pass restore what
-- the snapshot still declares, as the former full projection did.
CREATE TRIGGER work_snapshot_projection_credit_delete
AFTER DELETE ON work_credit
BEGIN
  DELETE FROM work_snapshot_projection
  WHERE work_id = OLD.work_id AND kind = 'voice_credit';
END;

CREATE TRIGGER work_snapshot_projection_party_delete
AFTER DELETE ON work_party
BEGIN
  DELETE FROM work_snapshot_projection
  WHERE work_id = OLD.work_id AND kind = 'dlsite_party';
END;

CREATE TRIGGER work_snapshot_projection_party_update
AFTER UPDATE ON work_party
WHEN OLD.work_id IS NOT NEW.work_id
  OR OLD.party_id IS NOT NEW.party_id
  OR OLD.role IS NOT NEW.role
  OR OLD.provider_id IS NOT NEW.provider_id
  OR OLD.source IS NOT NEW.source
BEGIN
  DELETE FROM work_snapshot_projection
  WHERE work_id IN (OLD.work_id, NEW.work_id) AND kind = 'dlsite_party';
END;

-- The circle projection also writes the work's own catalog row. A circle
-- refresh or cleanup that changes or removes it lets the next pass restore it.
CREATE TRIGGER work_snapshot_projection_catalog_update
AFTER UPDATE ON party_catalog_item
WHEN OLD.catalog_status = 'imported' AND (
  OLD.party_id IS NOT NEW.party_id
  OR OLD.primary_code IS NOT NEW.primary_code
  OR OLD.title IS NOT NEW.title
  OR OLD.release_date IS NOT NEW.release_date
  OR OLD.url IS NOT NEW.url
  OR OLD.catalog_status IS NOT NEW.catalog_status
  OR OLD.dlsite_available IS NOT NEW.dlsite_available
  OR OLD.raw_json IS NOT NEW.raw_json
)
BEGIN
  DELETE FROM work_snapshot_projection
  WHERE kind = 'dlsite_party'
    AND work_id IN (SELECT id FROM work WHERE primary_code = OLD.primary_code);
END;

CREATE TRIGGER work_snapshot_projection_catalog_delete
AFTER DELETE ON party_catalog_item
WHEN OLD.catalog_status = 'imported'
BEGIN
  DELETE FROM work_snapshot_projection
  WHERE kind = 'dlsite_party'
    AND work_id IN (SELECT id FROM work WHERE primary_code = OLD.primary_code);
END;

-- Every projection of a circle's works appended its snapshot, and nothing
-- read or removed the older rows. Keep the two latest rows per circle and
-- provider, as metadata_snapshot does per work; the application applies the
-- same retention from now on.
DELETE FROM party_metadata_snapshot
WHERE party_id IS NOT NULL
  AND id NOT IN (
    SELECT id
    FROM (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY party_id, provider_id
          ORDER BY fetched_at DESC, id DESC
        ) AS position
      FROM party_metadata_snapshot
      WHERE party_id IS NOT NULL
    )
    WHERE position <= 2
  );
