-- Bounded language-title projection of stored remote snapshots. Edition codes
-- are metadata references; these rows create no work, edition or availability.
CREATE TABLE remote_metadata_title_variant (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK(language IN ('origin','ja-jp','zh-cn','zh-tw','en-us','ko-kr')),
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  edition_code TEXT NOT NULL,
  edition_language TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  is_original INTEGER NOT NULL CHECK(is_original IN (0,1)),
  PRIMARY KEY(work_id,language)
) WITHOUT ROWID;

CREATE TRIGGER remote_title_variant_insert AFTER INSERT ON remote_metadata_title_variant
BEGIN
  INSERT INTO work_title_language_dirty(work_id) SELECT NEW.work_id
  WHERE NEW.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
  INSERT INTO work_search_dirty(work_id) SELECT NEW.work_id
  WHERE NEW.work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER remote_title_variant_delete AFTER DELETE ON remote_metadata_title_variant
BEGIN
  INSERT INTO work_title_language_dirty(work_id) SELECT OLD.work_id
  WHERE OLD.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
  INSERT INTO work_search_dirty(work_id) SELECT OLD.work_id
  WHERE OLD.work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER remote_title_variant_update AFTER UPDATE ON remote_metadata_title_variant
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT work_id FROM (SELECT OLD.work_id AS work_id UNION SELECT NEW.work_id)
  WHERE work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
  INSERT INTO work_search_dirty(work_id)
  SELECT work_id FROM (SELECT OLD.work_id AS work_id UNION SELECT NEW.work_id)
  WHERE work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

-- The existing bounded snapshot projection worker fills old remote snapshots.
INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
SELECT DISTINCT snapshot.work_id FROM metadata_snapshot AS snapshot
JOIN metadata_provider AS provider ON provider.id=snapshot.provider_id
WHERE provider.code GLOB 'kikoeru_source_*';
