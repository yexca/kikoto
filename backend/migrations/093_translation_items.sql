-- One reviewable unit of a Translate with AI run: one work, one target
-- language, one category and one object of it. The run's workflow jobs
-- execute the items; the item holds the request checkpoint, the result
-- awaiting review and the review outcome. A shared tag name is one object
-- across the library, so its key leaves out the work.
CREATE TABLE translation_item (
  id INTEGER PRIMARY KEY,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  requested_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  language TEXT NOT NULL CHECK(language IN ('ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  category TEXT NOT NULL CHECK(category IN ('title', 'description', 'tag', 'file_name', 'folder_name', 'lyrics')),
  subject TEXT NOT NULL DEFAULT '',
  -- llm translates source text, and asr is the transcription of a track written
  -- by the speech service, in the original language or directly in the
  -- target language.
  engine TEXT NOT NULL DEFAULT 'llm' CHECK(engine IN ('llm', 'asr')),
  dedup_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN (
    'queued', 'waiting_transcription', 'requesting', 'ready', 'accepted', 'rejected',
    'failed', 'uncertain', 'invalid', 'policy_blocked', 'cancelled')),
  failure_code TEXT NOT NULL DEFAULT '',
  -- The transcription this item reads (lyrics from speech) or is (engine asr).
  asr_transcription_id TEXT REFERENCES asr_transcription(id) ON DELETE SET NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  source_text TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  result_text TEXT NOT NULL DEFAULT '',
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  request_index INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  config_hash TEXT NOT NULL DEFAULT '',
  policy_hash TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- An object that is queued, running, uncertain or waiting for review is not
-- missing, so it is never requested twice.
CREATE UNIQUE INDEX idx_translation_item_active ON translation_item(dedup_key)
  WHERE state IN ('queued', 'waiting_transcription', 'requesting', 'ready', 'uncertain');
CREATE INDEX idx_translation_item_state ON translation_item(state, updated_at);
CREATE INDEX idx_translation_item_work ON translation_item(work_id, language, state);
CREATE INDEX idx_fk_translation_item_workflow_run_id ON translation_item(workflow_run_id);
CREATE INDEX idx_fk_translation_item_requested_by_user_id ON translation_item(requested_by_user_id);
CREATE INDEX idx_fk_translation_item_asr_transcription_id ON translation_item(asr_transcription_id);
CREATE INDEX idx_fk_translation_item_reviewed_by_user_id ON translation_item(reviewed_by_user_id);

-- A display name accepted from an LLM keeps its model and the name it
-- translated, so the editor marks it and can restore the real name.
ALTER TABLE media_item_display_name ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual', 'llm'));
ALTER TABLE media_item_display_name ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE media_item_display_name ADD COLUMN source_text TEXT NOT NULL DEFAULT '';
ALTER TABLE work_folder_display_name ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual', 'llm'));
ALTER TABLE work_folder_display_name ADD COLUMN model TEXT NOT NULL DEFAULT '';
ALTER TABLE work_folder_display_name ADD COLUMN source_text TEXT NOT NULL DEFAULT '';

-- Translate with AI applies its results through acceptance, so earlier LLM
-- translation previews that wait for review have no place to be reviewed.
UPDATE llm_translation_preview SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'proposed';

-- The models that wrote a lyrics file Kikoto published from speech
-- recognition or translation. The player marks such lyrics as AI-made.
CREATE TABLE media_lyrics_ai_source (
  lyrics_media_item_id INTEGER PRIMARY KEY REFERENCES media_item(id) ON DELETE CASCADE,
  asr_model TEXT NOT NULL DEFAULT '',
  llm_model TEXT NOT NULL DEFAULT '',
  CHECK(asr_model <> '' OR llm_model <> '')
);
