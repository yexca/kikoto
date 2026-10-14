-- An accepted lyrics translation assigns its lyrics file with its own origin.
-- No other table references media_lyrics_assignment, so the rebuild needs no
-- foreign-key suspension.
CREATE TABLE media_lyrics_assignment_next (
  audio_media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT '' CHECK(language IN ('', 'ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  lyrics_media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual', 'remote_fetch', 'library_import', 'transcription', 'translation')),
  assigned_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(audio_media_item_id, language),
  CHECK(audio_media_item_id <> lyrics_media_item_id)
);

INSERT INTO media_lyrics_assignment_next (
  audio_media_item_id, language, lyrics_media_item_id, origin, assigned_by_user_id, updated_at
)
SELECT audio_media_item_id, language, lyrics_media_item_id, origin, assigned_by_user_id, updated_at
FROM media_lyrics_assignment;

DROP TABLE media_lyrics_assignment;

ALTER TABLE media_lyrics_assignment_next RENAME TO media_lyrics_assignment;

CREATE INDEX idx_fk_media_lyrics_assignment_lyrics_media_item_id
  ON media_lyrics_assignment(lyrics_media_item_id);
CREATE INDEX idx_fk_media_lyrics_assignment_assigned_by_user_id
  ON media_lyrics_assignment(assigned_by_user_id);
