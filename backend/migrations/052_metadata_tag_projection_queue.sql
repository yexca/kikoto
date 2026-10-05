CREATE TABLE work_metadata_tag_dirty (
 work_id INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
 retry_count INTEGER NOT NULL DEFAULT 0,
 retry_after INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_work_metadata_tag_dirty_retry ON work_metadata_tag_dirty(retry_after,work_id);

-- Snapshot writers queue in the same transaction, including
-- canonical works that used the changed edition. Every provider writer is
-- covered; the projector alone decides which provider input is eligible.
DROP TRIGGER metadata_tags_snapshot_insert;
DROP TRIGGER metadata_tags_snapshot_update;
CREATE TRIGGER metadata_tags_snapshot_insert AFTER INSERT ON metadata_snapshot BEGIN
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
 SELECT projection.work_id FROM work_metadata_tag_projection AS projection JOIN work ON work.id=projection.work_id WHERE source_work_id=NEW.work_id;
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id) SELECT id FROM work WHERE id=NEW.work_id;
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
 SELECT sibling.work_id FROM work_edition AS edition JOIN work_edition AS sibling ON sibling.logical_work_id=edition.logical_work_id JOIN work ON work.id=sibling.work_id WHERE edition.work_id=NEW.work_id;
END;
CREATE TRIGGER metadata_tags_snapshot_update AFTER UPDATE OF snapshot_json,work_id,provider_id,request_locale ON metadata_snapshot BEGIN
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
 SELECT projection.work_id FROM work_metadata_tag_projection AS projection JOIN work ON work.id=projection.work_id WHERE source_work_id IN (OLD.work_id,NEW.work_id);
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id) SELECT id FROM work WHERE id IN (OLD.work_id,NEW.work_id);
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
 SELECT sibling.work_id FROM work_edition AS edition JOIN work_edition AS sibling ON sibling.logical_work_id=edition.logical_work_id JOIN work ON work.id=sibling.work_id WHERE edition.work_id IN (OLD.work_id,NEW.work_id);
END;
CREATE TRIGGER metadata_tags_snapshot_delete BEFORE DELETE ON metadata_snapshot BEGIN
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
 SELECT projection.work_id FROM work_metadata_tag_projection AS projection JOIN work ON work.id=projection.work_id WHERE source_work_id=OLD.work_id;
 INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id) SELECT id FROM work WHERE id=OLD.work_id;
END;

-- Re-evaluate pre-release projections, including remote bases imported before
-- the DLsite-only fallback boundary was enforced.
INSERT INTO work_metadata_tag_dirty(work_id) SELECT id FROM work;

DELETE FROM app_setting WHERE key='metadata_tag_projection_version';
