-- kikoto:foreign_keys=off
-- Removes tables, columns, and indexes that no code reads or writes. The
-- manager runs this file with foreign key enforcement off so rebuilding
-- llm_translation_task and translation_item does not cascade into other rows,
-- then checks every reference.

-- llm_translation_task keeps the rows of retired per-work LLM translation
-- runs. Their request, execution record, and preview link are never read.
CREATE TABLE llm_translation_task_next (
 id INTEGER PRIMARY KEY,
 workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
 work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
 dedup_key TEXT NOT NULL UNIQUE,
 input_hash TEXT NOT NULL,
 policy_hash TEXT NOT NULL,
 config_hash TEXT NOT NULL,
 result_json TEXT NOT NULL DEFAULT '{}',
 request_index INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','requesting','ready','failed','uncertain','invalid','cancelled')),
 failure_code TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO llm_translation_task_next (
  id, workflow_run_id, user_id, work_id, dedup_key, input_hash, policy_hash,
  config_hash, result_json, request_index, state, failure_code, updated_at
)
SELECT
  id, workflow_run_id, user_id, work_id, dedup_key, input_hash, policy_hash,
  config_hash, result_json, request_index, state, failure_code, updated_at
FROM llm_translation_task;

DROP TABLE llm_translation_task;
ALTER TABLE llm_translation_task_next RENAME TO llm_translation_task;

CREATE INDEX idx_fk_llm_translation_task_work_id ON llm_translation_task(work_id);
CREATE INDEX idx_fk_llm_translation_task_workflow_run_id ON llm_translation_task(workflow_run_id);
CREATE INDEX idx_llm_translation_task_user_work ON llm_translation_task(user_id, work_id, state);

-- A translation item no longer records a speech transcription: speech
-- transcription publishes its lyrics from asr_transcription itself.
-- Translate with AI writes only llm items; engine asr and the
-- waiting_transcription state stay accepted so no existing row is rejected.
CREATE TABLE translation_item_next (
  id INTEGER PRIMARY KEY,
  workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  requested_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  language TEXT NOT NULL CHECK(language IN ('ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  category TEXT NOT NULL CHECK(category IN ('title', 'description', 'tag', 'file_name', 'folder_name', 'lyrics')),
  subject TEXT NOT NULL DEFAULT '',
  engine TEXT NOT NULL DEFAULT 'llm' CHECK(engine IN ('llm', 'asr')),
  dedup_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN (
    'queued', 'waiting_transcription', 'requesting', 'ready', 'accepted', 'rejected',
    'failed', 'uncertain', 'invalid', 'policy_blocked', 'cancelled')),
  failure_code TEXT NOT NULL DEFAULT '',
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

INSERT INTO translation_item_next (
  id, workflow_run_id, work_id, requested_by_user_id, language, category,
  subject, engine, dedup_key, state, failure_code, detail_json, source_text,
  source_hash, result_text, checkpoint_json, request_index, provider_id, model,
  config_hash, policy_hash, reviewed_by_user_id, reviewed_at, created_at,
  updated_at
)
SELECT
  id, workflow_run_id, work_id, requested_by_user_id, language, category,
  subject, engine, dedup_key, state, failure_code, detail_json, source_text,
  source_hash, result_text, checkpoint_json, request_index, provider_id, model,
  config_hash, policy_hash, reviewed_by_user_id, reviewed_at, created_at,
  updated_at
FROM translation_item;

DROP TABLE translation_item;
ALTER TABLE translation_item_next RENAME TO translation_item;

CREATE INDEX idx_fk_translation_item_requested_by_user_id ON translation_item(requested_by_user_id);
CREATE INDEX idx_fk_translation_item_reviewed_by_user_id ON translation_item(reviewed_by_user_id);
CREATE INDEX idx_fk_translation_item_workflow_run_id ON translation_item(workflow_run_id);
CREATE UNIQUE INDEX idx_translation_item_active ON translation_item(dedup_key)
  WHERE state IN ('queued', 'waiting_transcription', 'requesting', 'ready', 'uncertain');
CREATE INDEX idx_translation_item_state ON translation_item(state, updated_at);
CREATE INDEX idx_translation_item_work ON translation_item(work_id, language, state);

-- Previews, lyrics, and tag-name candidates of retired LLM translation runs;
-- per-track progress, replaced by user_work_playback_cursor; and the trigger
-- map of the v0.7.0 workflow upgrade. The full-library recommendation score
-- cache stays: it can be large, and the bounded cleanup worker empties it
-- outside the migration transaction.
DROP TABLE llm_translation_preview;
DROP TABLE llm_lyrics_asset;
DROP TABLE metadata_tag_llm_candidate;
DROP TABLE user_media_progress;
DROP TABLE legacy_workflow_trigger_migration;

-- Columns created for features that were never built.
ALTER TABLE work DROP COLUMN cover_asset_id;
ALTER TABLE file_source_endpoint DROP COLUMN auth_type;
ALTER TABLE file_source_endpoint DROP COLUMN credential_ref;

-- Each of these indexes repeats an INTEGER PRIMARY KEY, a UNIQUE constraint's
-- index, or the leading columns of another index on the same table.
DROP INDEX idx_fk_filesystem_trigger_state_trigger_id;
DROP INDEX idx_fk_metadata_snapshot_card_summary_snapshot_id;
DROP INDEX idx_fk_metadata_snapshot_card_summary_dirty_snapshot_id;
DROP INDEX idx_fk_party_external_id_party_id;
DROP INDEX idx_party_external_id_lookup;
DROP INDEX idx_party_series_party;
DROP INDEX idx_fk_ranking_variant_list;
DROP INDEX idx_fk_recommendation_snapshot_state_user_id;
DROP INDEX idx_fk_recommendation_user_revision_user_id;
DROP INDEX idx_fk_user_password_credential_user_id;
DROP INDEX idx_fk_user_preference_user_id;
DROP INDEX idx_fk_voice_catalog_refresh_state_person_id;
DROP INDEX idx_fk_work_edition_work_id;
DROP INDEX idx_workflow_run_review_run;
