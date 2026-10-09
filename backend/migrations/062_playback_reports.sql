-- Ordered resume checkpoints and cumulative listening by occurrence date.
ALTER TABLE user_work_playback_cursor ADD COLUMN report_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_work_playback_cursor ADD COLUMN report_id TEXT NOT NULL DEFAULT '';
ALTER TABLE user_listening_session ADD COLUMN dated_report INTEGER NOT NULL DEFAULT 0;
CREATE TABLE user_listening_session_day (
  user_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  day TEXT NOT NULL,
  listened_seconds REAL NOT NULL CHECK(listened_seconds >= 0),
  PRIMARY KEY(user_id, session_id, day),
  FOREIGN KEY(user_id, session_id) REFERENCES user_listening_session(user_id, session_id) ON DELETE CASCADE
);
