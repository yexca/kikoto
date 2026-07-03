CREATE TABLE user_work_state (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  listening_status TEXT NOT NULL DEFAULT 'none' CHECK(listening_status IN ('none', 'want_to_listen', 'listening', 'finished', 'relisten', 'paused')),
  favorite INTEGER NOT NULL DEFAULT 0,
  rating INTEGER,
  note TEXT NOT NULL DEFAULT '',
  last_played_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, work_id)
);
