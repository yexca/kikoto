CREATE TABLE llm_translation_preview (
  id TEXT PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','rejected','expired')),
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_llm_preview_review ON llm_translation_preview(user_id,work_id,status,expires_at);

CREATE TABLE work_llm_translation_review (
  id INTEGER PRIMARY KEY,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  field_name TEXT NOT NULL,
  value_text TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK(action IN ('accepted','superseded','revoked','restored')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE work_llm_translation ADD COLUMN source_text TEXT NOT NULL DEFAULT '';
ALTER TABLE work_llm_translation ADD COLUMN source_work_id INTEGER REFERENCES work(id) ON DELETE SET NULL;

CREATE TRIGGER llm_source_title_expired AFTER UPDATE OF title ON work WHEN OLD.title<>NEW.title
BEGIN
 UPDATE work_llm_translation SET status='superseded',updated_at=CURRENT_TIMESTAMP
 WHERE source_work_id=NEW.id AND field_name='title' AND status='accepted';
END;
CREATE TRIGGER llm_source_description_expired AFTER UPDATE OF description ON work WHEN OLD.description<>NEW.description
BEGIN
 UPDATE work_llm_translation SET status='superseded',updated_at=CURRENT_TIMESTAMP
 WHERE source_work_id=NEW.id AND field_name='description' AND status='accepted';
END;
CREATE TRIGGER llm_variant_title_expired AFTER UPDATE OF title ON dlsite_metadata_variant WHEN OLD.title<>NEW.title
BEGIN
 UPDATE work_llm_translation SET status='superseded',updated_at=CURRENT_TIMESTAMP
 WHERE source_work_id=NEW.work_id AND field_name='title' AND status='accepted' AND source_text<>NEW.title;
END;
CREATE TRIGGER llm_remote_title_expired AFTER UPDATE OF title ON remote_metadata_title_variant WHEN OLD.title<>NEW.title AND NEW.language='origin'
BEGIN
 UPDATE work_llm_translation SET status='superseded',updated_at=CURRENT_TIMESTAMP
 WHERE source_work_id=NEW.work_id AND field_name='title' AND status='accepted' AND source_text<>NEW.title;
END;
