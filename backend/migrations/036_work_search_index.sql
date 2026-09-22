-- Library text search reads a trigram FTS5 index instead of evaluating
-- leading-wildcard LIKE predicates across every related table per row.
--
-- One index row describes one work (rowid = work.id) with the work's own
-- searchable text. Edition-family expansion stays in the query so a sibling's
-- change never needs to rewrite other rows. The application folds documents
-- (NFKC, Unicode lowercase, katakana to hiragana) before writing them, so the
-- triggers below only queue affected works in work_search_dirty. Keeping the
-- triggers free of application SQL functions leaves ordinary writes valid from
-- any SQLite client; the application drains the queue before searching.
--
-- Queue inserts skip already-queued works instead of using INSERT OR IGNORE:
-- a conflict clause on the statement that fires a trigger overrides the
-- trigger's own clause, so OR IGNORE could still abort an outer OR ABORT.

CREATE VIRTUAL TABLE work_search USING fts5(
  code,
  title,
  circle,
  voice_actor,
  tag,
  tokenize = 'trigram'
);

CREATE TABLE work_search_dirty (
  work_id INTEGER PRIMARY KEY
);

INSERT INTO work_search_dirty (work_id)
SELECT id FROM work;

CREATE TRIGGER work_search_work_insert
AFTER INSERT ON work
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.id);
END;

CREATE TRIGGER work_search_work_update
AFTER UPDATE OF primary_code, title ON work
WHEN OLD.primary_code IS NOT NEW.primary_code OR OLD.title IS NOT NEW.title
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.id);
END;

CREATE TRIGGER work_search_work_delete
AFTER DELETE ON work
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.id);
END;

CREATE TRIGGER work_search_edition_insert
AFTER INSERT ON work_edition
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_edition_update
AFTER UPDATE OF work_id, logical_work_id ON work_edition
WHEN OLD.work_id IS NOT NEW.work_id OR OLD.logical_work_id IS NOT NEW.logical_work_id
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_edition_delete
AFTER DELETE ON work_edition
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;

CREATE TRIGGER work_search_code_alias_insert
AFTER INSERT ON work_code_alias
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_edition WHERE logical_work_id = NEW.logical_work_id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_code_alias_update
AFTER UPDATE OF logical_work_id, primary_code ON work_code_alias
WHEN OLD.logical_work_id IS NOT NEW.logical_work_id OR OLD.primary_code IS NOT NEW.primary_code
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_edition WHERE logical_work_id IN (OLD.logical_work_id, NEW.logical_work_id)
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_code_alias_delete
AFTER DELETE ON work_code_alias
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_edition WHERE logical_work_id = OLD.logical_work_id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_party_link_insert
AFTER INSERT ON work_party
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_party_link_update
AFTER UPDATE OF work_id, party_id, role ON work_party
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_party_link_delete
AFTER DELETE ON work_party
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;

CREATE TRIGGER work_search_party_update
AFTER UPDATE OF display_name ON party
WHEN OLD.display_name IS NOT NEW.display_name
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_party WHERE party_id = NEW.id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_party_external_id_insert
AFTER INSERT ON party_external_id
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_party WHERE party_id = NEW.party_id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_party_external_id_update
AFTER UPDATE OF party_id, external_id ON party_external_id
WHEN OLD.party_id IS NOT NEW.party_id OR OLD.external_id IS NOT NEW.external_id
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_party WHERE party_id IN (OLD.party_id, NEW.party_id)
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_party_external_id_delete
AFTER DELETE ON party_external_id
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_party WHERE party_id = OLD.party_id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_credit_insert
AFTER INSERT ON work_credit
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_credit_update
AFTER UPDATE OF work_id, person_id, role ON work_credit
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_credit_delete
AFTER DELETE ON work_credit
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;

CREATE TRIGGER work_search_person_update
AFTER UPDATE OF display_name ON person
WHEN OLD.display_name IS NOT NEW.display_name
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_credit WHERE person_id = NEW.id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_tag_link_insert
AFTER INSERT ON work_tag
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_tag_link_update
AFTER UPDATE OF work_id, tag_id ON work_tag
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_tag_link_delete
AFTER DELETE ON work_tag
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;

CREATE TRIGGER work_search_tag_update
AFTER UPDATE OF namespace, display_name ON tag
WHEN OLD.namespace IS NOT NEW.namespace OR OLD.display_name IS NOT NEW.display_name
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_tag WHERE tag_id = NEW.id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_override_insert
AFTER INSERT ON work_manual_override
WHEN NEW.field_name IN ('title', 'circle', 'series', 'voice_actors')
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_override_update
AFTER UPDATE OF work_id, field_name, value_json ON work_manual_override
WHEN OLD.field_name IN ('title', 'circle', 'series', 'voice_actors')
  OR NEW.field_name IN ('title', 'circle', 'series', 'voice_actors')
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty (work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;

CREATE TRIGGER work_search_override_delete
AFTER DELETE ON work_manual_override
WHEN OLD.field_name IN ('title', 'circle', 'series', 'voice_actors')
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;
