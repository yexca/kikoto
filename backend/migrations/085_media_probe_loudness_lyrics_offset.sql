-- The background media probe records the file version it could not read, so a
-- corrupt or non-media file is not probed again until it changes. A timeout or
-- a cancelled probe records nothing.
ALTER TABLE media_file_location ADD COLUMN probe_failed_version TEXT;

-- The integrated loudness and peak level of one file version, measured on
-- demand for loudness normalization. loudness_peak_kind says whether the peak
-- is a true peak or a sample peak. Values whose loudness_version differs from
-- file_version describe an earlier file and are never used.
ALTER TABLE media_file_location ADD COLUMN loudness_version TEXT;
ALTER TABLE media_file_location ADD COLUMN loudness_integrated_lufs REAL;
ALTER TABLE media_file_location ADD COLUMN loudness_peak_dbfs REAL;
ALTER TABLE media_file_location ADD COLUMN loudness_peak_kind TEXT
  CHECK(loudness_peak_kind IS NULL OR loudness_peak_kind IN ('true', 'sample'));

-- A listener's lyrics timing offset for one audio media item, in milliseconds.
-- A positive offset shows each line later. It is independent of the lyrics
-- choice, so it survives switching between automatic and chosen lyrics. Lyric
-- files are never rewritten.
CREATE TABLE user_media_lyrics_offset (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  audio_media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  offset_ms INTEGER NOT NULL CHECK(offset_ms BETWEEN -30000 AND 30000 AND offset_ms <> 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, audio_media_item_id)
) WITHOUT ROWID;

CREATE INDEX idx_fk_user_media_lyrics_offset_audio_media_item_id ON user_media_lyrics_offset(audio_media_item_id);
