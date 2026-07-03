CREATE TABLE user_media_progress (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  duration_seconds REAL,
  completed INTEGER NOT NULL DEFAULT 0,
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, media_item_id)
);
