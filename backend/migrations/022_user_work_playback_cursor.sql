CREATE TABLE user_work_playback_cursor (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  file_source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  location_id INTEGER REFERENCES media_file_location(id) ON DELETE SET NULL,
  location_type TEXT NOT NULL DEFAULT '',
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, work_id)
);

CREATE INDEX idx_user_work_playback_cursor_recent
  ON user_work_playback_cursor(user_id, last_played_at DESC, work_id);

CREATE INDEX idx_user_work_playback_cursor_media
  ON user_work_playback_cursor(media_item_id, user_id);

WITH legacy_progress AS (
  SELECT
    progress.user_id,
    COALESCE(
      logical.canonical_work_id,
      (
        SELECT canonical_edition.work_id
        FROM work_edition AS canonical_edition
        WHERE canonical_edition.logical_work_id = edition.logical_work_id
          AND canonical_edition.is_canonical = 1
        ORDER BY canonical_edition.work_id ASC
        LIMIT 1
      ),
      item.work_id
    ) AS canonical_work_id,
    progress.media_item_id,
    progress.position_seconds,
    progress.duration_seconds,
    progress.completed,
    progress.last_played_at,
    progress.created_at,
    progress.updated_at
  FROM user_media_progress AS progress
  INNER JOIN media_item AS item ON item.id = progress.media_item_id
  LEFT JOIN work_edition AS edition ON edition.work_id = item.work_id
  LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
), ranked_progress AS (
  SELECT
    legacy_progress.*,
    ROW_NUMBER() OVER (
      PARTITION BY legacy_progress.user_id, legacy_progress.canonical_work_id
      ORDER BY
        COALESCE(legacy_progress.last_played_at, legacy_progress.updated_at, legacy_progress.created_at) DESC,
        legacy_progress.updated_at DESC,
        legacy_progress.media_item_id DESC
    ) AS progress_rank
  FROM legacy_progress
)
INSERT INTO user_work_playback_cursor (
  user_id,
  work_id,
  media_item_id,
  position_seconds,
  duration_seconds,
  completed,
  last_played_at,
  created_at,
  updated_at
)
SELECT
  user_id,
  canonical_work_id,
  media_item_id,
  position_seconds,
  duration_seconds,
  completed,
  last_played_at,
  created_at,
  updated_at
FROM ranked_progress
WHERE progress_rank = 1;
