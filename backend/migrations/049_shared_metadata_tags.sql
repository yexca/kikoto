CREATE TABLE metadata_tag (
  tag_id INTEGER PRIMARY KEY REFERENCES tag(id) ON DELETE RESTRICT,
  dlsite_genre_id INTEGER UNIQUE CHECK(dlsite_genre_id > 0),
  merged_into_tag_id INTEGER REFERENCES metadata_tag(tag_id) ON DELETE RESTRICT,
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0, 1)),
  created_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(merged_into_tag_id IS NULL OR merged_into_tag_id <> tag_id)
);
CREATE INDEX idx_metadata_tag_merge ON metadata_tag(merged_into_tag_id);

CREATE TABLE metadata_tag_name (
  tag_id INTEGER NOT NULL REFERENCES metadata_tag(tag_id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL CHECK(TRIM(name) <> ''),
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(tag_id, language)
);

CREATE TABLE work_tag_override (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES metadata_tag(tag_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('add', 'remove')),
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, tag_id)
);
CREATE INDEX idx_work_tag_override_tag ON work_tag_override(tag_id, work_id);

-- Provider bases retain original identities even after removal, hiding or merging.
CREATE TABLE work_metadata_tag_base (
 work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
 tag_id INTEGER NOT NULL REFERENCES metadata_tag(tag_id) ON DELETE RESTRICT,
 PRIMARY KEY(work_id,tag_id)
);
CREATE INDEX idx_work_metadata_tag_base_tag ON work_metadata_tag_base(tag_id,work_id);
CREATE TABLE work_metadata_tag_projection (
 work_id INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
 source_work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE
);
CREATE INDEX idx_work_metadata_tag_projection_source ON work_metadata_tag_projection(source_work_id,work_id);
CREATE VIEW metadata_tag_resolution AS
 WITH RECURSIVE resolution(source_tag_id,tag_id,next_tag_id) AS (
 SELECT tag_id,tag_id,merged_into_tag_id FROM metadata_tag
 UNION
 SELECT resolution.source_tag_id,concept.tag_id,concept.merged_into_tag_id FROM resolution
 JOIN metadata_tag AS concept ON concept.tag_id=resolution.next_tag_id
 ) SELECT source_tag_id,tag_id AS resolved_tag_id FROM resolution WHERE next_tag_id IS NULL;
CREATE TRIGGER metadata_tags_snapshot_insert AFTER INSERT ON metadata_snapshot BEGIN
 DELETE FROM work_metadata_tag_projection WHERE work_id=NEW.work_id OR source_work_id=NEW.work_id;
END;
CREATE TRIGGER metadata_tags_snapshot_update AFTER UPDATE OF snapshot_json,work_id ON metadata_snapshot BEGIN
 DELETE FROM work_metadata_tag_projection WHERE work_id IN (OLD.work_id,NEW.work_id) OR source_work_id IN (OLD.work_id,NEW.work_id);
END;

-- Only create concepts for known ids. Work projection is a resumable Go backfill.
INSERT INTO tag (namespace, normalized_name, display_name, language)
SELECT 'metadata', 'dlsite-genre:' || genre_id,
  COALESCE((SELECT name FROM dlsite_genre_name AS name WHERE name.genre_id = ids.genre_id
    ORDER BY CASE WHEN language = 'ja-jp' THEN 0 ELSE 1 END, language LIMIT 1), ''), ''
FROM (SELECT genre_id FROM dlsite_genre_name UNION SELECT genre_id FROM work_dlsite_genre) AS ids;

INSERT INTO metadata_tag(tag_id, dlsite_genre_id)
SELECT id, CAST(SUBSTR(normalized_name, 14) AS INTEGER) FROM tag WHERE namespace = 'metadata';

CREATE TRIGGER work_search_metadata_tag_name_insert AFTER INSERT ON metadata_tag_name

BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (NEW.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_metadata_tag_name_update AFTER UPDATE OF name,language ON metadata_tag_name
WHEN OLD.name IS NOT NEW.name OR OLD.language IS NOT NEW.language
BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (OLD.tag_id,NEW.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_metadata_tag_name_delete AFTER DELETE ON metadata_tag_name

BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (OLD.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_metadata_tag_state_before BEFORE UPDATE OF hidden,merged_into_tag_id ON metadata_tag
WHEN OLD.hidden IS NOT NEW.hidden OR OLD.merged_into_tag_id IS NOT NEW.merged_into_tag_id
BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (OLD.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_metadata_tag_state_update AFTER UPDATE OF hidden,merged_into_tag_id ON metadata_tag
WHEN OLD.hidden IS NOT NEW.hidden OR OLD.merged_into_tag_id IS NOT NEW.merged_into_tag_id
BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (NEW.tag_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_metadata_tag_display_update AFTER UPDATE OF display_name ON tag
WHEN OLD.display_name IS NOT NEW.display_name
BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (NEW.id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_shared_genre_insert AFTER INSERT ON dlsite_genre_name BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (SELECT tag_id FROM metadata_tag WHERE dlsite_genre_id=NEW.genre_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_shared_genre_update AFTER UPDATE OF name,language,genre_id ON dlsite_genre_name BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (SELECT tag_id FROM metadata_tag WHERE dlsite_genre_id=NEW.genre_id OR dlsite_genre_id=OLD.genre_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;
CREATE TRIGGER work_search_shared_genre_delete AFTER DELETE ON dlsite_genre_name BEGIN
 INSERT INTO work_search_dirty(work_id)
 SELECT DISTINCT link.work_id FROM work_tag AS link JOIN metadata_tag_resolution AS resolved ON resolved.resolved_tag_id=link.tag_id
 WHERE resolved.source_tag_id IN (SELECT tag_id FROM metadata_tag WHERE dlsite_genre_id=OLD.genre_id) AND NOT EXISTS(SELECT 1 FROM work_search_dirty AS dirty WHERE dirty.work_id=link.work_id);
END;

INSERT OR IGNORE INTO work_search_dirty(work_id) SELECT id FROM work;
