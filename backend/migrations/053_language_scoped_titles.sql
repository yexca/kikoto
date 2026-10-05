-- Existing authored values retain their all-language scope. Only titles may
-- acquire a language; shared people, circles, series and covers remain global.
DROP TRIGGER work_search_override_insert;
DROP TRIGGER work_search_override_update;
DROP TRIGGER work_search_override_delete;
CREATE TABLE work_manual_override_next (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT '' CHECK (language IN ('', 'ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  value_json TEXT NOT NULL DEFAULT 'null',
  asset_path TEXT NOT NULL DEFAULT '',
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, field_name, language),
  CHECK (field_name = 'title' OR language = '')
);
INSERT INTO work_manual_override_next
  (work_id, field_name, value_json, asset_path, updated_by_user_id, created_at, updated_at)
SELECT work_id, field_name, value_json, asset_path, updated_by_user_id, created_at, updated_at
FROM work_manual_override;
DROP TABLE work_manual_override;
ALTER TABLE work_manual_override_next RENAME TO work_manual_override;
CREATE INDEX idx_work_manual_override_field ON work_manual_override(field_name, updated_at);
CREATE INDEX idx_fk_work_manual_override_updated_by_user_id ON work_manual_override(updated_by_user_id);

CREATE TRIGGER work_search_override_insert
AFTER INSERT ON work_manual_override
WHEN NEW.field_name IN ('title', 'circle', 'series', 'voice_actors')
BEGIN
  INSERT INTO work_search_dirty(work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;
CREATE TRIGGER work_search_override_update
AFTER UPDATE OF work_id, field_name, language, value_json ON work_manual_override
WHEN OLD.field_name IN ('title', 'circle', 'series', 'voice_actors')
  OR NEW.field_name IN ('title', 'circle', 'series', 'voice_actors')
BEGIN
  INSERT INTO work_search_dirty(work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
  INSERT INTO work_search_dirty(work_id)
  SELECT NEW.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = NEW.work_id);
END;
CREATE TRIGGER work_search_override_delete
AFTER DELETE ON work_manual_override
WHEN OLD.field_name IN ('title', 'circle', 'series', 'voice_actors')
BEGIN
  INSERT INTO work_search_dirty(work_id)
  SELECT OLD.work_id WHERE NOT EXISTS (SELECT 1 FROM work_search_dirty WHERE work_id = OLD.work_id);
END;
