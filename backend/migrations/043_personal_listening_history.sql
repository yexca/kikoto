-- Durable personal listening history is independent of recommendation retention.
CREATE TABLE user_listening_session (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  listened_seconds REAL NOT NULL DEFAULT 0 CHECK(listened_seconds BETWEEN 0 AND 86400),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, session_id)
);
CREATE INDEX idx_user_listening_session_work ON user_listening_session(work_id, user_id);
CREATE INDEX idx_user_listening_session_recent ON user_listening_session(user_id, updated_at DESC);

-- A clear invalidates every older request, including an unseen first report.
-- Only an account-scoped counter remains, with no session or work information.
CREATE TABLE user_listening_generation (
  user_id INTEGER PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0)
);

-- Per-work imported totals have no fabricated session or daily timing.
CREATE TABLE user_listening_import (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  listened_seconds REAL NOT NULL DEFAULT 0 CHECK(listened_seconds >= 0),
  listen_count INTEGER NOT NULL DEFAULT 0 CHECK(listen_count >= 0),
  last_played_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(user_id, work_id)
);
CREATE INDEX idx_user_listening_import_work ON user_listening_import(work_id, user_id);

CREATE TABLE user_listening_day (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  listened_seconds REAL NOT NULL DEFAULT 0 CHECK(listened_seconds >= 0),
  listen_count INTEGER NOT NULL DEFAULT 0 CHECK(listen_count >= 0),
  PRIMARY KEY(user_id, work_id, day)
);
CREATE INDEX idx_user_listening_day_recent ON user_listening_day(user_id, day);
CREATE INDEX idx_user_listening_day_work ON user_listening_day(work_id);

-- Existing play events establish history, but cannot establish listening duration.
INSERT INTO user_listening_session (user_id, session_id, work_id, created_at, updated_at)
SELECT event.user_id, 'legacy:' || event.id, COALESCE(logical.canonical_work_id,event.work_id), event.created_at, event.created_at
FROM recommendation_event event
LEFT JOIN work_edition edition ON edition.work_id=event.work_id
LEFT JOIN logical_work logical ON logical.id=edition.logical_work_id
WHERE event.event_type = 'play' AND event.work_id IS NOT NULL;

INSERT INTO user_listening_day (user_id, work_id, day, listen_count)
SELECT user_id, work_id, date(created_at), COUNT(*) FROM user_listening_session GROUP BY user_id, work_id, date(created_at);

INSERT INTO user_listening_import (user_id, work_id, last_played_at)
SELECT user_id, work_id, COALESCE(last_played_at, updated_at)
FROM user_work_playback_cursor;
