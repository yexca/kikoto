-- A library-level lyrics assignment is the shared default lyrics file for an
-- audio media item. A personal user_media_lyrics_preference still overrides it,
-- and automatic name matching applies only when neither exists.
CREATE TABLE media_lyrics_assignment (
  audio_media_item_id INTEGER PRIMARY KEY REFERENCES media_item(id) ON DELETE CASCADE,
  lyrics_media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual', 'remote_fetch')),
  assigned_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(audio_media_item_id <> lyrics_media_item_id)
);

CREATE INDEX idx_fk_media_lyrics_assignment_lyrics_media_item_id
  ON media_lyrics_assignment(lyrics_media_item_id);
CREATE INDEX idx_fk_media_lyrics_assignment_assigned_by_user_id
  ON media_lyrics_assignment(assigned_by_user_id);
