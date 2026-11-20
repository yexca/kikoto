-- kikoto:foreign_keys=off
-- A voice actor is identified by the provider ids it carries, not by its name:
-- two people may share a display name. The manager runs this file with
-- foreign key enforcement off so dropping the old table does not cascade into
-- credits, aliases, external ids, and personal state, then checks every
-- reference. Every person keeps its id. ambiguous_name marks a person created
-- for a credit without a provider id whose name several identified people
-- hold: no provider id or merge ever lands on it.

CREATE TABLE person_next (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL DEFAULT '',
  ambiguous_name INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous_name IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO person_next (id, display_name, sort_name, created_at, updated_at)
SELECT id, display_name, sort_name, created_at, updated_at FROM person;

DROP TABLE person;
ALTER TABLE person_next RENAME TO person;

CREATE INDEX idx_person_display_name ON person(display_name);

CREATE TRIGGER recommendation_names_person_delete AFTER DELETE ON person BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_insert AFTER INSERT ON person BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_update AFTER UPDATE ON person BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

-- Every trigger the old table carried is created again.
CREATE TRIGGER recommendation_revision_profile_person_delete
AFTER DELETE ON person
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_person_insert
AFTER INSERT ON person
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_person_update
AFTER UPDATE OF display_name ON person
WHEN OLD.display_name IS NOT NEW.display_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER work_search_person_update
AFTER UPDATE OF display_name ON person
WHEN OLD.display_name IS NOT NEW.display_name
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT work_id FROM work_credit WHERE person_id = NEW.id
    AND work_id NOT IN (SELECT work_id FROM work_search_dirty);
END;
