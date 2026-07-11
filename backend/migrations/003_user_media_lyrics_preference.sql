CREATE TABLE user_media_lyrics_preference (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  audio_media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  lyrics_media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, audio_media_item_id),
  CHECK(audio_media_item_id <> lyrics_media_item_id)
);

CREATE INDEX idx_user_media_lyrics_preference_lyrics
  ON user_media_lyrics_preference(lyrics_media_item_id, user_id);
