-- File observations version the duration/audio metadata without changing media
-- identity, work ownership or personal playback state.
ALTER TABLE media_item ADD COLUMN file_version TEXT NOT NULL DEFAULT '';
ALTER TABLE media_file_location ADD COLUMN file_version TEXT NOT NULL DEFAULT '';
