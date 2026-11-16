-- kikoto:foreign_keys=off
-- Record plays audio files, so a record asset may be audio. Audio files a scan
-- stored as other files become audio and are probed for their length.

CREATE TABLE record_asset_next (
  id INTEGER PRIMARY KEY,
  root_id INTEGER NOT NULL REFERENCES record_root(id) ON DELETE CASCADE,
  folder_id INTEGER NOT NULL REFERENCES record_folder(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  path_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('video', 'audio', 'image', 'subtitle', 'metadata', 'other')),
  extension TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER,
  mtime_ns INTEGER,
  content_hash TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'available'
    CHECK(availability IN ('available', 'missing', 'unreadable')),
  probe_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(probe_state IN ('pending', 'ready', 'failed')),
  duration_seconds REAL,
  width INTEGER,
  height INTEGER,
  video_codec TEXT NOT NULL DEFAULT '',
  audio_codec TEXT NOT NULL DEFAULT '',
  has_audio INTEGER,
  last_seen_generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(root_id, path_key)
);

INSERT INTO record_asset_next (
  id, root_id, folder_id, name, relative_path, path_key, kind, extension, mime_type, size_bytes, mtime_ns,
  content_hash, availability, probe_state, duration_seconds, width, height, video_codec, audio_codec, has_audio,
  last_seen_generation, created_at, updated_at
)
SELECT
  id, root_id, folder_id, name, relative_path, path_key,
  CASE WHEN kind = 'other' AND extension IN (
    '.mp3', '.m4a', '.flac', '.wav', '.wma', '.ogg', '.oga', '.opus', '.aac', '.aiff', '.aif', '.mka'
  ) THEN 'audio' ELSE kind END,
  extension, mime_type, size_bytes, mtime_ns, content_hash, availability,
  CASE WHEN kind = 'other' AND extension IN (
    '.mp3', '.m4a', '.flac', '.wav', '.wma', '.ogg', '.oga', '.opus', '.aac', '.aiff', '.aif', '.mka'
  ) THEN 'pending' ELSE probe_state END,
  duration_seconds, width, height, video_codec, audio_codec, has_audio,
  last_seen_generation, created_at, updated_at
FROM record_asset;

DROP TABLE record_asset;
ALTER TABLE record_asset_next RENAME TO record_asset;

CREATE INDEX idx_record_asset_folder
  ON record_asset(folder_id, availability, kind, name COLLATE NOCASE, id);

CREATE INDEX idx_record_asset_root_kind
  ON record_asset(root_id, kind, availability, name COLLATE NOCASE, id);
