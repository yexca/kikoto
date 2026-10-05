-- Per-user preferred metadata language. NULL follows the instance default in
-- app_setting `dlsite_metadata_languages`; a JSON array is the user's own
-- priority, normalized by the application with `origin` as the final entry.
ALTER TABLE user_preference ADD COLUMN metadata_languages TEXT;

-- Display title of each work for every language that title selection can stop
-- at: a supported language with its own edition or language-specific manual
-- title, plus `origin`, which always exists. A viewer's title sort reads the
-- first present row in its priority. Rows depend only on stored editions and
-- manual titles, never on any preference, so no preference change rewrites
-- them.
CREATE TABLE work_title_language (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK(language IN ('origin', 'ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  title TEXT NOT NULL,
  PRIMARY KEY(work_id, language)
) WITHOUT ROWID;

-- Works whose language titles must be recomputed. A family's editions share
-- their titles, so an edition or variant change queues the whole family.
CREATE TABLE work_title_language_dirty (
  work_id INTEGER PRIMARY KEY
);

-- Trigger inserts skip queued works instead of using OR IGNORE: the conflict
-- policy of the statement that fires a trigger overrides the trigger's own.
CREATE TRIGGER work_title_language_variant_insert AFTER INSERT ON dlsite_metadata_variant
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT work_id FROM work_edition WHERE logical_work_id IN (NEW.logical_work_id)) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_variant_delete AFTER DELETE ON dlsite_metadata_variant
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT work_id FROM work_edition WHERE logical_work_id IN (OLD.logical_work_id)) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_variant_update AFTER UPDATE OF logical_work_id, work_id, title, edition_language ON dlsite_metadata_variant
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT work_id FROM work_edition WHERE logical_work_id IN (OLD.logical_work_id, NEW.logical_work_id)) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_override_insert AFTER INSERT ON work_manual_override
WHEN NEW.field_name = 'title'
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT NEW.work_id AS work_id) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_override_delete AFTER DELETE ON work_manual_override
WHEN OLD.field_name = 'title'
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT OLD.work_id AS work_id) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_override_update AFTER UPDATE OF work_id, field_name, language, value_json ON work_manual_override
WHEN OLD.field_name = 'title' OR NEW.field_name = 'title'
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT OLD.work_id AS work_id UNION SELECT NEW.work_id) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_work_insert AFTER INSERT ON work
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT NEW.id AS work_id) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

-- The canonical work row is the languageless fallback of every edition.
CREATE TRIGGER work_title_language_work_update AFTER UPDATE OF title ON work
WHEN OLD.title IS NOT NEW.title
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT NEW.id AS work_id UNION SELECT sibling.work_id FROM work_edition AS current
    JOIN work_edition AS sibling ON sibling.logical_work_id = current.logical_work_id
    WHERE current.work_id = NEW.id) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_edition_insert AFTER INSERT ON work_edition
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT work_id FROM work_edition WHERE logical_work_id IN (NEW.logical_work_id)) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_edition_delete AFTER DELETE ON work_edition
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT OLD.work_id AS work_id UNION SELECT work_id FROM work_edition WHERE logical_work_id IN (OLD.logical_work_id)) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

CREATE TRIGGER work_title_language_edition_update AFTER UPDATE OF work_id, logical_work_id, is_canonical, metadata_language ON work_edition
BEGIN
  INSERT INTO work_title_language_dirty(work_id)
  SELECT DISTINCT queued.work_id FROM (SELECT OLD.work_id AS work_id UNION SELECT NEW.work_id UNION SELECT work_id FROM work_edition WHERE logical_work_id IN (OLD.logical_work_id, NEW.logical_work_id)) AS queued
  WHERE queued.work_id NOT IN (SELECT work_id FROM work_title_language_dirty);
END;

INSERT INTO work_title_language_dirty(work_id) SELECT id FROM work;

-- Shared tags of a canonical work now always come from its original edition
-- instead of the edition the preferred language selected. Reproject the
-- canonical works of families that have another DLsite edition.
INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
SELECT edition.work_id FROM work_edition AS edition
WHERE edition.is_canonical = 1
  AND EXISTS (
    SELECT 1 FROM dlsite_metadata_variant AS variant
    WHERE variant.logical_work_id = edition.logical_work_id AND variant.work_id <> edition.work_id
  );
